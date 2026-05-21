import { describe, it, expect } from "vitest";
import { extractHandoff, buildPickupDraft } from "./handoff-extractor.js";

// Helper to build a minimal valid messageHistory entry
function userMsg(content: string, ts = 1_000_000): unknown {
  return { type: "user_message", content, timestamp: ts };
}
function assistantTextMsg(text: string, ts = 1_000_001): unknown {
  return {
    type: "assistant",
    timestamp: ts,
    message: { content: [{ type: "text", text }] },
  };
}
function assistantWithImage(text: string, ts = 1_000_002): unknown {
  return {
    type: "assistant",
    timestamp: ts,
    message: {
      content: [
        { type: "text", text },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA…" } },
      ],
    },
  };
}
function assistantToolUse(name: string, input: unknown, ts = 1_000_003): unknown {
  return {
    type: "assistant",
    timestamp: ts,
    message: { content: [{ type: "tool_use", name, input }] },
  };
}
function toolResultMsg(text: string, isErr = false, ts = 1_000_004): unknown {
  return {
    type: "user",
    timestamp: ts,
    message: {
      content: [{ type: "tool_result", content: text, is_error: isErr }],
    },
  };
}
function imageLimitError(ts = 1_000_005): unknown {
  return {
    type: "result",
    timestamp: ts,
    data: {
      is_error: true,
      api_error_status: 400,
      result: "An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.",
    },
  };
}

describe("extractHandoff", () => {
  it("produces a markdown header with session metadata", () => {
    const { markdown, meta } = extractHandoff({
      sessionId: "deadbeef-1234-5678-9abc-def012345678",
      messageHistory: [userMsg("hello")],
      cwd: "/tmp/myproject",
      backend: "claude",
    });
    expect(markdown).toContain("# Handoff brief — session deadbeef");
    expect(markdown).toContain("cwd: /tmp/myproject");
    expect(markdown).toContain("backend: claude");
    expect(markdown).toContain("Total messages: 1 (1 user turns)");
    expect(meta.totalMessages).toBe(1);
    expect(meta.userTurns).toBe(1);
    expect(meta.hasImageError).toBe(false);
  });

  it("renders user text turns under ### USER headers", () => {
    const { markdown } = extractHandoff({
      sessionId: "s1",
      messageHistory: [userMsg("first thing"), userMsg("second thing", 1_000_500)],
    });
    expect(markdown).toContain("### USER");
    expect(markdown).toContain("first thing");
    expect(markdown).toContain("second thing");
  });

  it("renders assistant text content under ### ASSISTANT headers", () => {
    const { markdown } = extractHandoff({
      sessionId: "s1",
      messageHistory: [assistantTextMsg("agent reply text")],
    });
    expect(markdown).toContain("### ASSISTANT");
    expect(markdown).toContain("agent reply text");
  });

  it("replaces image content blocks with [image stripped] (the whole point)", () => {
    // This is the core invariant — if we ever stop stripping images, sessions
    // with the 2000px-limit wedge will silently re-poison the new session
    // when the handoff is re-read.
    const { markdown } = extractHandoff({
      sessionId: "s1",
      messageHistory: [assistantWithImage("see this:")],
    });
    expect(markdown).toContain("see this:");
    expect(markdown).toContain("[image stripped]");
    expect(markdown).not.toContain("base64");
    expect(markdown).not.toContain("AAA…"); // the fake base64 payload
  });

  it("formats tool_use as a compact one-line arrow with trimmed input", () => {
    const longInput = { command: "x".repeat(500), description: "ls everything" };
    const { markdown } = extractHandoff({
      sessionId: "s1",
      messageHistory: [assistantToolUse("Bash", longInput)],
    });
    expect(markdown).toContain("→ TOOL Bash(");
    expect(markdown).toContain("…[+"); // trim marker present
  });

  it("renders tool_result with ← OK / ← ERR prefix and trims long bodies", () => {
    const longBody = "y".repeat(800);
    const { markdown } = extractHandoff({
      sessionId: "s1",
      messageHistory: [toolResultMsg(longBody, false), toolResultMsg("boom", true)],
    });
    expect(markdown).toContain("← OK");
    expect(markdown).toContain("← ERR");
    expect(markdown).toContain("boom");
    expect(markdown).toContain("…[+"); // long body trimmed
  });

  it("flags image-limit API errors via API_ERROR section + meta.hasImageError", () => {
    const { markdown, meta } = extractHandoff({
      sessionId: "s1",
      messageHistory: [userMsg("here's an image"), imageLimitError()],
    });
    expect(markdown).toContain("### API_ERROR");
    expect(markdown).toContain("status=400");
    expect(markdown).toContain("dimension limit");
    expect(meta.hasImageError).toBe(true);
  });

  it("uses image-limit reason by default when hasImageError is detected", () => {
    const { markdown } = extractHandoff({
      sessionId: "s1",
      messageHistory: [imageLimitError()],
    });
    expect(markdown).toContain("Reason: prior session wedged on Anthropic 2000px multi-image limit");
  });

  it("uses generic reason when no image error and none provided", () => {
    const { markdown } = extractHandoff({
      sessionId: "s1",
      messageHistory: [userMsg("hi")],
    });
    expect(markdown).toContain("Reason: session handoff requested");
  });

  it("honours an explicit reason override", () => {
    const { markdown } = extractHandoff({
      sessionId: "s1",
      messageHistory: [userMsg("hi")],
      reason: "manual archive",
    });
    expect(markdown).toContain("Reason: manual archive");
  });

  it("skips unknown / non-renderable entry types silently", () => {
    const { markdown } = extractHandoff({
      sessionId: "s1",
      messageHistory: [
        { type: "keep_alive" },
        { type: "stream_event", event: {} },
        userMsg("real text"),
        null, // robust against junk
        "not an object",
        { type: "result", data: { is_error: false } }, // non-error result is silent
      ],
    });
    expect(markdown).toContain("real text");
    expect(markdown).not.toContain("keep_alive");
    expect(markdown).not.toContain("stream_event");
  });

  it("uses ?? fallbacks for missing cwd / backend / timestamp without crashing", () => {
    const { markdown } = extractHandoff({
      sessionId: "s1",
      messageHistory: [{ type: "user_message", content: "no ts" }],
    });
    expect(markdown).toContain("cwd: ?");
    expect(markdown).toContain("backend: ?");
    expect(markdown).toContain("### USER  ??");
  });
});

describe("buildPickupDraft", () => {
  it("references the handoff filename and asks for a structured summary", () => {
    const draft = buildPickupDraft(".aura-handoff-2026-05-21T013747.md");
    expect(draft).toContain(".aura-handoff-2026-05-21T013747.md");
    expect(draft).toContain("5-10-строчный summary");
    expect(draft).toContain("Где остановились");
  });
});
