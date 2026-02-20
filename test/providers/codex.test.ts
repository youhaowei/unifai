import { describe, test, expect } from "bun:test";
import { mapThreadEvent } from "../../src/providers/codex";
import type { AgentEvent } from "../../src/types";

function collect(event: unknown, includeRaw = false): AgentEvent[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return [...mapThreadEvent(event as any, includeRaw)];
}

describe("mapThreadEvent", () => {
  test("maps thread.started → session_init", () => {
    const events = collect({
      type: "thread.started",
      thread_id: "thread-abc-123",
    });

    expect(events).toEqual([
      { type: "session_init", sessionId: "thread-abc-123" },
    ]);
  });

  test("maps item.started command_execution → tool_start (Bash)", () => {
    const events = collect({
      type: "item.started",
      item: {
        id: "item-1",
        type: "command_execution",
        command: "ls -la",
        aggregated_output: "",
        status: "in_progress",
      },
    });

    expect(events).toEqual([
      {
        type: "tool_start",
        toolUseId: "item-1",
        toolName: "Bash",
        input: "ls -la",
      },
    ]);
  });

  test("maps item.started file_change → tool_start (Edit)", () => {
    const changes = [{ path: "src/index.ts", kind: "update" }];
    const events = collect({
      type: "item.started",
      item: {
        id: "item-2",
        type: "file_change",
        changes,
        status: "completed",
      },
    });

    expect(events).toEqual([
      {
        type: "tool_start",
        toolUseId: "item-2",
        toolName: "Edit",
        input: changes,
      },
    ]);
  });

  test("maps item.started mcp_tool_call → tool_start with composite name", () => {
    const events = collect({
      type: "item.started",
      item: {
        id: "item-3",
        type: "mcp_tool_call",
        server: "filesystem",
        tool: "read_file",
        arguments: { path: "/tmp/test.txt" },
        status: "in_progress",
      },
    });

    expect(events).toEqual([
      {
        type: "tool_start",
        toolUseId: "item-3",
        toolName: "mcp__filesystem__read_file",
        input: { path: "/tmp/test.txt" },
      },
    ]);
  });

  test("maps item.completed agent_message → text_complete", () => {
    const events = collect({
      type: "item.completed",
      item: {
        id: "item-4",
        type: "agent_message",
        text: "I've completed the task.",
      },
    });

    expect(events).toEqual([
      { type: "text_complete", text: "I've completed the task." },
    ]);
  });

  test("maps item.completed reasoning → thinking_delta", () => {
    const events = collect({
      type: "item.completed",
      item: {
        id: "item-5",
        type: "reasoning",
        text: "I should check the file first...",
      },
    });

    expect(events).toEqual([
      { type: "thinking_delta", text: "I should check the file first..." },
    ]);
  });

  test("maps item.completed command_execution → tool_result", () => {
    const events = collect({
      type: "item.completed",
      item: {
        id: "item-6",
        type: "command_execution",
        command: "ls -la",
        aggregated_output: "total 8\ndrwxr-xr-x ...",
        exit_code: 0,
        status: "completed",
      },
    });

    expect(events).toEqual([
      {
        type: "tool_result",
        toolUseId: "item-6",
        toolName: "Bash",
        result: "total 8\ndrwxr-xr-x ...",
        isError: false,
      },
    ]);
  });

  test("maps item.completed failed command → tool_result with isError", () => {
    const events = collect({
      type: "item.completed",
      item: {
        id: "item-7",
        type: "command_execution",
        command: "invalid-cmd",
        aggregated_output: "command not found",
        exit_code: 127,
        status: "failed",
      },
    });

    expect(events[0]).toMatchObject({
      type: "tool_result",
      isError: true,
    });
  });

  test("maps item.completed file_change → tool_result", () => {
    const changes = [{ path: "src/app.ts", kind: "update" }];
    const events = collect({
      type: "item.completed",
      item: {
        id: "item-8",
        type: "file_change",
        changes,
        status: "completed",
      },
    });

    expect(events).toEqual([
      {
        type: "tool_result",
        toolUseId: "item-8",
        toolName: "Edit",
        result: changes,
        isError: false,
      },
    ]);
  });

  test("maps item.completed mcp_tool_call → tool_result", () => {
    const result = { content: [{ type: "text", text: "file contents" }], structured_content: null };
    const events = collect({
      type: "item.completed",
      item: {
        id: "item-9",
        type: "mcp_tool_call",
        server: "filesystem",
        tool: "read_file",
        arguments: { path: "/tmp/test.txt" },
        result,
        status: "completed",
      },
    });

    expect(events).toEqual([
      {
        type: "tool_result",
        toolUseId: "item-9",
        toolName: "mcp__filesystem__read_file",
        result,
        isError: false,
      },
    ]);
  });

  test("maps item.completed error → error event", () => {
    const events = collect({
      type: "item.completed",
      item: {
        id: "item-10",
        type: "error",
        message: "Something went wrong",
      },
    });

    expect(events).toEqual([
      {
        type: "error",
        message: "Something went wrong",
        code: "ITEM_ERROR",
        recoverable: false,
      },
    ]);
  });

  test("maps turn.completed → turn_complete with usage", () => {
    const events = collect({
      type: "turn.completed",
      usage: {
        input_tokens: 1500,
        output_tokens: 800,
        cached_input_tokens: 300,
      },
    });

    expect(events).toEqual([
      {
        type: "turn_complete",
        usage: {
          inputTokens: 1500,
          outputTokens: 800,
          cacheReadTokens: 300,
        },
      },
    ]);
  });

  test("maps turn.completed without usage", () => {
    const events = collect({ type: "turn.completed" });

    expect(events).toEqual([
      { type: "turn_complete", usage: undefined },
    ]);
  });

  test("maps turn.failed → error", () => {
    const events = collect({
      type: "turn.failed",
      error: { message: "Rate limit exceeded" },
    });

    expect(events).toEqual([
      {
        type: "error",
        message: "Rate limit exceeded",
        code: "TURN_FAILED",
        recoverable: false,
      },
    ]);
  });

  test("maps thread error → error", () => {
    const events = collect({
      type: "error",
      message: "Connection lost",
    });

    expect(events).toEqual([
      {
        type: "error",
        message: "Connection lost",
        code: "THREAD_ERROR",
        recoverable: false,
      },
    ]);
  });

  test("includes raw event when includeRaw is true", () => {
    const event = { type: "thread.started", thread_id: "t-1" };
    const events = collect(event, true);

    expect(events[0]).toEqual({
      type: "raw",
      provider: "codex",
      eventType: "thread.started",
      data: event,
    });
    expect(events[1]!.type).toBe("session_init");
  });

  test("ignores item.started for non-tool items", () => {
    const events = collect({
      type: "item.started",
      item: { id: "item-x", type: "agent_message", text: "hi" },
    });
    expect(events).toEqual([]);
  });
});
