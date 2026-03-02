import { CodexAppServer } from "./codex-jsonrpc";
import type {
  AgentEvent,
  ApprovalDecision,
  CodexSessionOptions,
  InteractionHandlers,
  Usage,
} from "../types";
import type { ProviderSession } from "../provider";

// --- App-server type subsets (from codex-app-server-protocol) ---

interface ThreadInfo {
  id: string;
  [key: string]: unknown;
}

interface TurnInfo {
  id: string;
  [key: string]: unknown;
}

interface ThreadItem {
  type: string;
  id: string;
  [key: string]: unknown;
}

// --- Approval decision mapping ---

function mapDecisionToCodex(
  decision: ApprovalDecision,
): "accept" | "acceptForSession" | "decline" | "cancel" {
  switch (decision) {
    case "approve":
      return "accept";
    case "approve_session":
      return "acceptForSession";
    case "deny":
      return "decline";
    case "cancel":
      return "cancel";
  }
}

// --- Event mapping (pure, exported for testing) ---

export function* mapItemStarted(item: ThreadItem): Generator<AgentEvent> {
  switch (item.type) {
    case "commandExecution":
      yield {
        type: "tool_start",
        toolUseId: item.id,
        toolName: "Bash",
        input: item.command ?? "",
      };
      break;

    case "fileChange":
      yield {
        type: "tool_start",
        toolUseId: item.id,
        toolName: "Edit",
        input: item.changes,
      };
      break;

    case "mcpToolCall":
      yield {
        type: "tool_start",
        toolUseId: item.id,
        toolName: `mcp__${item.server}__${item.tool}`,
        input: item.arguments,
      };
      break;

    case "dynamicToolCall":
      yield {
        type: "tool_start",
        toolUseId: item.id,
        toolName: String(item.tool ?? "dynamic_tool"),
        input: item.arguments,
      };
      break;
  }
}

export function* mapItemCompleted(item: ThreadItem): Generator<AgentEvent> {
  switch (item.type) {
    case "agentMessage":
      yield {
        type: "text_complete",
        text: String(item.text ?? ""),
      };
      break;

    case "reasoning":
      yield {
        type: "thinking_delta",
        text: Array.isArray(item.summary) ? item.summary.join("\n") : String(item.text ?? ""),
      };
      break;

    case "commandExecution":
      yield {
        type: "tool_result",
        toolUseId: item.id,
        toolName: "Bash",
        result: item.aggregatedOutput ?? "",
        isError: item.status === "failed",
      };
      break;

    case "fileChange":
      yield {
        type: "tool_result",
        toolUseId: item.id,
        toolName: "Edit",
        result: item.changes,
        isError: item.status === "failed",
      };
      break;

    case "mcpToolCall":
      yield {
        type: "tool_result",
        toolUseId: item.id,
        toolName: `mcp__${item.server}__${item.tool}`,
        result: item.result ?? item.error,
        isError: item.status === "failed",
      };
      break;

    case "dynamicToolCall":
      yield {
        type: "tool_result",
        toolUseId: item.id,
        toolName: String(item.tool ?? "dynamic_tool"),
        result: item.contentItems,
        isError: item.success === false,
      };
      break;

    case "error":
      yield {
        type: "error",
        message: String((item as { message?: string }).message ?? "Unknown error"),
        code: "ITEM_ERROR",
        recoverable: false,
      };
      break;
  }
}

// --- Provider session ---

class CodexProviderSession implements ProviderSession {
  private _sessionId: string | null = null;
  private server: CodexAppServer;
  private threadId: string | null = null;
  private abortController: AbortController;
  private handlers: InteractionHandlers;
  private abortTurn: (() => void) | null = null;

  constructor(private readonly options: CodexSessionOptions) {
    this.abortController = options.abortController ?? new AbortController();
    this.server = CodexAppServer.acquire();
    this.handlers = options.interaction ?? {};
  }

  get sessionId() {
    return this._sessionId;
  }

