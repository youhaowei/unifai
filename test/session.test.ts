import { describe, test, expect } from "bun:test";
import { UnifaiSessionImpl } from "../src/session";
import { ProviderError } from "../src/errors";
import type { ProviderSession } from "../src/provider";
import type { AgentEvent } from "../src/types";

/** Creates a mock ProviderSession that yields the given events. */
function mockProvider(
  events: AgentEvent[],
  opts?: { sessionId?: string | null; delayMs?: number },
): ProviderSession {
  let aborted = false;

  return {
    get sessionId() {
      return opts?.sessionId ?? "mock-session";
    },
    async *send() {
      for (const event of events) {
        if (aborted) return;
        if (opts?.delayMs) {
          await new Promise((r) => setTimeout(r, opts.delayMs));
        }
        yield event;
      }
    },
    abort() {
      aborted = true;
    },
    close() {},
  };
}

/** Creates a mock that blocks until explicitly released. */
function blockingProvider() {
  let resolve: (() => void) | null = null;
  const blocked = new Promise<void>((r) => { resolve = r; });

  const provider: ProviderSession = {
    get sessionId() { return "blocking"; },
    async *send() {
      await blocked;
      yield { type: "text_complete", text: "done" } as AgentEvent;
    },
    abort() { resolve?.(); },
    close() { resolve?.(); },
  };

  return { provider, release: () => resolve?.() };
}

