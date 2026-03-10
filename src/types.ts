// --- Interaction types (unified across providers) ---

export interface ApprovalRequest {
  id: string;
  kind: "command" | "file_change";
  description: string;
  detail: unknown;
  availableDecisions?: string[];
}

export type ApprovalDecision = "approve" | "approve_session" | "deny" | "cancel";

export interface AgentQuestion {
  id: string;
  header: string;
  question: string;
  /** If true, free-form text answer is allowed */
  freeform: boolean;
  /** If true, input should be masked (password) */
  secret: boolean;
  /** If true, multiple options can be selected */
  multiSelect?: boolean;
  options?: Array<{ label: string; description: string }>;
}

export interface AgentQuestionRequest {
  id: string;
  questions: AgentQuestion[];
}

export interface AgentQuestionResponse {
  answers: Record<string, string[]>;
}

export interface InteractionHandlers {
  /** Called when the agent needs approval before executing a command or file change */
  onApprovalRequest?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  /** Called when the agent asks the user a question */
  onAgentQuestion?: (request: AgentQuestionRequest) => Promise<AgentQuestionResponse>;
}

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

// --- Interaction events (observable, emitted alongside callback handling) ---

export interface ApprovalRequestEvent {
  type: "approval_request";
  id: string;
  kind: "command" | "file_change";
  description: string;
  detail: unknown;
}

export interface ApprovalResponseEvent {
  type: "approval_response";
  id: string;
  decision: ApprovalDecision;
}

export interface AgentQuestionEvent {
  type: "agent_question";
  id: string;
  questions: AgentQuestion[];
}

export interface AgentQuestionResponseEvent {
  type: "agent_question_response";
  id: string;
  answers: Record<string, string[]>;
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
  | TaskNotificationEvent
  // Interaction events
  | ApprovalRequestEvent
  | ApprovalResponseEvent
  | AgentQuestionEvent
  | AgentQuestionResponseEvent;

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
  interaction?: InteractionHandlers;
}

export interface ClaudeSessionOptions extends BaseSessionOptions {
  pathToClaudeCodeExecutable?: string;
  resume?: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
  allowDangerouslySkipPermissions?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxBudgetUsd?: number;
  maxThinkingTokens?: number;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  mcpServers?: Record<string, unknown>;
  agents?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  includePartialMessages?: boolean;
}

export interface CodexSessionOptions extends BaseSessionOptions {
  apiKey?: string;
  resume?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  instructions?: string;
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