  async *send(message: string): AsyncGenerator<AgentEvent> {
    await this.server.ensureRunning();

    // Start or reuse a thread
    if (!this.threadId) {
      yield* this.initThread();
    }

    // Start a turn
    const turnResponse = (await this.server.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: message, text_elements: [] }],
      ...(this.options.model && { model: this.options.model }),
      ...(this.options.reasoningEffort && { effort: this.options.reasoningEffort }),
    })) as { turn: TurnInfo };

    const turnId = turnResponse.turn.id;

    // Stream events until turn completes
    yield* this.streamTurn(turnId);
  }

  private async *initThread(): AsyncGenerator<AgentEvent> {
    const sandboxMap: Record<string, string> = {
      "read-only": "readOnly",
      "workspace-write": "workspaceWrite",
      "danger-full-access": "dangerFullAccess",
    };

    if (this.options.resume) {
      const response = (await this.server.request("thread/resume", {
        threadId: this.options.resume,
        ...(this.options.model && { model: this.options.model }),
        ...(this.options.cwd && { cwd: this.options.cwd }),
        ...(this.options.approvalPolicy && { approvalPolicy: this.options.approvalPolicy }),
        ...(this.options.sandboxMode && { sandbox: sandboxMap[this.options.sandboxMode] }),
        ...(this.options.instructions && { baseInstructions: this.options.instructions }),
        persistExtendedHistory: true,
        experimentalRawEvents: false,
      })) as { thread: ThreadInfo };
      this.threadId = response.thread.id;
    } else {
      const response = (await this.server.request("thread/start", {
        ...(this.options.model && { model: this.options.model }),
        ...(this.options.cwd && { cwd: this.options.cwd }),
        ...(this.options.approvalPolicy && { approvalPolicy: this.options.approvalPolicy }),
        ...(this.options.sandboxMode && { sandbox: sandboxMap[this.options.sandboxMode] }),
        ...(this.options.instructions && { baseInstructions: this.options.instructions }),
        persistExtendedHistory: true,
        experimentalRawEvents: false,
      })) as { thread: ThreadInfo; model: string; cwd: string };
      this.threadId = response.thread.id;

      yield {
        type: "session_init",
        sessionId: this.threadId,
        model: response.model,
        cwd: response.cwd,
      };
    }

    this._sessionId = this.threadId;
  }

  private async *streamTurn(turnId: string): AsyncGenerator<AgentEvent> {
    const includeRaw = this.options.includeRawEvents ?? false;
    const startTime = Date.now();
    let accUsage: Usage = { inputTokens: 0, outputTokens: 0 };
    let numTurns = 0;

    // Semaphore-based event queue — prevents lost wakeups between yield points
    const eventQueue: AgentEvent[] = [];
    let turnDone = false;
    let signaled = false;
    let waitResolve: (() => void) | null = null;

    const signal = () => {
      signaled = true;
      waitResolve?.();
    };

    const waitForSignal = async () => {
      if (signaled) { signaled = false; return; }
      await new Promise<void>((r) => { waitResolve = r; });
      waitResolve = null;
      signaled = false;
    };

    const push = (event: AgentEvent) => {
      eventQueue.push(event);
      signal();
    };

    const pushRaw = (method: string, params: unknown) => {
      if (includeRaw) {
        push({ type: "raw", provider: "codex", eventType: method, data: params });
      }
    };

    // Wire abort to terminate the event loop
    this.abortTurn = () => {
      turnDone = true;
      push({
        type: "error",
        message: "Operation was cancelled",
        code: "CANCELLED",
        recoverable: false,
      });
    };

    // Filter: only handle server requests for our thread
    const threadFilter = (_id: string | number, params: unknown) => {
      const p = params as { threadId?: string };
      return p.threadId === this.threadId;
    };

    // Subscribe to notifications for our thread
    const unsubs: Array<() => void> = [];

    const subscribeNotification = (method: string, handler: (params: unknown) => void) => {
      unsubs.push(this.server.onNotification(method, (params) => {
        const p = params as { threadId?: string };
        if (p.threadId === this.threadId) {
          pushRaw(method, params);
          handler(params);
        }
      }));
    };

    // Text streaming
    subscribeNotification("item/agentMessage/delta", (params) => {
      const p = params as { delta: string };
      push({ type: "text_delta", text: p.delta });
    });

    // Reasoning streaming
    subscribeNotification("item/reasoning/summaryTextDelta", (params) => {
      const p = params as { delta: string };
      push({ type: "thinking_delta", text: p.delta });
    });

    // Item lifecycle
    subscribeNotification("item/started", (params) => {
      const p = params as { item: ThreadItem };
      for (const event of mapItemStarted(p.item)) push(event);
    });

    subscribeNotification("item/completed", (params) => {
      const p = params as { item: ThreadItem };
      for (const event of mapItemCompleted(p.item)) push(event);
    });

    // Turn lifecycle
    subscribeNotification("turn/started", () => {
      push({ type: "status", message: "Turn started" });
    });

    subscribeNotification("turn/completed", () => {
      numTurns++;
      turnDone = true;
      push({ type: "turn_complete", usage: accUsage });
    });

    // Token usage
    subscribeNotification("thread/tokenUsage/updated", (params) => {
      const p = params as { tokenUsage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } };
      if (p.tokenUsage) {
        accUsage = {
          inputTokens: p.tokenUsage.inputTokens ?? accUsage.inputTokens,
          outputTokens: p.tokenUsage.outputTokens ?? accUsage.outputTokens,
          cacheReadTokens: p.tokenUsage.cachedInputTokens ?? accUsage.cacheReadTokens,
        };
      }
    });

    // Errors
    subscribeNotification("error", (params) => {
      const p = params as { error?: { message?: string }; willRetry?: boolean };
      push({
        type: "error",
        message: p.error?.message ?? "Unknown error",
        code: "CODEX_ERROR",
        recoverable: p.willRetry ?? false,
      });
    });

    // Register server request handlers with threadId filter (approval, user input)
    unsubs.push(this.server.onServerRequest(
      "item/commandExecution/requestApproval",
      (id, params) => this.handleApprovalRequest(id, params, "command", push),
      threadFilter,
    ));

    unsubs.push(this.server.onServerRequest(
      "item/fileChange/requestApproval",
      (id, params) => this.handleApprovalRequest(id, params, "file_change", push),
      threadFilter,
    ));

    unsubs.push(this.server.onServerRequest(
      "item/tool/requestUserInput",
      (id, params) => this.handleAgentQuestionRequest(id, params, push),
      threadFilter,
    ));

    try {
      // Yield events as they arrive
      while (!turnDone || eventQueue.length > 0) {
        if (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        } else if (!turnDone) {
          await waitForSignal();
        }
      }

      // Synthesize session_complete
      yield {
        type: "session_complete",
        usage: accUsage,
        durationMs: Date.now() - startTime,
        numTurns,
      };
    } finally {
      this.abortTurn = null;
      for (const unsub of unsubs) unsub();
    }
  }

  private handleApprovalRequest(
    requestId: string | number,
    params: unknown,
    kind: "command" | "file_change",
    push: (event: AgentEvent) => void,
  ) {
    const p = params as {
      itemId?: string;
      approvalId?: string;
      command?: string;
      reason?: string;
    };
    const approvalId = p.approvalId ?? p.itemId ?? String(requestId);
    const description = kind === "command"
      ? (p.command ?? p.reason ?? "Command execution")
      : (p.reason ?? "File change");

    // Emit observable event
    push({
      type: "approval_request",
      id: approvalId,
      kind,
      description,
      detail: params,
    });

    if (this.handlers.onApprovalRequest) {
      this.handlers
        .onApprovalRequest({ id: approvalId, kind, description, detail: params })
        .then((decision) => {
          push({ type: "approval_response", id: approvalId, decision });
          this.server.respond(requestId, { decision: mapDecisionToCodex(decision) });
        })
        .catch(() => {
          push({ type: "approval_response", id: approvalId, decision: "deny" });
          this.server.respond(requestId, { decision: "decline" });
        });
    } else {
      // Safety by default: no callback → deny
      push({ type: "approval_response", id: approvalId, decision: "deny" });
      this.server.respond(requestId, { decision: "decline" });
    }
  }

  private handleAgentQuestionRequest(
    requestId: string | number,
    params: unknown,
    push: (event: AgentEvent) => void,
  ) {
    const p = params as {
      itemId?: string;
      questions?: Array<{
        id: string;
        header: string;
        question: string;
        isOther?: boolean;
        isSecret?: boolean;
        options?: Array<{ label: string; description: string }> | null;
      }>;
    };

    const inputId = p.itemId ?? String(requestId);
    const questions = (p.questions ?? []).map((q) => ({
      id: q.id,
      header: q.header,
      question: q.question,
      freeform: q.isOther ?? false,
      secret: q.isSecret ?? false,
      options: q.options ?? undefined,
    }));

    // Emit observable event
    push({
      type: "agent_question",
      id: inputId,
      questions,
    });

    if (this.handlers.onAgentQuestion) {
      this.handlers
        .onAgentQuestion({ id: inputId, questions })
        .then((response) => {
          push({ type: "agent_question_response", id: inputId, answers: response.answers });
          // Map to Codex format: { answers: Record<string, { answers: string[] }> }
          const codexAnswers: Record<string, { answers: string[] }> = {};
          for (const [qId, ans] of Object.entries(response.answers)) {
            codexAnswers[qId] = { answers: ans };
          }
          this.server.respond(requestId, { answers: codexAnswers });
        })
        .catch(() => {
          // Decline by providing empty answers
          this.server.respond(requestId, { answers: {} });
        });
    } else {
      // No callback → decline
      this.server.respond(requestId, { answers: {} });
    }
  }

  abort() {
    this.abortController.abort();
    this.abortTurn?.();
    if (this.threadId) {
      // Best-effort interrupt
      this.server.request("turn/interrupt", { threadId: this.threadId }).catch(() => {});
    }
  }

  close() {
    this.abortTurn?.();
    this.server.release();
  }
}

export function createCodexSession(options: CodexSessionOptions): ProviderSession {
  return new CodexProviderSession(options);
}