describe("UnifaiSession", () => {
  test("exposes correct provider kind", () => {
    const session = new UnifaiSessionImpl("claude", mockProvider([]));
    expect(session.provider).toBe("claude");
  });

  test("exposes sessionId from provider", () => {
    const session = new UnifaiSessionImpl("codex", mockProvider([], { sessionId: "codex-123" }));
    expect(session.sessionId).toBe("codex-123");
  });

  test("isActive is false initially", () => {
    const session = new UnifaiSessionImpl("claude", mockProvider([]));
    expect(session.isActive).toBe(false);
  });

  test("isActive is true during send()", async () => {
    const { provider, release } = blockingProvider();
    const session = new UnifaiSessionImpl("claude", provider);

    const gen = session.send("hello");

    // Start iterating (triggers the generator body)
    const nextPromise = gen.next();
    // Give the microtask queue a tick
    await new Promise((r) => setTimeout(r, 10));

    expect(session.isActive).toBe(true);

    release();
    await nextPromise;
    // Drain the generator
    await gen.next();

    expect(session.isActive).toBe(false);
  });

  test("concurrent send() throws", async () => {
    const { provider, release } = blockingProvider();
    const session = new UnifaiSessionImpl("claude", provider);

    const gen1 = session.send("first");
    // Start iterating gen1 to set isActive
    const p1 = gen1.next();
    await new Promise((r) => setTimeout(r, 10));

    // Second send should throw synchronously
    expect(() => session.send("second")).toThrow(ProviderError);

    release();
    await p1;
    await gen1.next(); // drain
  });

  test("send() resets isActive after completion", async () => {
    const session = new UnifaiSessionImpl("claude", mockProvider([
      { type: "text_delta", text: "hi" },
    ]));

    const events: AgentEvent[] = [];
    for await (const event of session.send("hello")) {
      events.push(event);
    }

    expect(session.isActive).toBe(false);
    expect(events).toHaveLength(1);
  });

  test("streams all events from provider", async () => {
    const expected: AgentEvent[] = [
      { type: "session_init", sessionId: "s-1", model: "haiku" },
      { type: "text_delta", text: "He" },
      { type: "text_delta", text: "llo" },
      { type: "text_complete", text: "Hello" },
      {
        type: "session_complete",
        usage: { inputTokens: 100, outputTokens: 50 },
        durationMs: 500,
        numTurns: 1,
      },
    ];

    const session = new UnifaiSessionImpl("claude", mockProvider(expected));
    const received: AgentEvent[] = [];
    for await (const event of session.send("test")) {
      received.push(event);
    }

    expect(received).toEqual(expected);
  });

  test("wraps provider errors in ProviderError", async () => {
    const failingProvider: ProviderSession = {
      get sessionId() { return null; },
      async *send() {
        throw new Error("SDK crash");
      },
      abort() {},
      close() {},
    };

    const session = new UnifaiSessionImpl("claude", failingProvider);

    try {
      for await (const _event of session.send("test")) {
        // should not reach here
      }
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).provider).toBe("claude");
      expect((err as ProviderError).message).toBe("SDK crash");
    }
  });

  test("catches AbortError and yields CANCELLED event", async () => {
    const failingProvider: ProviderSession = {
      get sessionId() { return null; },
      async *send() {
        const err = new DOMException("Aborted", "AbortError");
        throw err;
      },
      abort() {},
      close() {},
    };

    const session = new UnifaiSessionImpl("claude", failingProvider);
    const events: AgentEvent[] = [];
    for await (const event of session.send("test")) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "error", message: "Operation was cancelled", code: "CANCELLED", recoverable: false },
    ]);
  });

  test("abort() delegates to provider", async () => {
    let abortCalled = false;
    const provider: ProviderSession = {
      get sessionId() { return null; },
      async *send() { yield { type: "text_delta", text: "hi" } as AgentEvent; },
      abort() { abortCalled = true; },
      close() {},
    };

    const session = new UnifaiSessionImpl("claude", provider);
    session.abort();
    expect(abortCalled).toBe(true);
  });

  test("close() resets isActive and delegates to provider", async () => {
    let closeCalled = false;
    const { provider, release } = blockingProvider();
    const originalClose = provider.close;
    provider.close = () => {
      closeCalled = true;
      originalClose.call(provider);
    };

    const session = new UnifaiSessionImpl("claude", provider);
    const gen = session.send("test");
    gen.next(); // start
    await new Promise((r) => setTimeout(r, 10));

    expect(session.isActive).toBe(true);

    session.close();
    expect(session.isActive).toBe(false);
    expect(closeCalled).toBe(true);

    release();
  });

  test("Symbol.asyncDispose calls close()", async () => {
    let closeCalled = false;
    const provider: ProviderSession = {
      get sessionId() { return null; },
      async *send() {},
      abort() {},
      close() { closeCalled = true; },
    };

    const session = new UnifaiSessionImpl("claude", provider);
    await session[Symbol.asyncDispose]();
    expect(closeCalled).toBe(true);
  });

  test("collects text_complete and session_complete events (prompt-like flow)", async () => {
    const session = new UnifaiSessionImpl("claude", mockProvider([
      { type: "text_delta", text: "He" },
      { type: "text_delta", text: "llo" },
      { type: "text_complete", text: "Hello world" },
      {
        type: "session_complete",
        result: "done",
        structuredOutput: { answer: 42 },
        usage: { inputTokens: 200, outputTokens: 100 },
        durationMs: 1500,
        numTurns: 1,
        costUsd: 0.005,
      },
    ]));

    let text = "";
    let structuredOutput: unknown;
    let usage = { inputTokens: 0, outputTokens: 0 };
    let durationMs = 0;
    let numTurns = 0;
    let costUsd: number | undefined;

    for await (const event of session.send("question")) {
      if (event.type === "text_complete" && !event.isIntermediate) {
        text += event.text;
      }
      if (event.type === "session_complete") {
        usage = event.usage;
        durationMs = event.durationMs;
        numTurns = event.numTurns;
        costUsd = event.costUsd;
        structuredOutput = event.structuredOutput;
      }
    }

    expect(text).toBe("Hello world");
    expect(structuredOutput).toEqual({ answer: 42 });
    expect(usage).toEqual({ inputTokens: 200, outputTokens: 100 });
    expect(durationMs).toBe(1500);
    expect(numTurns).toBe(1);
    expect(costUsd).toBe(0.005);
  });

  test("can send again after first send completes", async () => {
    const provider = mockProvider([
      { type: "text_complete", text: "response" },
    ]);

    const session = new UnifaiSessionImpl("claude", provider);

    // First send
    for await (const _e of session.send("first")) { /* drain */ }
    expect(session.isActive).toBe(false);

    // Second send should work
    const events: AgentEvent[] = [];
    for await (const event of session.send("second")) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
  });
});
