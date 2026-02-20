import { Codex } from "@openai/codex-sdk";
import type { Thread, ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import type { AgentEvent, CodexSessionOptions, Usage } from "../types";
import type { ProviderSession } from "../provider";

// --- Event mapping (pure, exported for testing) ---

export function* mapThreadEvent(event: ThreadEvent, includeRaw: boolean): Generator<AgentEvent> {
  if (includeRaw) {
    yield { type: "raw", provider: "codex", eventType: event.type, data: event };
  }

  switch (event.type) {
    case "thread.started":
      yield {
        type: "session_init",
        sessionId: (event as { thread_id: string }).thread_id,
      };
      break;

    case "item.started":
      yield* mapItemStarted((event as { item: ThreadItem }).item);
      break;

    case "item.completed":
      yield* mapItemCompleted((event as { item: ThreadItem }).item);
      break;

    case "turn.completed": {
      const raw = event as { usage?: { input_tokens: number; output_tokens: number; cached_input_tokens: number } };
      const usage: Usage | undefined = raw.usage
        ? {
            inputTokens: raw.usage.input_tokens,
            outputTokens: raw.usage.output_tokens,
            cacheReadTokens: raw.usage.cached_input_tokens != null ? raw.usage.cached_input_tokens : undefined,
          }
        : undefined;
      yield { type: "turn_complete", usage };
      break;
    }

    case "turn.failed": {
      const err = (event as { error?: { message: string } }).error;
      yield {
        type: "error",
        message: err?.message ?? "Turn failed",
        code: "TURN_FAILED",
        recoverable: false,
      };
      break;
    }

    case "error":
      yield {
        type: "error",
        message: (event as { message: string }).message,
        code: "THREAD_ERROR",
        recoverable: false,
      };
      break;
  }
}

function* mapItemStarted(item: ThreadItem): Generator<AgentEvent> {
  switch (item.type) {
    case "command_execution":
      yield {
        type: "tool_start",
        toolUseId: item.id,
        toolName: "Bash",
        input: item.command,
      };
      break;

    case "file_change":
      yield {
        type: "tool_start",
        toolUseId: item.id,
        toolName: "Edit",
        input: item.changes,
      };
      break;

    case "mcp_tool_call":
      yield {
        type: "tool_start",
        toolUseId: item.id,
        toolName: `mcp__${item.server}__${item.tool}`,
        input: item.arguments,
      };
      break;
  }
}

function* mapItemCompleted(item: ThreadItem): Generator<AgentEvent> {
  switch (item.type) {
    case "agent_message":
      yield {
        type: "text_complete",
        text: item.text,
      };
      break;

    case "reasoning":
      yield {
        type: "thinking_delta",
        text: item.text,
      };
      break;

    case "command_execution":
      yield {
        type: "tool_result",
        toolUseId: item.id,
        toolName: "Bash",
        result: item.aggregated_output,
        isError: item.status === "failed",
      };
      break;

    case "file_change":
      yield {
        type: "tool_result",
        toolUseId: item.id,
        toolName: "Edit",
        result: item.changes,
        isError: item.status === "failed",
      };
      break;

    case "mcp_tool_call":
      yield {
        type: "tool_result",
        toolUseId: item.id,
        toolName: `mcp__${item.server}__${item.tool}`,
        result: item.result ?? item.error,
        isError: item.status === "failed",
      };
      break;

    case "error":
      yield {
        type: "error",
        message: item.message,
        code: "ITEM_ERROR",
        recoverable: false,
      };
      break;
  }
}

// --- Provider session ---

class CodexProviderSession implements ProviderSession {
  private _sessionId: string | null = null;
  private codex: Codex;
  private thread: Thread | null = null;
  private abortController: AbortController;

  constructor(private readonly options: CodexSessionOptions) {
    this.abortController = options.abortController ?? new AbortController();
    this.codex = new Codex({
      apiKey: options.apiKey,
    });
  }

  get sessionId() {
    return this._sessionId;
  }

  async *send(message: string): AsyncGenerator<AgentEvent> {
    if (!this.thread) {
      const threadOpts = {
        model: this.options.model,
        workingDirectory: this.options.cwd,
        sandboxMode: this.options.sandboxMode,
        modelReasoningEffort: this.options.reasoningEffort,
      };

      this.thread = this.options.resume
        ? this.codex.resumeThread(this.options.resume, threadOpts)
        : this.codex.startThread(threadOpts);
    }

    const { events } = await this.thread.runStreamed(message, {
      signal: this.abortController.signal,
    });

    const includeRaw = this.options.includeRawEvents ?? false;
    const startTime = Date.now();
    let accUsage: Usage = { inputTokens: 0, outputTokens: 0 };
    let numTurns = 0;

    for await (const event of events) {
      if (event.type === "thread.started") {
        this._sessionId = (event as { thread_id: string }).thread_id;
      }
      // Accumulate usage from turn events for the synthesized session_complete
      if (event.type === "turn.completed") {
        numTurns++;
        const raw = event as { usage?: { input_tokens: number; output_tokens: number; cached_input_tokens: number } };
        if (raw.usage) {
          accUsage = {
            inputTokens: accUsage.inputTokens + raw.usage.input_tokens,
            outputTokens: accUsage.outputTokens + raw.usage.output_tokens,
            cacheReadTokens: raw.usage.cached_input_tokens
              ? (accUsage.cacheReadTokens ?? 0) + raw.usage.cached_input_tokens
              : accUsage.cacheReadTokens,
          };
        }
      }
      yield* mapThreadEvent(event, includeRaw);
    }

    // Synthesize session_complete — Codex SDK has no equivalent to Claude's result message
    yield {
      type: "session_complete",
      usage: accUsage,
      durationMs: Date.now() - startTime,
      numTurns,
    };
  }

  abort() {
    this.abortController.abort();
  }

  close() {
    // Codex threads are automatically persisted; no explicit cleanup needed
  }
}

export function createCodexSession(options: CodexSessionOptions): ProviderSession {
  return new CodexProviderSession(options);
}
