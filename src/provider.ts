import type { AgentEvent } from "./types";

/** Internal contract that each provider adapter implements. Not exported to consumers. */
export interface ProviderSession {
  readonly sessionId: string | null;
  send(message: string): AsyncGenerator<AgentEvent>;
  abort(): void;
  close(): void;
}
