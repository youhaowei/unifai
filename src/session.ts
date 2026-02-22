import type {
  AgentEvent,
  ClaudeSessionOptions,
  CodexSessionOptions,
  ModelInfo,
  ProviderKind,
  SessionResult,
  UnifaiSession,
  Usage,
} from "./types";
import { ProviderError } from "./errors";
import { createClaudeSession, getClaudeSupportedModels } from "./providers/claude";
import { createCodexSession } from "./providers/codex";
import type { ProviderSession } from "./provider";

// --- Session implementation ---

/** Exported for testing only — not re-exported from index.ts. */
export class UnifaiSessionImpl implements UnifaiSession {
  private _isActive = false;

  constructor(
    public readonly provider: ProviderKind,
    private readonly providerSession: ProviderSession,
  ) {}

  get sessionId() {
    return this.providerSession.sessionId;
  }

  get isActive() {
    return this._isActive;
  }

  /**
   * Sends a message and streams back events.
   *
   * The isActive guard runs synchronously at call time (not lazily when the
   * generator starts iterating), preventing concurrent send() on the same session.
   */
  send(message: string): AsyncGenerator<AgentEvent> {
    if (this._isActive) {
      throw new ProviderError("Session is already processing a message", this.provider);
    }
    this._isActive = true;
    return this._sendImpl(message);
  }

  private async *_sendImpl(message: string): AsyncGenerator<AgentEvent> {
    try {
      yield* this.providerSession.send(message);
    } catch (err: unknown) {
      if (isAbortError(err)) {
        yield { type: "error", message: "Operation was cancelled", code: "CANCELLED", recoverable: false };
        return;
      }
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(
        err instanceof Error ? err.message : String(err),
        this.provider,
        err,
      );
    } finally {
      this._isActive = false;
    }
  }

  abort() {
    this.providerSession.abort();
  }

  close() {
    this._isActive = false;
    this.providerSession.close();
  }

  async [Symbol.asyncDispose]() {
    this.close();
  }
}

// --- Factory ---

export function createSession(provider: "claude", options: ClaudeSessionOptions): UnifaiSession;
export function createSession(provider: "codex", options: CodexSessionOptions): UnifaiSession;
export function createSession(
  provider: ProviderKind,
  options: ClaudeSessionOptions | CodexSessionOptions,
): UnifaiSession {
  switch (provider) {
    case "claude":
      return new UnifaiSessionImpl("claude", createClaudeSession(options as ClaudeSessionOptions));
    case "codex":
      return new UnifaiSessionImpl("codex", createCodexSession(options as CodexSessionOptions));
    default:
      throw new ProviderError(`Unknown provider: ${provider}`, provider);
  }
}

// --- One-shot convenience ---

export async function prompt(
  provider: "claude",
  message: string,
  options: ClaudeSessionOptions,
): Promise<SessionResult>;
export async function prompt(
  provider: "codex",
  message: string,
  options: CodexSessionOptions,
): Promise<SessionResult>;
export async function prompt(
  provider: ProviderKind,
  message: string,
  options: ClaudeSessionOptions | CodexSessionOptions,
): Promise<SessionResult> {
  const session = createSession(provider as "claude", options as ClaudeSessionOptions);
  try {
    return await collectSessionResult(session, message, provider);
  } finally {
    session.close();
  }
}

/** Iterates all events from a single send() and collects the final result. */
async function collectSessionResult(
  session: UnifaiSession,
  message: string,
  provider: ProviderKind,
): Promise<SessionResult> {
  let text = "";
  let structuredOutput: unknown;
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let durationMs = 0;
  let numTurns = 0;
  let costUsd: number | undefined;
  let gotComplete = false;

  for await (const event of session.send(message)) {
    switch (event.type) {
      case "text_complete":
        if (!event.isIntermediate) {
          text += event.text;
        }
        break;
      case "session_complete":
        gotComplete = true;
        usage = event.usage;
        durationMs = event.durationMs;
        numTurns = event.numTurns;
        costUsd = event.costUsd;
        if (event.structuredOutput !== undefined) {
          structuredOutput = event.structuredOutput;
        }
        break;
      case "error":
        if (!gotComplete && !event.recoverable) {
          throw new ProviderError(event.message, provider);
        }
        break;
    }
  }

  return { text, structuredOutput, usage, durationMs, numTurns, costUsd };
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}

// --- Model discovery ---

export async function getSupportedModels(
  provider: "claude",
  options?: { env?: Record<string, string | undefined>; cwd?: string },
): Promise<ModelInfo[]>;
export async function getSupportedModels(
  provider: ProviderKind,
  options?: { env?: Record<string, string | undefined>; cwd?: string },
): Promise<ModelInfo[]> {
  switch (provider) {
    case "claude":
      return getClaudeSupportedModels(options);
    case "codex":
      throw new ProviderError("getSupportedModels not yet implemented for codex", "codex");
    default:
      throw new ProviderError(`Unknown provider: ${provider}`, provider);
  }
}
