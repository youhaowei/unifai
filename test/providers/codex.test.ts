import { describe, test, expect } from "bun:test";
import { mapItemStarted, mapItemCompleted } from "../../src/providers/codex";
import type { AgentEvent } from "../../src/types";

function collectStarted(item: Record<string, unknown>): AgentEvent[] {
  return [...mapItemStarted(item as any)];
}

function collectCompleted(item: Record<string, unknown>): AgentEvent[] {
  return [...mapItemCompleted(item as any)];
}

describe("mapItemStarted", () => {
  test("maps commandExecution → tool_start (Bash)", () => {
    const events = collectStarted({
      id: "item-1",
      type: "commandExecution",
      command: "ls -la",
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

  test("maps commandExecution without command → empty string input", () => {
    const events = collectStarted({
      id: "item-1b",
      type: "commandExecution",
    });

    expect(events).toEqual([
      {
        type: "tool_start",
        toolUseId: "item-1b",
        toolName: "Bash",
        input: "",
      },
    ]);
  });

  test("maps fileChange → tool_start (Edit)", () => {
    const changes = [{ path: "src/index.ts", kind: "update" }];
    const events = collectStarted({
      id: "item-2",
      type: "fileChange",
      changes,
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

  test("maps mcpToolCall → tool_start with composite name", () => {
    const events = collectStarted({
      id: "item-3",
      type: "mcpToolCall",
      server: "filesystem",
      tool: "read_file",
      arguments: { path: "/tmp/test.txt" },
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

  test("maps dynamicToolCall → tool_start with tool name", () => {
    const events = collectStarted({
      id: "item-4",
      type: "dynamicToolCall",
      tool: "custom_tool",
      arguments: { foo: "bar" },
    });

    expect(events).toEqual([
      {
        type: "tool_start",
        toolUseId: "item-4",
        toolName: "custom_tool",
        input: { foo: "bar" },
      },
    ]);
  });

  test("maps dynamicToolCall without tool name → fallback name", () => {
    const events = collectStarted({
      id: "item-4b",
      type: "dynamicToolCall",
      arguments: {},
    });

    expect(events).toEqual([
      {
        type: "tool_start",
        toolUseId: "item-4b",
        toolName: "dynamic_tool",
        input: {},
      },
    ]);
  });

  test("ignores non-tool item types (agentMessage)", () => {
    const events = collectStarted({
      id: "item-x",
      type: "agentMessage",
      text: "hello",
    });
    expect(events).toEqual([]);
  });

  test("ignores unknown item types", () => {
    const events = collectStarted({
      id: "item-y",
      type: "unknownType",
    });
    expect(events).toEqual([]);
  });
});

describe("mapItemCompleted", () => {
  test("maps agentMessage → text_complete", () => {
    const events = collectCompleted({
      id: "item-5",
      type: "agentMessage",
      text: "I've completed the task.",
    });

    expect(events).toEqual([
      { type: "text_complete", text: "I've completed the task." },
    ]);
  });

  test("maps agentMessage without text → empty string", () => {
    const events = collectCompleted({
      id: "item-5b",
      type: "agentMessage",
    });

    expect(events).toEqual([
      { type: "text_complete", text: "" },
    ]);
  });

  test("maps reasoning with text → thinking_delta", () => {
    const events = collectCompleted({
      id: "item-6",
      type: "reasoning",
      text: "I should check the file first...",
    });

    expect(events).toEqual([
      { type: "thinking_delta", text: "I should check the file first..." },
    ]);
  });

  test("maps reasoning with summary array → joined thinking_delta", () => {
    const events = collectCompleted({
      id: "item-6b",
      type: "reasoning",
      summary: ["Step 1: Read file", "Step 2: Modify"],
    });

    expect(events).toEqual([
      { type: "thinking_delta", text: "Step 1: Read file\nStep 2: Modify" },
    ]);
  });

  test("maps commandExecution completed → tool_result", () => {
    const events = collectCompleted({
      id: "item-7",
      type: "commandExecution",
      aggregatedOutput: "total 8\ndrwxr-xr-x ...",
      status: "completed",
    });

    expect(events).toEqual([
      {
        type: "tool_result",
        toolUseId: "item-7",
        toolName: "Bash",
        result: "total 8\ndrwxr-xr-x ...",
        isError: false,
      },
    ]);
  });

  test("maps commandExecution failed → tool_result with isError", () => {
    const events = collectCompleted({
      id: "item-8",
      type: "commandExecution",
      aggregatedOutput: "command not found",
      status: "failed",
    });

    expect(events).toEqual([
      {
        type: "tool_result",
        toolUseId: "item-8",
        toolName: "Bash",
        result: "command not found",
        isError: true,
      },
    ]);
  });

  test("maps commandExecution without output → empty string result", () => {
    const events = collectCompleted({
      id: "item-8b",
      type: "commandExecution",
      status: "completed",
    });

    expect(events).toEqual([
      {
        type: "tool_result",
        toolUseId: "item-8b",
        toolName: "Bash",
        result: "",
        isError: false,
      },
    ]);
  });

  test("maps fileChange completed → tool_result", () => {
    const changes = [{ path: "src/app.ts", kind: "update" }];
    const events = collectCompleted({
      id: "item-9",
      type: "fileChange",
      changes,
      status: "completed",
    });

    expect(events).toEqual([
      {
        type: "tool_result",
        toolUseId: "item-9",
        toolName: "Edit",
        result: changes,
        isError: false,
      },
    ]);
  });

  test("maps fileChange failed → tool_result with isError", () => {
    const events = collectCompleted({
      id: "item-9b",
      type: "fileChange",
      changes: [],
      status: "failed",
    });

    expect(events[0]).toMatchObject({
      type: "tool_result",
      toolName: "Edit",
      isError: true,
    });
  });

  test("maps mcpToolCall completed → tool_result", () => {
    const result = { content: [{ type: "text", text: "file contents" }] };
    const events = collectCompleted({
      id: "item-10",
      type: "mcpToolCall",
      server: "filesystem",
      tool: "read_file",
      result,
      status: "completed",
    });

    expect(events).toEqual([
      {
        type: "tool_result",
        toolUseId: "item-10",
        toolName: "mcp__filesystem__read_file",
        result,
        isError: false,
      },
    ]);
  });

  test("maps mcpToolCall failed → tool_result with error", () => {
    const events = collectCompleted({
      id: "item-10b",
      type: "mcpToolCall",
      server: "filesystem",
      tool: "read_file",
      error: "File not found",
      status: "failed",
    });

    expect(events).toEqual([
      {
        type: "tool_result",
        toolUseId: "item-10b",
        toolName: "mcp__filesystem__read_file",
        result: "File not found",
        isError: true,
      },
    ]);
  });

  test("maps dynamicToolCall completed → tool_result", () => {
    const contentItems = [{ type: "text", text: "result" }];
    const events = collectCompleted({
      id: "item-11",
      type: "dynamicToolCall",
      tool: "custom_tool",
      contentItems,
      success: true,
    });

    expect(events).toEqual([
      {
        type: "tool_result",
        toolUseId: "item-11",
        toolName: "custom_tool",
        result: contentItems,
        isError: false,
      },
    ]);
  });

  test("maps dynamicToolCall failed → tool_result with isError", () => {
    const events = collectCompleted({
      id: "item-11b",
      type: "dynamicToolCall",
      tool: "failing_tool",
      contentItems: null,
      success: false,
    });

    expect(events).toEqual([
      {
        type: "tool_result",
        toolUseId: "item-11b",
        toolName: "failing_tool",
        result: null,
        isError: true,
      },
    ]);
  });

  test("maps error item → error event", () => {
    const events = collectCompleted({
      id: "item-12",
      type: "error",
      message: "Something went wrong",
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

  test("maps error item without message → fallback message", () => {
    const events = collectCompleted({
      id: "item-12b",
      type: "error",
    });

    expect(events).toEqual([
      {
        type: "error",
        message: "Unknown error",
        code: "ITEM_ERROR",
        recoverable: false,
      },
    ]);
  });

  test("ignores unknown item types", () => {
    const events = collectCompleted({
      id: "item-z",
      type: "unknownType",
    });
    expect(events).toEqual([]);
  });
});
