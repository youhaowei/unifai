// --- Agent Events (discriminated union on `type`) ---

export interface SessionInitEvent {
  type: "session_init";
  sessionId: string;
  model?: string;
  tools?: string[];
  cwd?: string;
  /** Claude-specific: Claude Code version string */
  claudeCodeVersion?: string;
  /** Claude-specific: connected MCP servers */
  mcpServers?: Array<{ name: string; status: string }>;
  /** Claude-specific: active permission mode */
  permissionMode?: string;
  /** Claude-specific: available slash commands */
  slashCommands?: string[];
  /** Claude-specific: available skills */
  skills?: string[];
}

export interface TextDeltaEvent {
  type: "text_delta";
  text: string;
}

export interface ThinkingDeltaEvent {
  type: "thinking_delta";
  text: string;
  /** Content block index (Claude-specific) */
  index?: number;
}

export interface TextCompleteEvent {
  type: "text_complete";
  text: string;
  isIntermediate?: boolean;
}

export interface ToolStartEvent {
  type: "tool_start";
  toolUseId: string;
  toolName: string;
  input: unknown;
}

export interface ToolProgressEvent {
  type: "tool_progress";
  toolUseId: string;
  toolName: string;
  elapsedSeconds: number;
}

export interface ToolResultEvent {
  type: "tool_result";
  toolUseId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

export interface ToolSummaryEvent {
  type: "tool_summary";
  summary: string;
  precedingToolUseIds?: string[];
}

export interface TurnCompleteEvent {
  type: "turn_complete";
  usage?: Usage;
}

export interface SessionCompleteEvent {
  type: "session_complete";
  subtype?: string;
  result?: string;
  structuredOutput?: unknown;
  usage: Usage;
  durationMs: number;
  durationApiMs?: number;
  numTurns: number;
  costUsd?: number;
  modelUsage?: Record<string, ModelUsage>;
  errors?: string[];
}

export interface StatusEvent {
  type: "status";
  message: string;
  /** Claude-specific: active permission mode (from system/status events) */
  permissionMode?: string;
}

export interface ErrorEvent {
  type: "error";
  message: string;
  code?: string;
  recoverable: boolean;
}

export interface RawEvent {
  type: "raw";
  provider: ProviderKind;
  eventType: string;
  data: unknown;
}

// --- Message lifecycle events (Claude stream_event subtypes) ---

export interface MessageStartEvent {
  type: "message_start";
  messageId: string;
  model: string;
  stopReason: string | null;
  usage: Usage;
}

export interface MessageStopEvent {
  type: "message_stop";
}

// --- Content block lifecycle events (Claude stream_event subtypes) ---

export interface ContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  blockType: "text" | "tool_use" | "thinking";
  id?: string;
  name?: string;
}

export interface ContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

// --- Full assistant message (Claude 'assistant' message type) ---

export interface AssistantMessageEvent {
  type: "assistant_message";
  messageId: string;
  uuid?: string;
  sessionId: string;
  model: string;
  stopReason: string | null;
  usage: Usage;
  content: ContentBlock[];
  error?: string;
}

export interface ContentBlock {
  type: "text" | "tool_use" | "thinking";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
}

// --- Auth events (Claude-specific) ---

export interface AuthStatusEvent {
  type: "auth_status";
  isAuthenticating: boolean;
  output: string[];
  error?: string;
}

// --- Hook lifecycle events (Claude-specific) ---

export interface HookStartedEvent {
  type: "hook_started";
  hookId: string;
  hookName: string;
  hookEvent: string;
}

export interface HookProgressEvent {
  type: "hook_progress";
  hookId: string;
  hookName: string;
  hookEvent: string;
  stdout: string;
  stderr: string;
  output: string;
}

export interface HookResponseEvent {
  type: "hook_response";
  hookId: string;
  hookName: string;
  hookEvent: string;
  outcome: string;
  output: string;
  exitCode?: number;
}

// --- Task notification events (Claude-specific) ---

export interface TaskNotificationEvent {
  type: "task_notification";
  taskId: string;
  status: string;
  outputFile: string;
  summary: string;
}

// --- Discriminated union ---

export type AgentEvent =
  | SessionInitEvent
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | TextCompleteEvent
  | ToolStartEvent
  | ToolProgressEvent
  | ToolResultEvent
  | ToolSummaryEvent
  | TurnCompleteEvent
  | SessionCompleteEvent
  | StatusEvent
  | ErrorEvent
  | RawEvent
  // Message lifecycle
  | MessageStartEvent
  | MessageStopEvent
  // Content block lifecycle
  | ContentBlockStartEvent
  | ContentBlockStopEvent
  // Full assistant message
  | AssistantMessageEvent
  // Auth
  | AuthStatusEvent
  // Hook lifecycle
  | HookStartedEvent
  | HookProgressEvent
  | HookResponseEvent
  // Task notification
  | TaskNotificationEvent;

// --- Provider kinds ---

export type ProviderKind = "claude" | "codex";

// --- Session options ---

export interface BaseSessionOptions {
  model: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  maxTurns?: number;
  abortController?: AbortController;
  includeRawEvents?: boolean;
}

export interface ClaudeSessionOptions extends BaseSessionOptions {
  /**
   * Which Claude SDK backend to use.
   *
   * - `"v2"` — Persistent session via `unstable_v2_createSession`. One live process
   *   across multiple `send()` calls — efficient for multi-turn orchestration.
   *   Supports: `model`, `env`, `allowedTools`, `disallowedTools`, `permissionMode`, `hooks`.
   *
   * - `"v1"` — One-shot `query()` per `send()`, resumed via session ID. Heavier per
   *   turn but supports all options including `cwd`, `maxTurns`, `outputFormat`,
   *   `includePartialMessages`, `maxBudgetUsd`, `maxThinkingTokens`, `mcpServers`, `agents`.
   *
   * - `undefined` (default) — Auto-selects V2 when all options are V2-compatible,
   *   falls back to V1 otherwise.
   */
  sdkVersion?: "v1" | "v2";
  resume?: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
  allowDangerouslySkipPermissions?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** V1 only. Ignored when sdkVersion is "v2". */
  maxBudgetUsd?: number;
  /** V1 only. Ignored when sdkVersion is "v2". */
  maxThinkingTokens?: number;
  /** V1 only. Ignored when sdkVersion is "v2". */
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  /** V1 only. Ignored when sdkVersion is "v2". */
  mcpServers?: Record<string, unknown>;
  /** V1 only. Ignored when sdkVersion is "v2". */
  agents?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  /** V1 only. Ignored when sdkVersion is "v2". */
  includePartialMessages?: boolean;
}

export interface CodexSessionOptions extends BaseSessionOptions {
  apiKey?: string;
  resume?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
}

export type SessionOptions = ClaudeSessionOptions | CodexSessionOptions;

// --- Supporting types ---

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  webSearchRequests?: number;
  costUsd?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface SessionResult {
  text: string;
  structuredOutput?: unknown;
  usage: Usage;
  durationMs: number;
  numTurns: number;
  costUsd?: number;
}

// --- Model discovery ---

export interface ModelInfo {
  id: string;
  displayName: string;
  description: string;
}

// --- Session interface (public contract) ---

export interface UnifaiSession {
  readonly provider: ProviderKind;
  readonly sessionId: string | null;
  readonly isActive: boolean;
  send(message: string): AsyncGenerator<AgentEvent>;
  abort(): void;
  close(): void;
  [Symbol.asyncDispose](): Promise<void>;
}
