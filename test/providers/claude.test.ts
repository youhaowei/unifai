import { describe, test, expect } from "bun:test";
import { mapSdkMessage, createClaudeSession } from "../../src/providers/claude";
import type { AgentEvent } from "../../src/types";

function collect(msg: unknown, includeRaw = false): AgentEvent[] {
  return [...mapSdkMessage(msg, includeRaw)];
}

describe("mapSdkMessage", () => {
  // --- System messages ---

  test("maps system init → session_init with Claude-specific fields", () => {
    const events = collect({
      type: "system",
      subtype: "init",
      session_id: "sess-123",
      model: "claude-sonnet-4-20250514",
      tools: ["Read", "Write", "Bash"],
      cwd: "/home/user/project",
      claude_code_version: "1.2.3",
      mcp_servers: [{ name: "test", status: "connected" }],
      permissionMode: "default",
      slash_commands: ["/commit"],
      skills: ["review-pr"],
    });

    expect(events).toEqual([
      {
        type: "session_init",
        sessionId: "sess-123",
        model: "claude-sonnet-4-20250514",
        tools: ["Read", "Write", "Bash"],
        cwd: "/home/user/project",
        claudeCodeVersion: "1.2.3",
        mcpServers: [{ name: "test", status: "connected" }],
        permissionMode: "default",
        slashCommands: ["/commit"],
        skills: ["review-pr"],
      },
    ]);
  });

  test("maps system status → status", () => {
    const events = collect({
      type: "system",
      subtype: "status",
      status: "compacting",
    });

    expect(events).toEqual([
      { type: "status", message: "compacting" },
    ]);
  });

  test("maps system hook_started → hook_started", () => {
    const events = collect({
      type: "system",
      subtype: "hook_started",
      hook_id: "h-1",
      hook_name: "pre-commit",
      hook_event: "ToolUse",
    });

    expect(events).toEqual([
      { type: "hook_started", hookId: "h-1", hookName: "pre-commit", hookEvent: "ToolUse" },
    ]);
  });

  test("maps system hook_progress → hook_progress", () => {
    const events = collect({
      type: "system",
      subtype: "hook_progress",
      hook_id: "h-1",
      hook_name: "pre-commit",
      hook_event: "ToolUse",
      stdout: "running...",
      stderr: "",
      output: "running...",
    });

    expect(events).toEqual([
      {
        type: "hook_progress",
        hookId: "h-1",
        hookName: "pre-commit",
        hookEvent: "ToolUse",
        stdout: "running...",
        stderr: "",
        output: "running...",
      },
    ]);
  });

  test("maps system hook_response → hook_response", () => {
    const events = collect({
      type: "system",
      subtype: "hook_response",
      hook_id: "h-1",
      hook_name: "pre-commit",
      hook_event: "ToolUse",
      outcome: "success",
      output: "done",
      exit_code: 0,
    });

    expect(events).toEqual([
      {
        type: "hook_response",
        hookId: "h-1",
        hookName: "pre-commit",
        hookEvent: "ToolUse",
        outcome: "success",
        output: "done",
        exitCode: 0,
      },
    ]);
  });

  test("maps system task_notification → task_notification", () => {
    const events = collect({
      type: "system",
      subtype: "task_notification",
      task_id: "t-42",
      status: "completed",
      output_file: "/tmp/out.txt",
      summary: "Task finished",
    });

    expect(events).toEqual([
      {
        type: "task_notification",
        taskId: "t-42",
        status: "completed",
        outputFile: "/tmp/out.txt",
        summary: "Task finished",
      },
    ]);
  });

  test("maps unknown system subtype → status fallback", () => {
    const events = collect({
      type: "system",
      subtype: "future_thing",
      summary: "something happened",
    });

    expect(events).toEqual([
      { type: "status", message: "[future_thing] something happened" },
    ]);
  });

  // --- Stream events ---

  test("maps stream message_start → message_start", () => {
    const events = collect({
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          id: "msg-001",
          model: "claude-sonnet-4-20250514",
          stop_reason: null,
          usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 50 },
        },
      },
    });

    expect(events).toEqual([
      {
        type: "message_start",
        messageId: "msg-001",
        model: "claude-sonnet-4-20250514",
        stopReason: null,
        usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 50, cacheCreationTokens: undefined },
      },
    ]);
  });

  test("maps stream message_stop → message_stop", () => {
    const events = collect({
      type: "stream_event",
      event: { type: "message_stop" },
    });

    expect(events).toEqual([{ type: "message_stop" }]);
  });

  test("maps stream content_block_start → content_block_start", () => {
    const events = collect({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
    });

    expect(events).toEqual([
      { type: "content_block_start", index: 0, blockType: "text", id: undefined, name: undefined },
    ]);
  });

  test("maps stream content_block_start tool_use with id and name", () => {
    const events = collect({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu-001", name: "Read" },
      },
    });

    expect(events).toEqual([
      { type: "content_block_start", index: 1, blockType: "tool_use", id: "tu-001", name: "Read" },
    ]);
  });

  test("maps stream content_block_stop → content_block_stop", () => {
    const events = collect({
      type: "stream_event",
      event: { type: "content_block_stop", index: 2 },
    });

    expect(events).toEqual([{ type: "content_block_stop", index: 2 }]);
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

  test("maps thinking_delta stream event → thinking_delta with index", () => {
    const events = collect({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me think..." },
      },
    });

    expect(events).toEqual([
      { type: "thinking_delta", text: "Let me think...", index: 0 },
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
      { type: "thinking_delta", text: "fallback", index: undefined },
    ]);
  });

  // --- Assistant messages ---

  test("maps assistant → assistant_message + text_complete", () => {
    const events = collect({
      type: "assistant",
      uuid: "uuid-1",
      session_id: "sess-1",
      message: {
        id: "msg-002",
        model: "claude-sonnet-4-20250514",
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [
          { type: "text", text: "Here is the answer." },
        ],
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "assistant_message",
      messageId: "msg-002",
      uuid: "uuid-1",
      sessionId: "sess-1",
      model: "claude-sonnet-4-20250514",
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: undefined, cacheCreationTokens: undefined },
      content: [{ type: "text", text: "Here is the answer." }],
      error: undefined,
    });
    expect(events[1]).toEqual({ type: "text_complete", text: "Here is the answer." });
  });

  test("maps assistant tool_use → assistant_message + tool_start", () => {
    const events = collect({
      type: "assistant",
      session_id: "sess-1",
      message: {
        id: "msg-003",
        model: "claude-sonnet-4-20250514",
        stop_reason: "tool_use",
        usage: { input_tokens: 200, output_tokens: 100 },
        content: [
          { type: "tool_use", id: "tu-001", name: "Read", input: { file_path: "/tmp/test.ts" } },
        ],
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("assistant_message");
    expect(events[1]).toEqual({
      type: "tool_start",
      toolUseId: "tu-001",
      toolName: "Read",
      input: { file_path: "/tmp/test.ts" },
    });
  });

  test("maps assistant with mixed content → assistant_message + individual events", () => {
    const events = collect({
      type: "assistant",
      session_id: "sess-1",
      message: {
        id: "msg-004",
        model: "sonnet",
        stop_reason: "tool_use",
        usage: { input_tokens: 50, output_tokens: 50 },
        content: [
          { type: "text", text: "Let me read that file." },
          { type: "tool_use", id: "tu-002", name: "Read", input: { file_path: "/tmp/a.ts" } },
        ],
      },
    });

    expect(events).toHaveLength(3);
    expect(events[0]!.type).toBe("assistant_message");
    expect(events[1]!.type).toBe("text_complete");
    expect(events[2]!.type).toBe("tool_start");
  });

  // --- Result messages ---

  test("maps result success → session_complete with modelUsage", () => {
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
      duration_api_ms: 3000,
      num_turns: 2,
      total_cost_usd: 0.015,
      modelUsage: {
        "claude-sonnet-4-20250514": {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 200,
          cacheCreationInputTokens: 50,
          webSearchRequests: 0,
          costUSD: 0.015,
          contextWindow: 200000,
          maxOutputTokens: 16384,
        },
      },
    });

    expect(events).toEqual([
      {
        type: "session_complete",
        subtype: "success",
        result: "Task completed",
        structuredOutput: { key: "value" },
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 200,
          cacheCreationTokens: 50,
        },
        durationMs: 3500,
        durationApiMs: 3000,
        numTurns: 2,
        costUsd: 0.015,
        modelUsage: {
          "claude-sonnet-4-20250514": {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadTokens: 200,
            cacheCreationTokens: 50,
            webSearchRequests: 0,
            costUsd: 0.015,
            contextWindow: 200000,
            maxOutputTokens: 16384,
          },
        },
        errors: undefined,
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
      subtype: "error_max_turns",
      result: "Partial result",
      structuredOutput: undefined,
      usage: {
        inputTokens: 500,
        outputTokens: 200,
        cacheReadTokens: undefined,
        cacheCreationTokens: undefined,
      },
      durationMs: 2000,
      durationApiMs: undefined,
      numTurns: 5,
      costUsd: undefined,
      modelUsage: undefined,
      errors: ["Max turns exceeded"],
    });

    expect(events[1]).toEqual({
      type: "error",
      message: "Max turns exceeded",
      code: "error_max_turns",
      recoverable: false,
    });
  });

  // --- Tool progress / summary ---

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

  // --- Auth status ---

  test("maps auth_status → auth_status", () => {
    const events = collect({
      type: "auth_status",
      isAuthenticating: true,
      output: ["Opening browser..."],
      error: undefined,
    });

    expect(events).toEqual([
      {
        type: "auth_status",
        isAuthenticating: true,
        output: ["Opening browser..."],
        error: undefined,
      },
    ]);
  });

  // --- Raw / edge cases ---

  test("includes raw event when includeRaw is true", () => {
    const msg = { type: "system", subtype: "init", session_id: "s-1" };
    const events = collect(msg, true);

    expect(events[0]).toEqual({
      type: "raw",
      provider: "claude",
      eventType: "system",
      data: msg,
    });
    expect(events[1]!.type).toBe("session_init");
  });

  test("ignores unknown message types gracefully", () => {
    const events = collect({ type: "unknown_future_type", foo: "bar" });
    expect(events).toEqual([]);
  });
});

describe("createClaudeSession", () => {
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

  test("sdkVersion: 'v2' forces V2 even with V1-only options", () => {
    const session = createClaudeSession({
      model: "haiku",
      sdkVersion: "v2",
      cwd: "/tmp",
      maxTurns: 3,
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
