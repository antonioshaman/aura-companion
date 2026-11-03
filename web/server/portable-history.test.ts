import { describe, expect, it } from "vitest";
import { archiveMarkdown, continuationDraft, createPortableArchive, MAX_ARCHIVE_BYTES, MAX_DRAFT_BYTES, MAX_DEPTH, parsePortableArchive, PortableHistoryError } from "./portable-history.js";

// Both CLI adapters ultimately expose browser histories, including legacy direct content.
const sources = () => [
  { id: "claude-1", project: "alpha", backend: "claude" as const, model: "sonnet", messageHistory: [
    { type: "user_message", content: "Investigate", timestamp: 100 },
    { type: "assistant", streamStatus: "interrupted", message: { content: [
      { type: "tool_use", id: "t1", name: "custom-tool", input: { access_token: "private", nested: { password: "secretValue123456" } } },
      { type: "tool_result", tool_use_id: "t1", content: "FULL-" + "x".repeat(1500) + "-END" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "a".repeat(64) } },
      { type: "future", text: "not supported" },
      { type: "image", source: { type: "url", url: "https://example.test/image" } },
    ] } },
    { type: "permission_request", request: { command: "rm -rf /", permission: true } },
  ] },
  { id: "codex-1", project: "beta", backend: "codex" as const, messageHistory: [
    { type: "user", content: "continue" },
    { type: "assistant", message: { content: [{ type: "text", text: "sk-proj-1234567890abcdefghijklmno" }] } },
    { type: "result", data: { result: "Agent failed", is_error: true, env: { TOKEN: "unsafe" } } },
  ] },
];

