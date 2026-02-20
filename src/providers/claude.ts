import {
  query as sdkQuery,
  unstable_v2_createSession as createSdkSession,
  unstable_v2_resumeSession as resumeSdkSession,
} from "@anthropic-ai/claude-agent-sdk";
import type { SDKSession, SDKSessionOptions } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, ClaudeSessionOptions, Usage } from "../types";
import type { ProviderSession } from "../provider";

// --- Event mapping (pure, exported for testing) ---

/**
 * Maps a single Claude SDK message to zero or more AgentEvents.
 * Uses `any` for the SDK message since SDKMessage's internal fields
 * aren't individually exported as typed interfaces.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function* mapSdkMessage(msg: any, includeRaw: boolean): Generator<AgentEvent> {
  if (includeRaw) {
    yield { type: "raw", provider: "claude", eventType: String(msg.type), data: msg };
  }

  switch (msg.type) {
    case "system":
      yield* mapSystemMessage(msg);
      break;
    case "stream_event":
      yield* mapStreamEvent(msg);
      break;
    case "assistant":
      yield* mapAssistantMessage(msg);
      break;
    case "result":
      yield* mapResultMessage(msg);
      break;
    case "tool_progress":
      yield {
        type: "tool_progress",
        toolUseId: String(msg.tool_use_id ?? ""),
        toolName: String(msg.tool_name ?? ""),
        elapsedSeconds: Number(msg.elapsed_time_seconds ?? 0),
      };
      break;
    case "tool_use_summary":
      yield {
        type: "tool_summary",
        summary: String(msg.summary ?? ""),
        precedingToolUseIds: Array.isArray(msg.preceding_tool_use_ids)
          ? msg.preceding_tool_use_ids
          : undefined,
      };
      break;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function* mapSystemMessage(msg: any): Generator<AgentEvent> {
  switch (msg.subtype) {
    case "init":
      yield {
        type: "session_init",
        sessionId: String(msg.session_id ?? ""),
        model: msg.model ? String(msg.model) : undefined,
        tools: Array.isArray(msg.tools) ? msg.tools : undefined,
        cwd: msg.cwd ? String(msg.cwd) : undefined,
      };
      break;
    case "status":
      yield { type: "status", message: msg.status ? String(msg.status) : "status update" };
      break;
    default:
      // hook_started, hook_progress, hook_response, task_notification
      yield { type: "status", message: `[${msg.subtype}] ${msg.summary ?? msg.message ?? ""}`.trim() };
      break;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function* mapStreamEvent(msg: any): Generator<AgentEvent> {
  const event = msg.event;
  if (!event) return;

  if (event.type === "content_block_delta") {
    const delta = event.delta;
    if (!delta) return;

    if (delta.type === "text_delta" && typeof delta.text === "string") {
      yield { type: "text_delta", text: delta.text };
    } else if (delta.type === "thinking_delta") {
      const text = typeof delta.thinking === "string" ? delta.thinking : String(delta.text ?? "");
      if (text) {
        yield { type: "thinking_delta", text };
      }
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function* mapAssistantMessage(msg: any): Generator<AgentEvent> {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    switch (block.type) {
      case "text":
        yield { type: "text_complete", text: String(block.text ?? "") };
        break;
      case "tool_use":
        yield {
          type: "tool_start",
          toolUseId: String(block.id ?? ""),
          toolName: String(block.name ?? ""),
          input: block.input,
        };
        break;
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function* mapResultMessage(msg: any): Generator<AgentEvent> {
  const usage: Usage = {
    inputTokens: Number(msg.usage?.input_tokens ?? 0),
    outputTokens: Number(msg.usage?.output_tokens ?? 0),
    cacheReadTokens: msg.usage?.cache_read_input_tokens != null
      ? Number(msg.usage.cache_read_input_tokens)
      : undefined,
    cacheCreationTokens: msg.usage?.cache_creation_input_tokens != null
      ? Number(msg.usage.cache_creation_input_tokens)
      : undefined,
  };

  yield {
    type: "session_complete",
    result: msg.result != null ? String(msg.result) : undefined,
    structuredOutput: msg.structured_output,
    usage,
    durationMs: Number(msg.duration_ms ?? 0),
    numTurns: Number(msg.num_turns ?? 0),
    costUsd: msg.total_cost_usd != null ? Number(msg.total_cost_usd) : undefined,
  };

  if (msg.subtype && msg.subtype !== "success") {
    const errors: string[] = Array.isArray(msg.errors) ? msg.errors : [];
    yield {
      type: "error",
      message: errors.length > 0 ? errors.join("; ") : `Session ended with: ${msg.subtype}`,
      code: String(msg.subtype),
      recoverable: false,
    };
  }
}

// --- V2 provider session (unstable session API) ---
// Used when all options are V2-compatible: cleaner send()/stream() lifecycle.

class ClaudeV2ProviderSession implements ProviderSession {
  private session: SDKSession | null = null;
  private _sessionId: string | null = null;

  constructor(private readonly options: ClaudeSessionOptions) {
    this._sessionId = options.resume ?? null;

    // Wire abort signal → close session (V2 has no native AbortController option)
    if (options.abortController) {
      options.abortController.signal.addEventListener("abort", () => {
        this.session?.close();
      }, { once: true });
    }
  }

  get sessionId() {
    return this._sessionId;
  }

  async *send(message: string): AsyncGenerator<AgentEvent> {
    if (!this.session) {
      const sdkOpts: SDKSessionOptions = {
        model: this.options.model,
        env: this.options.env,
        allowedTools: this.options.allowedTools,
        disallowedTools: this.options.disallowedTools,
        permissionMode: this.options.permissionMode,
        hooks: this.options.hooks as SDKSessionOptions["hooks"],
      };

      this.session = this._sessionId
        ? resumeSdkSession(this._sessionId, sdkOpts)
        : createSdkSession(sdkOpts);
    }

    await this.session.send(message);

    const includeRaw = this.options.includeRawEvents ?? false;

    for await (const msg of this.session.stream()) {
      if (msg.type === "system" && (msg as any).subtype === "init") {
        this._sessionId = (msg as any).session_id ?? null;
      }
      yield* mapSdkMessage(msg, includeRaw);
    }
  }

  abort() {
    this.session?.close();
  }

  close() {
    this.session?.close();
    this.session = null;
  }
}

// --- V1 provider session (query API) ---
// Fallback when options require fields V2 doesn't support yet
// (cwd, maxTurns, outputFormat, includePartialMessages, etc.)

class ClaudeV1ProviderSession implements ProviderSession {
  private _sessionId: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private currentQuery: any = null;
  private abortController: AbortController;

  constructor(private readonly options: ClaudeSessionOptions) {
    this.abortController = options.abortController ?? new AbortController();
  }

  get sessionId() {
    return this._sessionId;
  }

  async *send(message: string): AsyncGenerator<AgentEvent> {
    const sdkOptions = {
      model: this.options.model,
      abortController: this.abortController,
      includePartialMessages: this.options.includePartialMessages ?? true,
      cwd: this.options.cwd,
      env: this.options.env,
      maxTurns: this.options.maxTurns,
      permissionMode: this.options.permissionMode,
      allowDangerouslySkipPermissions: this.options.allowDangerouslySkipPermissions,
      allowedTools: this.options.allowedTools,
      disallowedTools: this.options.disallowedTools,
      maxBudgetUsd: this.options.maxBudgetUsd,
      maxThinkingTokens: this.options.maxThinkingTokens,
      outputFormat: this.options.outputFormat,
      mcpServers: this.options.mcpServers,
      agents: this.options.agents,
      hooks: this.options.hooks,
      resume: this._sessionId ?? this.options.resume,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = sdkQuery({ prompt: message, options: sdkOptions as any });
    this.currentQuery = stream;
    const includeRaw = this.options.includeRawEvents ?? false;

    try {
      for await (const msg of stream) {
        if (msg.type === "system" && (msg as any).subtype === "init") {
          this._sessionId = (msg as any).session_id ?? null;
        }
        yield* mapSdkMessage(msg, includeRaw);
      }
    } finally {
      this.currentQuery = null;
    }
  }

  abort() {
    this.abortController.abort();
  }

  close() {
    if (this.currentQuery) {
      this.currentQuery.close();
      this.currentQuery = null;
    }
  }
}

// --- Factory ---

/** Options not yet available in V2 SDKSessionOptions. */
const V1_ONLY_OPTIONS: (keyof ClaudeSessionOptions)[] = [
  "cwd",
  "maxTurns",
  "maxBudgetUsd",
  "maxThinkingTokens",
  "includePartialMessages",
  "outputFormat",
  "mcpServers",
  "agents",
  "allowDangerouslySkipPermissions",
];

function hasV1OnlyOptions(options: ClaudeSessionOptions): boolean {
  return V1_ONLY_OPTIONS.some((key) => options[key] != null);
}

export function createClaudeSession(options: ClaudeSessionOptions): ProviderSession {
  const version = options.sdkVersion;

  if (version === "v1") {
    return new ClaudeV1ProviderSession(options);
  }

  if (version === "v2") {
    return new ClaudeV2ProviderSession(options);
  }

  // Auto: prefer V2, fall back to V1 when V1-only options are present
  return hasV1OnlyOptions(options)
    ? new ClaudeV1ProviderSession(options)
    : new ClaudeV2ProviderSession(options);
}
