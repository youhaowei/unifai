import {
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentEvent,
  ClaudeSessionOptions,
  Usage,
  ModelUsage,
  ContentBlock,
  ModelInfo,
  InteractionHandlers,
  AgentQuestion,
} from "../types";
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
    case "auth_status":
      yield {
        type: "auth_status",
        isAuthenticating: Boolean(msg.isAuthenticating),
        output: Array.isArray(msg.output) ? msg.output : [],
        error: msg.error ? String(msg.error) : undefined,
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
        claudeCodeVersion: msg.claude_code_version ? String(msg.claude_code_version) : undefined,
        mcpServers: Array.isArray(msg.mcp_servers) ? msg.mcp_servers : undefined,
        permissionMode: msg.permissionMode ? String(msg.permissionMode) : undefined,
        slashCommands: Array.isArray(msg.slash_commands) ? msg.slash_commands : undefined,
        skills: Array.isArray(msg.skills) ? msg.skills : undefined,
      };
      break;
    case "status":
      yield {
        type: "status",
        message: msg.status ? String(msg.status) : "status update",
        permissionMode: msg.permissionMode ? String(msg.permissionMode) : undefined,
      };
      break;
    case "hook_started":
      yield {
        type: "hook_started",
        hookId: String(msg.hook_id ?? ""),
        hookName: String(msg.hook_name ?? ""),
        hookEvent: String(msg.hook_event ?? ""),
      };
      break;
    case "hook_progress":
      yield {
        type: "hook_progress",
        hookId: String(msg.hook_id ?? ""),
        hookName: String(msg.hook_name ?? ""),
        hookEvent: String(msg.hook_event ?? ""),
        stdout: String(msg.stdout ?? ""),
        stderr: String(msg.stderr ?? ""),
        output: String(msg.output ?? ""),
      };
      break;
    case "hook_response":
      yield {
        type: "hook_response",
        hookId: String(msg.hook_id ?? ""),
        hookName: String(msg.hook_name ?? ""),
        hookEvent: String(msg.hook_event ?? ""),
        outcome: String(msg.outcome ?? ""),
        output: String(msg.output ?? ""),
        exitCode: msg.exit_code != null ? Number(msg.exit_code) : undefined,
      };
      break;
    case "task_notification":
      yield {
        type: "task_notification",
        taskId: String(msg.task_id ?? ""),
        status: String(msg.status ?? ""),
        outputFile: String(msg.output_file ?? ""),
        summary: String(msg.summary ?? ""),
      };
      break;
    default:
      yield { type: "status", message: `[${msg.subtype}] ${msg.summary ?? msg.message ?? ""}`.trim() };
      break;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function* mapStreamEvent(msg: any): Generator<AgentEvent> {
  const event = msg.event;
  if (!event) return;

  switch (event.type) {
    case "message_start": {
      const m = event.message;
      if (m) {
        yield {
          type: "message_start",
          messageId: String(m.id ?? ""),
          model: String(m.model ?? ""),
          stopReason: m.stop_reason ?? null,
          usage: extractUsage(m.usage),
        };
      }
      break;
    }
    case "message_stop":
      yield { type: "message_stop" };
      break;
    case "content_block_start": {
      const block = event.content_block;
      if (block) {
        yield {
          type: "content_block_start",
          index: Number(event.index ?? 0),
          blockType: block.type as "text" | "tool_use" | "thinking",
          id: "id" in block ? String(block.id) : undefined,
          name: "name" in block ? String(block.name) : undefined,
        };
      }
      break;
    }
    case "content_block_stop":
      yield { type: "content_block_stop", index: Number(event.index ?? 0) };
      break;
    case "content_block_delta": {
      const delta = event.delta;
      if (!delta) return;

      if (delta.type === "text_delta" && typeof delta.text === "string") {
        yield { type: "text_delta", text: delta.text };
      } else if (delta.type === "thinking_delta") {
        const text = typeof delta.thinking === "string" ? delta.thinking : String(delta.text ?? "");
        if (text) {
          yield { type: "thinking_delta", text, index: event.index != null ? Number(event.index) : undefined };
        }
      }
      break;
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function* mapAssistantMessage(msg: any): Generator<AgentEvent> {
  const m = msg.message;
  if (!m) return;
  const contentArr = m.content;
  if (!Array.isArray(contentArr)) return;

  // Emit full assistant_message event
  const content: ContentBlock[] = contentArr.map((block: { type: string; text?: string; id?: string; name?: string; input?: unknown; thinking?: string }) => {
    if (block.type === "text") return { type: "text" as const, text: block.text };
    if (block.type === "tool_use") return { type: "tool_use" as const, id: block.id, name: block.name, input: block.input };
    if (block.type === "thinking") return { type: "thinking" as const, thinking: block.thinking };
    return { type: block.type as "text" };
  });

  yield {
    type: "assistant_message",
    messageId: String(m.id ?? ""),
    uuid: msg.uuid ? String(msg.uuid) : undefined,
    sessionId: String(msg.session_id ?? ""),
    model: String(m.model ?? ""),
    stopReason: m.stop_reason ?? null,
    usage: extractUsage(m.usage),
    content,
    error: msg.error ? String(msg.error) : undefined,
  };

  // Also emit individual text_complete / tool_start events
  for (const block of contentArr) {
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
  const usage = extractUsage(msg.usage);

  // Extract per-model usage breakdown
  let modelUsage: Record<string, ModelUsage> | undefined;
  if (msg.modelUsage && typeof msg.modelUsage === "object") {
    modelUsage = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const [model, mu] of Object.entries(msg.modelUsage) as [string, any][]) {
      modelUsage[model] = {
        inputTokens: Number(mu.inputTokens ?? 0),
        outputTokens: Number(mu.outputTokens ?? 0),
        cacheReadTokens: Number(mu.cacheReadInputTokens ?? 0),
        cacheCreationTokens: Number(mu.cacheCreationInputTokens ?? 0),
        webSearchRequests: mu.webSearchRequests != null ? Number(mu.webSearchRequests) : undefined,
        costUsd: mu.costUSD != null ? Number(mu.costUSD) : undefined,
        contextWindow: mu.contextWindow != null ? Number(mu.contextWindow) : undefined,
        maxOutputTokens: mu.maxOutputTokens != null ? Number(mu.maxOutputTokens) : undefined,
      };
    }
  }

  yield {
    type: "session_complete",
    subtype: msg.subtype ? String(msg.subtype) : undefined,
    result: msg.result != null ? String(msg.result) : undefined,
    structuredOutput: msg.structured_output,
    usage,
    durationMs: Number(msg.duration_ms ?? 0),
    durationApiMs: msg.duration_api_ms != null ? Number(msg.duration_api_ms) : undefined,
    numTurns: Number(msg.num_turns ?? 0),
    costUsd: msg.total_cost_usd != null ? Number(msg.total_cost_usd) : undefined,
    modelUsage,
    errors: Array.isArray(msg.errors) ? msg.errors : undefined,
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

// --- Shared helpers ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractUsage(raw: any): Usage {
  return {
    inputTokens: Number(raw?.input_tokens ?? 0),
    outputTokens: Number(raw?.output_tokens ?? 0),
    cacheReadTokens: raw?.cache_read_input_tokens != null
      ? Number(raw.cache_read_input_tokens)
      : undefined,
    cacheCreationTokens: raw?.cache_creation_input_tokens != null
      ? Number(raw.cache_creation_input_tokens)
      : undefined,
  };
}

// --- Interaction callback bridge ---

let nextInteractionId = 1;

function buildCanUseTool(
  handlers: InteractionHandlers,
  emitEvent: (event: AgentEvent) => void,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): ((toolName: string, input: any) => Promise<any>) | undefined {
  if (!handlers.onApprovalRequest && !handlers.onAgentQuestion) return undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (toolName: string, input: any) => {
    // Handle AskUserQuestion → onAgentQuestion
    if (toolName === "AskUserQuestion" && handlers.onAgentQuestion) {
      const questions: AgentQuestion[] = Array.isArray(input?.questions)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? input.questions.map((q: any, i: number) => ({
            id: q.id ?? `q_${i}`,
            header: q.header ?? "",
            question: typeof q === "string" ? q : (q.question ?? q.text ?? ""),
            freeform: true,
            secret: false,
            multiSelect: q.multiSelect ?? false,
            options: Array.isArray(q.options)
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ? q.options.map((o: any) => ({
                  label: typeof o === "string" ? o : (o.label ?? o.value ?? ""),
                  description: typeof o === "string" ? "" : (o.description ?? ""),
                }))
              : undefined,
          }))
        : [];

      const requestId = `claude_input_${nextInteractionId++}`;
      emitEvent({ type: "agent_question", id: requestId, questions });

      const response = await handlers.onAgentQuestion({ id: requestId, questions });
      emitEvent({ type: "agent_question_response", id: requestId, answers: response.answers });

      // Map back to Claude format: answers keyed by question text
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const claudeAnswers: Record<string, string> = {};
      for (const [qId, answers] of Object.entries(response.answers)) {
        // Find the original question to use its text as key
        const question = questions.find((q) => q.id === qId);
        const key = question?.question ?? qId;
        claudeAnswers[key] = answers[0] ?? "";
      }

      return {
        behavior: "allow",
        updatedInput: { ...input, answers: claudeAnswers },
      };
    }

    // Handle tool approval → onApprovalRequest
    if (handlers.onApprovalRequest) {
      const approvalId = `claude_approval_${nextInteractionId++}`;
      const request = {
        id: approvalId,
        kind: "command" as const,
        description: `Tool: ${toolName}`,
        detail: input,
      };

      emitEvent({ type: "approval_request", ...request });

      const decision = await handlers.onApprovalRequest(request);
      emitEvent({ type: "approval_response", id: approvalId, decision });

      if (decision === "approve" || decision === "approve_session") {
        return { behavior: "allow", updatedInput: input };
      }
      return { behavior: "deny", message: "User rejected" };
    }

    // No relevant handler — allow by default (SDK's own permissionMode governs)
    return { behavior: "allow", updatedInput: input };
  };
}

// --- Provider session (query API) ---

class ClaudeV1ProviderSession implements ProviderSession {
  private _sessionId: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private currentQuery: any = null;
  private abortController: AbortController;
  private handlers: InteractionHandlers;

  constructor(private readonly options: ClaudeSessionOptions) {
    this.abortController = options.abortController ?? new AbortController();
    this.handlers = options.interaction ?? {};
  }

  get sessionId() {
    return this._sessionId;
  }

  async *send(message: string): AsyncGenerator<AgentEvent> {
    // Buffer for interaction events that arrive via canUseTool callback
    const pendingEvents: AgentEvent[] = [];
    const canUseTool = buildCanUseTool(this.handlers, (event) => {
      pendingEvents.push(event);
    });

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
      pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable,
      resume: this._sessionId ?? this.options.resume,
      ...(canUseTool && { canUseTool }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = sdkQuery({ prompt: message, options: sdkOptions as any });
    this.currentQuery = stream;
    const includeRaw = this.options.includeRawEvents ?? false;

    // Track tools that have been started but not yet completed.
    // Claude SDK doesn't emit individual tool_result events — we synthesize them
    // when the next message_start arrives (new API turn = previous tools completed).
    const pendingTools = new Map<string, string>(); // toolUseId → toolName

    // Track whether text was streamed via text_delta for the current turn.
    // When extended thinking is enabled or for certain final turns, stream_event
    // messages may not be emitted — text only arrives in the assistant_message.
    // We backfill text_delta events in that case so consumers receive all text.
    let streamedTextThisTurn = false;

    try {
      for await (const msg of stream) {
        // Flush any interaction events that were buffered during canUseTool
        while (pendingEvents.length > 0) {
          yield pendingEvents.shift()!;
        }

        if (msg.type === "system" && msg.subtype === "init") {
          this._sessionId = msg.session_id ?? null;
        }

        // Extract real tool_result events from SDK "user" messages.
        // After the SDK executes tools, it emits a "user" message containing
        // tool_result content blocks with the actual output (file contents,
        // match counts, exit codes, etc.). This gives us per-tool completion
        // signals with real result data.
        if (msg.type === "user") {
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result" && block.tool_use_id) {
                const toolUseId = String(block.tool_use_id);
                const toolName = pendingTools.get(toolUseId) ?? "";
                pendingTools.delete(toolUseId);
                yield {
                  type: "tool_result",
                  toolUseId,
                  toolName,
                  result: block.content,
                  isError: !!block.is_error,
                };
              }
            }
          }
        }

        // Fallback: synthesize tool_result at turn boundaries for any tools
        // that weren't resolved by a "user" message (e.g. older SDK versions).
        if (msg.type === "stream_event" && msg.event.type === "message_start" && pendingTools.size > 0) {
          for (const [toolUseId, toolName] of pendingTools) {
            yield { type: "tool_result", toolUseId, toolName, result: undefined, isError: false };
          }
          pendingTools.clear();
        }

        for (const event of mapSdkMessage(msg, includeRaw)) {
          // Reset per-turn text tracking on new message
          if (event.type === "message_start") {
            streamedTextThisTurn = false;
          }
          if (event.type === "text_delta") {
            streamedTextThisTurn = true;
          }

          // Backfill text as text_delta when it wasn't streamed for this turn.
          // This happens when stream_event messages are suppressed (e.g. extended thinking).
          if (event.type === "assistant_message" && !streamedTextThisTurn) {
            for (const block of event.content) {
              if (block.type === "text" && block.text) {
                yield { type: "content_block_start", index: 0, blockType: "text" as const };
                yield { type: "text_delta", text: block.text };
                yield { type: "content_block_stop", index: 0 };
              }
            }
          }

          // Track tools from both tool_start (top-level assistant messages) and
          // content_block_start (nested subagent tools that only appear in stream events)
          if (event.type === "tool_start") {
            pendingTools.set(event.toolUseId, event.toolName);
          } else if (event.type === "content_block_start" && event.blockType === "tool_use" && event.id && event.name) {
            pendingTools.set(event.id, event.name);
          } else if (event.type === "tool_result") {
            pendingTools.delete(event.toolUseId);
          }
          yield event;
        }
      }

      // Complete any remaining tools at stream end
      for (const [toolUseId, toolName] of pendingTools) {
        yield { type: "tool_result", toolUseId, toolName, result: undefined, isError: false };
      }

      // Flush remaining interaction events
      while (pendingEvents.length > 0) {
        yield pendingEvents.shift()!;
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

export function createClaudeSession(options: ClaudeSessionOptions): ProviderSession {
  return new ClaudeV1ProviderSession(options);
}

// --- Model discovery ---

export async function getClaudeSupportedModels(
  options?: { env?: Record<string, string | undefined>; cwd?: string },
): Promise<ModelInfo[]> {
  const abortController = new AbortController();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const queryHandle = sdkQuery({
    prompt: "List available models.",
    options: {
      abortController,
      cwd: options?.cwd ?? process.cwd(),
      env: options?.env,
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  try {
    const models = await queryHandle.supportedModels();
    return models.map((m: { value: string; displayName: string; description?: string }) => ({
      id: m.value,
      displayName: m.displayName,
      description: m.description ?? "",
    }));
  } finally {
    abortController.abort();
  }
}
