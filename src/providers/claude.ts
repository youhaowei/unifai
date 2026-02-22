import {
  query as sdkQuery,
  unstable_v2_createSession as createSdkSession,
  unstable_v2_resumeSession as resumeSdkSession,
} from "@anthropic-ai/claude-agent-sdk";
import type { SDKSession, SDKSessionOptions } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, ClaudeSessionOptions, Usage, ModelUsage, ContentBlock, ModelInfo } from "../types";
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