describe("portable history", () => {
  it("preserves both histories, complete tool output and binary bytes while excluding runtime state (AC1–3)", () => {
    const original = sources();
    const snapshot = JSON.stringify(original);
    const archive = createPortableArchive(original);
    expect(archive.sessions.map(s => [s.id, s.project, s.backend])).toEqual([["claude-1", "alpha", "claude"], ["codex-1", "beta", "codex"]]);
    expect(archive.sessions[0].messages[1].streamStatus).toBe("interrupted");
    const json = JSON.stringify(archive);
    expect(json).toContain("FULL-" + "x".repeat(1500) + "-END");
    expect(json).toContain("a".repeat(64)); // Binary can resemble a secret hash; never redact attachment bytes.
    expect(json).not.toContain("secretValue123456");
    expect(json).not.toContain('"private"');
    expect(json).not.toContain("1234567890abcdefghijklmno");
    expect(json).not.toContain("rm -rf");
    expect(json).not.toContain('"env"');
    expect(archive.exclusions.join(" ")).toMatch(/unsupported.*future/i);
    expect(archive.exclusions.join(" ")).toMatch(/external/i);
    expect(archive.exclusions.join(" ")).toMatch(/binary.*review/i);
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(parsePortableArchive(JSON.parse(json))).toEqual(archive);
  });

  it("downloads full readable evidence independently of bounded context (AC7,10)", () => {
    const archive = createPortableArchive(sources());
    const markdown = archiveMarkdown(archive);
    expect(markdown).toContain("alpha");
    expect(markdown).toContain("claude");
    expect(markdown).toContain("interrupted");
    expect(markdown).toContain("FULL-" + "x".repeat(1500) + "-END");
    expect(markdown).toContain("unknown"); // Legacy stream completion is not inferred.
    const draft = continuationDraft(archive, "claude-1");
    expect(draft.text).toContain("historical");
    expect(draft.text).not.toContain("a".repeat(64));
    expect(draft.omittedAttachments).toBe(1);
  });

  it("strictly caps UTF-8 even for one huge final message without truncating the archive (AC7)", () => {
    const content = "🙂".repeat(15000) + "FINAL-SENTINEL";
    const archive = createPortableArchive([{ id: "large", project: "large", backend: "codex", messageHistory: [{ type: "user_message", content }] }]);
    const draft = continuationDraft(archive, "large");
    expect(Buffer.byteLength(draft.text)).toBeLessThanOrEqual(MAX_DRAFT_BYTES);
    expect(draft.truncated).toBe(true);
    expect(draft.text).toContain("truncated");
    expect(draft.text).not.toContain("�");
    expect(draft.text).toContain("FINAL-SENTINEL"); // Tail of a huge final message survives too.
    expect(archiveMarkdown(archive)).toContain("FINAL-SENTINEL");
  });

  it("revalidates and redacts imported metadata and nested secret fields (AC3,5)", () => {
    const raw = createPortableArchive(sources());
    raw.sessions[0].project = "OPENAI_API_KEY=secretValue123456";
    raw.sessions[0].messages[0].content = { nested: { access_token: "any-value" } };
    const clean = parsePortableArchive(raw);
    expect(JSON.stringify(clean)).not.toContain("secretValue123456");
    expect(JSON.stringify(clean)).not.toContain("any-value");
    expect(raw.sessions[0].project).toContain("secretValue123456");
  });

  it("retains earliest setup and the newest user goal after a huge first message (AC7)", () => {
    const archive = createPortableArchive([{ id: "context", project: "p", backend: "claude", messageHistory: [
      { type: "user_message", content: "EARLIEST-SETUP\n" + "🙂".repeat(15000) },
      { type: "assistant", message: { content: [{ type: "text", text: "intermediate" }] } },
      { type: "user_message", content: "LATEST-GOAL: repair the import boundary" },
    ] }]);
    const draft = continuationDraft(archive, "context");
    expect(draft.text).toContain("EARLIEST-SETUP");
    expect(draft.text).toContain("LATEST-GOAL");
    expect(draft.text).toContain("truncated");
    expect(draft.omittedMessages).toBe(1); // The partial first message is the only incomplete one.
    expect(Buffer.byteLength(draft.text)).toBeLessThanOrEqual(MAX_DRAFT_BYTES);
    expect(draft.text).not.toContain("�");
  });

  it("preserves arbitrary JSON evidence lacking a block type instead of silently emptying it (AC2)", () => {
    const archive = createPortableArchive([{ id: "json", project: "p", backend: "codex", messageHistory: [
      { type: "assistant", content: [{ custom: "valuable evidence", nested: { count: 7 } }] },
    ] }]);
    expect(archive.sessions[0].messages[0].content).toEqual([{ custom: "valuable evidence", nested: { count: 7 } }]);
  });

  it("fences hostile message and metadata literally with an unbreakable generated fence (AC10,11)", () => {
    const hostile = '<img src="https://example.test/track">\n![remote](https://example.test/image)\n``````\n<script>alert(1)</script>';
    const archive = createPortableArchive([{ id: "safe", project: hostile, model: hostile, backend: "claude", messageHistory: [{ type: "user_message", content: hostile }] }], [hostile]);
    const markdown = archiveMarkdown(archive);
    expect(markdown).toContain(hostile); // Literal bytes preserved, not stripped or escaped away.
    let fence = "";
    for (const line of markdown.split("\n")) {
      if (!fence && /^`{3,}$/.test(line)) fence = line;
      else if (line === fence) fence = "";
      else if (line.includes("<img") || line.includes("![remote]") || line.includes("<script>")) expect(fence.length).toBeGreaterThan(6);
    }
    expect(fence).toBe("");
  });

  it.each([
    ["version", (raw: Record<string, unknown>) => { raw.version = 99; }],
    ["unknown field", (raw: Record<string, unknown>) => { raw.env = {}; }],
    ["wrong session shape", (raw: Record<string, unknown>) => { raw.sessions = [null]; }],
    ["unsafe nested key", (raw: Record<string, unknown>) => { (raw.sessions as { messages: { content: unknown }[] }[])[0].messages[0].content = JSON.parse('{"constructor":{"prototype":{}}}'); }],
    ["bad binary", (raw: Record<string, unknown>) => { (raw.sessions as { messages: { content: unknown }[] }[])[0].messages[0].content = [{ type: "image", source: { type: "base64", media_type: "image/png", data: "not base64!" } }]; }],
  ])("rejects %s with a safe typed error (AC5)", (_, mutate) => {
    const raw = JSON.parse(JSON.stringify(createPortableArchive(sources()))) as Record<string, unknown>;
    mutate(raw);
    expect(() => parsePortableArchive(raw)).toThrow(PortableHistoryError);
  });

  it("rejects excessive nesting and bytes before walking/redacting contents (AC5)", () => {
    const raw = createPortableArchive(sources());
    let deep: unknown = "leaf";
    for (let i = 0; i <= MAX_DEPTH; i++) deep = { child: deep };
    raw.sessions[0].messages[0].content = deep as never;
    expect(() => parsePortableArchive(raw)).toThrow(PortableHistoryError);
    expect(() => parsePortableArchive("x".repeat(MAX_ARCHIVE_BYTES + 1))).toThrow(PortableHistoryError);
  });
});
