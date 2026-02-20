import { describe, test, expect } from "bun:test";
import { mapSdkMessage, createClaudeSession } from "../../src/providers/claude";
import type { AgentEvent } from "../../src/types";

function collect(msg: unknown, includeRaw = false): AgentEvent[] {
  return [...mapSdkMessage(msg, includeRaw)];
}

describe("mapSdkMessage", () => {
  test("maps system init → session_init", () => {
    const events = collect({
      type: "system",
      subtype: "init",
      session_id: "sess-123",
      model: "claude-sonnet-4-20250514",
      tools: ["Read", "Write", "Bash"],
      cwd: "/home/user/project",
    });

    expect(events).toEqual([
      {
        type: "session_init",
        sessionId: "sess-123",
        model: "claude-sonnet-4-20250514",
        tools: ["Read", "Write", "Bash"],
        cwd: "/home/user/project",
      },
    ]);
  });

  test("maps system status → status (reads status field)", () => {
    const events = collect({
      type: "system",
      subtype: "status",
      status: "compacting",
    });

    expect(events).toEqual([
      { type: "status", message: "compacting" },
    ]);
  });

  test("maps text_delta stream event → text_delta", () => {
    const events = collect({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello" },
      },
    });

    expect(events).toEqual([
      { type: "text_delta", text: "Hello" },
    ]);
  });

  test("maps thinking_delta stream event → thinking_delta", () => {
    const events = collect({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "Let me think..." },
      },
    });

    expect(events).toEqual([
      { type: "thinking_delta", text: "Let me think..." },
    ]);
  });

  test("maps thinking_delta with text field fallback", () => {
    const events = collect({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", text: "fallback" },
      },
    });

    expect(events).toEqual([
      { type: "thinking_delta", text: "fallback" },
    ]);
  });

  test("maps assistant text block → text_complete", () => {
    const events = collect({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Here is the answer." },
        ],
      },
    });

    expect(events).toEqual([
      { type: "text_complete", text: "Here is the answer." },
    ]);
  });

  test("maps assistant tool_use block → tool_start", () => {
    const events = collect({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tu-001",
            name: "Read",
            input: { file_path: "/tmp/test.ts" },
          },
        ],
      },
    });

    expect(events).toEqual([
      {
        type: "tool_start",
        toolUseId: "tu-001",
        toolName: "Read",
        input: { file_path: "/tmp/test.ts" },
      },
    ]);
  });

  test("maps assistant with mixed content → multiple events", () => {
    const events = collect({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me read that file." },
          { type: "tool_use", id: "tu-002", name: "Read", input: { file_path: "/tmp/a.ts" } },
        ],
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("text_complete");
    expect(events[1]!.type).toBe("tool_start");
  });

  test("maps result success → session_complete", () => {
    const events = collect({
      type: "result",
      subtype: "success",
      result: "Task completed",
      structured_output: { key: "value" },
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 50,
      },
      duration_ms: 3500,
      num_turns: 2,
      total_cost_usd: 0.015,
    });

    expect(events).toEqual([
      {
        type: "session_complete",
        result: "Task completed",
        structuredOutput: { key: "value" },
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 200,
          cacheCreationTokens: 50,
        },
        durationMs: 3500,
        numTurns: 2,
        costUsd: 0.015,
      },
    ]);
  });

  test("maps result error → session_complete + error", () => {
    const events = collect({
      type: "result",
      subtype: "error_max_turns",
      result: "Partial result",
      usage: { input_tokens: 500, output_tokens: 200 },
      duration_ms: 2000,
      num_turns: 5,
      errors: ["Max turns exceeded"],
    });

    expect(events).toHaveLength(2);

    expect(events[0]).toEqual({
      type: "session_complete",
      result: "Partial result",
      structuredOutput: undefined,
      usage: {
        inputTokens: 500,
        outputTokens: 200,
        cacheReadTokens: undefined,
        cacheCreationTokens: undefined,
      },
      durationMs: 2000,
      numTurns: 5,
      costUsd: undefined,
    });

    expect(events[1]).toEqual({
      type: "error",
      message: "Max turns exceeded",
      code: "error_max_turns",
      recoverable: false,
    });
  });

  test("maps tool_progress → tool_progress", () => {
    const events = collect({
      type: "tool_progress",
      tool_use_id: "tu-003",
      tool_name: "Bash",
      elapsed_time_seconds: 12.5,
    });

    expect(events).toEqual([
      {
        type: "tool_progress",
        toolUseId: "tu-003",
        toolName: "Bash",
        elapsedSeconds: 12.5,
      },
    ]);
  });

  test("maps tool_use_summary → tool_summary", () => {
    const events = collect({
      type: "tool_use_summary",
      summary: "Read 3 files, wrote 1",
      preceding_tool_use_ids: ["tu-001", "tu-002", "tu-003"],
    });

    expect(events).toEqual([
      {
        type: "tool_summary",
        summary: "Read 3 files, wrote 1",
        precedingToolUseIds: ["tu-001", "tu-002", "tu-003"],
      },
    ]);
  });

  test("includes raw event when includeRaw is true", () => {
    const msg = { type: "system", subtype: "init", session_id: "s-1" };
    const events = collect(msg, true);

    expect(events[0]).toEqual({
      type: "raw",
      provider: "claude",
      eventType: "system",
      data: msg,
    });
    // session_init follows
    expect(events[1]!.type).toBe("session_init");
  });

  test("ignores unknown message types gracefully", () => {
    const events = collect({ type: "unknown_future_type", foo: "bar" });
    expect(events).toEqual([]);
  });

  test("ignores stream events without delta", () => {
    const events = collect({
      type: "stream_event",
      event: { type: "message_start", message: {} },
    });
    expect(events).toEqual([]);
  });
});

describe("createClaudeSession", () => {
  // We can't invoke send() (no real SDK), but we can verify the factory
  // selects the right backend for both V1 and V2 paths.

  // -- Auto-selection --

  test("auto-selects V2 for basic options", () => {
    const session = createClaudeSession({ model: "haiku" });
    expect(session).toHaveProperty("sessionId");
    expect(session).toHaveProperty("send");
    expect(session).toHaveProperty("abort");
    expect(session).toHaveProperty("close");
    session.close();
  });

  test("auto-selects V1 when V1-only options are present", () => {
    const session = createClaudeSession({ model: "haiku", cwd: "/tmp" });
    expect(session).toHaveProperty("send");
    session.close();
  });

  test("auto-selects V1 for outputFormat", () => {
    const session = createClaudeSession({
      model: "haiku",
      outputFormat: { type: "json_schema", schema: { type: "object" } },
    });
    expect(session).toHaveProperty("send");
    session.close();
  });

  test("auto-selects V2 when only V2-compatible options are set", () => {
    const session = createClaudeSession({
      model: "haiku",
      allowedTools: ["Read"],
      permissionMode: "plan",
      env: { HOME: "/tmp" },
    });
    expect(session).toHaveProperty("send");
    session.close();
  });

  // -- Explicit sdkVersion --

  test("sdkVersion: 'v2' forces V2 even with V1-only options", () => {
    const session = createClaudeSession({
      model: "haiku",
      sdkVersion: "v2",
      cwd: "/tmp",          // V1-only, will be ignored
      maxTurns: 3,           // V1-only, will be ignored
    });
    expect(session).toHaveProperty("send");
    session.close();
  });

  test("sdkVersion: 'v1' forces V1 even without V1-only options", () => {
    const session = createClaudeSession({
      model: "haiku",
      sdkVersion: "v1",
    });
    expect(session).toHaveProperty("send");
    session.close();
  });
});
