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

describe("extractHandoff — secret redaction", () => {
  // The brief lands in the user's workspace (0644, may be committed), so a
  // credential pasted into chat must be masked. SYNTHETIC npm-shaped value.
  it("masks secrets from user text and tool results", () => {
    const fake = "npm_" + "aB3dE5gH7jK9mN1pQ".repeat(3).slice(0, 36);
    const { markdown } = extractHandoff({
      sessionId: "s-secret",
      messageHistory: [userMsg(`publish with ${fake}`), toolResultMsg(`NPM_TOKEN=${fake}`)],
    });
    expect(markdown).not.toContain(fake);
    expect(markdown).toContain("npm_[REDACTED]");
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

// ── Context-overflow handoff ────────────────────────────────────────────────
// A >10 MB session stopped answering; the user continues in a new session.
// The brief must lead with the live ask + plan (not 10 MB of transcript),
// stay readable (head/tail cap) and keep masking secrets.
describe("extractHandoff — Current task section", () => {
  function todoWrite(todos: Array<{ content: string; status: string }>, ts: number): unknown {
    return { type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", name: "TodoWrite", input: { todos } }] } };
  }

  it("puts the last 5 user messages verbatim at the top, before the transcript", () => {
    const history = Array.from({ length: 7 }, (_, i) => userMsg(`ask number ${i + 1}`, 1_000_000 + i));
    const { markdown } = extractHandoff({ sessionId: "s1", messageHistory: history });
    const top = markdown.indexOf("## Current task (read this first)");
    const transcript = markdown.indexOf("## Transcript");
    expect(top).toBeGreaterThan(-1);
    expect(transcript).toBeGreaterThan(top);
    const section = markdown.slice(top, transcript);
    // Only the latest five, oldest first; the first two are transcript-only.
    expect(section).toContain("last 5 of 7");
    expect(section).not.toContain("ask number 2");
    for (const n of [3, 4, 5, 6, 7]) expect(section).toContain(`ask number ${n}`);
    expect(section.indexOf("ask number 3")).toBeLessThan(section.indexOf("ask number 7"));
  });

  it("renders the LATEST TodoWrite list with per-item status", () => {
    const { markdown } = extractHandoff({
      sessionId: "s1",
      messageHistory: [
        todoWrite([{ content: "old plan", status: "pending" }], 1),
        todoWrite(
          [
            { content: "write migration", status: "completed" },
            { content: "update API", status: "in_progress" },
            { content: "ship it", status: "pending" },
          ],
          2,
        ),
      ],
    });
    const section = markdown.slice(0, markdown.indexOf("## Transcript"));
    expect(section).toContain("- [x] write migration (completed)");
    expect(section).toContain("- [~] update API (in_progress)");
    expect(section).toContain("- [ ] ship it (pending)");
    expect(section).not.toContain("old plan");
  });

  it("says so explicitly when there is no todo list or no user message", () => {
    const { markdown } = extractHandoff({ sessionId: "s1", messageHistory: [assistantTextMsg("hi")] });
    expect(markdown).toContain("_No TodoWrite list in this session._");
    expect(markdown).toContain("_No user messages in this session._");
  });

  it("redacts secrets inside the Current task section too", () => {
    const fake = "npm_" + "aB3dE5gH7jK9mN1pQ".repeat(3).slice(0, 36);
    const { markdown } = extractHandoff({ sessionId: "s1", messageHistory: [userMsg(`token ${fake}`)] });
    expect(markdown).not.toContain(fake);
    const section = markdown.slice(0, markdown.indexOf("## Transcript"));
    expect(section).toContain("npm_[REDACTED]");
  });

  it("renders block-array user messages (images stripped) in the section", () => {
    const { markdown } = extractHandoff({
      sessionId: "s1",
      messageHistory: [
        { type: "user_message", timestamp: 1, content: [{ type: "text", text: "see screenshot" }, { type: "image" }] },
      ],
    });
    const section = markdown.slice(0, markdown.indexOf("## Transcript"));
    expect(section).toContain("see screenshot");
    expect(section).toContain("[image stripped]");
  });
});

describe("extractHandoff — transcript cap", () => {
  it("keeps the full transcript when it fits the budget", () => {
    const { markdown, meta } = extractHandoff({ sessionId: "s1", messageHistory: [userMsg("a"), assistantTextMsg("b")] });
    expect(meta.omittedMessages).toBe(0);
    expect(markdown).not.toContain("messages omitted");
  });

  it("keeps head + tail and marks the omitted middle explicitly", () => {
    // 100 assistant turns of ~1 KB each; budget = ~3 KB head + ~5 KB tail.
    const history = Array.from({ length: 100 }, (_, i) => assistantTextMsg(`turn-${i}-` + "x".repeat(1000), 2_000_000 + i));
    const { markdown, meta } = extractHandoff({
      sessionId: "s1",
      messageHistory: history,
      transcriptHeadBytes: 3_000,
      transcriptTailBytes: 5_000,
    });
    expect(meta.omittedMessages).toBeGreaterThan(80);
    expect(markdown).toMatch(new RegExp(`\\[… ${meta.omittedMessages} messages omitted \\(~\\d+ KB\\)`));
    // Start of the conversation and where it stopped are both kept.
    expect(markdown).toContain("turn-0-");
    expect(markdown).toContain("turn-99-");
    expect(markdown).not.toContain("turn-50-");
    expect(markdown.indexOf("turn-0-")).toBeLessThan(markdown.indexOf("messages omitted"));
    expect(markdown.indexOf("messages omitted")).toBeLessThan(markdown.indexOf("turn-99-"));
    expect(markdown).toContain("## Transcript (capped");
  });

  it("always keeps the last entry even if it alone exceeds the tail budget", () => {
    const history = [userMsg("first"), assistantTextMsg("middle " + "m".repeat(5_000)), assistantTextMsg("LAST " + "z".repeat(5_000))];
    const { markdown, meta } = extractHandoff({
      sessionId: "s1",
      messageHistory: history,
      transcriptHeadBytes: 100,
      transcriptTailBytes: 100,
    });
    expect(meta.omittedMessages).toBe(1);
    expect(markdown).toContain("LAST ");
    expect(markdown).toContain("first");
  });
});

describe("extractHandoff / buildPickupDraft — reasons", () => {
  it("context_too_large: reason line quotes the transcript size", () => {
    const { markdown } = extractHandoff({ sessionId: "s1", messageHistory: [], reason: "context_too_large", contextBytes: 10_000_000 });
    expect(markdown).toContain("Reason: prior session's context overflowed (>10 MB)");
  });

  it("context_too_large without a size still reads well", () => {
    const { markdown } = extractHandoff({ sessionId: "s1", messageHistory: [], reason: "context_too_large" });
    expect(markdown).toContain("Reason: prior session's context overflowed and it stopped");
  });

  it("image_limit code maps to the image-limit wording", () => {
    const { markdown } = extractHandoff({ sessionId: "s1", messageHistory: [], reason: "image_limit" });
    expect(markdown).toContain("Reason: prior session wedged on Anthropic 2000px multi-image limit");
  });

  it("pickup draft for context_too_large talks about the overflow, not the image limit", () => {
    const draft = buildPickupDraft(".aura-handoff-x.md", "context_too_large", { contextBytes: 5_000_000 });
    expect(draft).toContain("контекст переполнился (>5 MB)");
    expect(draft).toContain(".aura-handoff-x.md");
    expect(draft).toContain("Current task");
    expect(draft).toContain("Где остановились");
    expect(draft).toContain("Что было следующим шагом");
    expect(draft).toContain("открытые вопросы");
    // Unlike the generic draft, it tells the agent to carry on with the task.
    expect(draft).toContain("продолжай задачу");
    expect(draft).not.toContain("2000px");
  });

  it("pickup draft keeps the image-limit wording only for that reason", () => {
    expect(buildPickupDraft("f.md", "image_limit")).toContain("2000px image-limit");
    expect(buildPickupDraft("f.md")).not.toContain("2000px");
    expect(buildPickupDraft("f.md", "something else")).not.toContain("2000px");
  });

  it("formats sub-10 MB sizes with one decimal", () => {
    expect(buildPickupDraft("f.md", "context_too_large", { contextBytes: 1_500_000 })).toContain("(>1.5 MB)");
  });
});
