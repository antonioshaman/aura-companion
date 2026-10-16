import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CodexTurnUsageAccumulator, normalizeCodexUsage } from "./codex-turn-usage.js";

// W6 — every Codex turn used to log `llm.turn_usage` with all-zero counters
// because the synthesized result frame hard-coded usage {0,0,0,0}. These tests
// pin how real usage is derived from `thread/tokenUsage/updated` notifications.
//
// The replay fixtures are real inbound frames (see
// __fixtures__/codex-token-usage/README.md). The expected numbers in the README
// were computed independently of this code (delta of the cumulative `total`),
// so a pass here means the per-request `last` accumulation + de-dup logic
// agrees with Codex's own running totals on real wire data.

const FIXTURES = join(import.meta.dirname, "__fixtures__", "codex-token-usage");

/** Replay a fixture through the accumulator; returns usage per completed turn (in order). */
function replay(file: string) {
  const acc = new CodexTurnUsageAccumulator();
  const completed: Array<{ turnId: string; usage: ReturnType<CodexTurnUsageAccumulator["takeForTurn"]> }> = [];
  for (const line of readFileSync(join(FIXTURES, file), "utf8").split("\n")) {
    if (!line) continue;
    const rec = JSON.parse(line) as { _header?: boolean; raw?: string };
    if (rec._header || !rec.raw) continue;
    const msg = JSON.parse(rec.raw) as { method: string; params: Record<string, unknown> };
    if (msg.method === "thread/tokenUsage/updated") acc.onTokenUsage(msg.params);
    if (msg.method === "turn/completed") {
      const turnId = (msg.params.turn as { id: string }).id;
      completed.push({ turnId, usage: acc.takeForTurn(turnId, msg.params.threadId as string) });
    }
  }
  return completed;
}

describe("normalizeCodexUsage — Codex → Claude-shaped accounting", () => {
  it("splits Codex inputTokens (which INCLUDES cached) into uncached + cache_read", () => {
    // Claude reports input_tokens EXCLUDING cache reads/writes; Codex's
    // inputTokens is the whole prompt. Normalising keeps the invariant
    // prompt = input + cache_read + cache_creation across backends.
    expect(normalizeCodexUsage({ inputTokens: 36267, cachedInputTokens: 33280, cacheWriteInputTokens: 0, outputTokens: 91 }))
      .toEqual({ input_tokens: 2987, cache_read_input_tokens: 33280, cache_creation_input_tokens: 0, output_tokens: 91 });
  });

  it("maps cacheWriteInputTokens to cache_creation and never goes negative", () => {
    expect(normalizeCodexUsage({ inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 30, outputTokens: 5 }))
      .toEqual({ input_tokens: 10, cache_read_input_tokens: 60, cache_creation_input_tokens: 30, output_tokens: 5 });
    // Defensive: inconsistent counters clamp to 0 rather than logging a negative.
    expect(normalizeCodexUsage({ inputTokens: 10, cachedInputTokens: 60, outputTokens: 1 }).input_tokens).toBe(0);
  });
});

describe("CodexTurnUsageAccumulator — replay of real recordings (session 17fbf63f)", () => {
  it("9d4486: duplicated frames and a resume replay of the previous turn are not double-counted", () => {
    const turns = replay("17fbf63f-9d4486.jsonl");
    // The recording carries turn/completed twice for the same turn; the first
    // gets the usage, the duplicate gets nothing (so it is flagged zero-usage
    // rather than counted twice).
    expect(turns).toHaveLength(2);
    expect(turns[0].turnId.endsWith("af1b0f1a")).toBe(true);
    expect(turns[0].usage).toEqual({
      input_tokens: 36267 - 33280,
      cache_read_input_tokens: 33280,
      cache_creation_input_tokens: 0,
      output_tokens: 91,
    });
    expect(turns[1].usage).toBeNull();
  });

  it("cfdb84: two model requests inside one turn are summed (each notification sent twice)", () => {
    const turns = replay("17fbf63f-cfdb84.jsonl");
    expect(turns[0].usage).toEqual({
      input_tokens: 151391 - 76544,
      cache_read_input_tokens: 76544,
      cache_creation_input_tokens: 0,
      output_tokens: 77,
    });
  });

  it("d3d489: a duplicate usage frame arriving after turn/completed is ignored", () => {
    const turns = replay("17fbf63f-d3d489.jsonl");
    expect(turns).toHaveLength(1);
    expect(turns[0].usage).toEqual({
      input_tokens: 142813 - 72448,
      cache_read_input_tokens: 72448,
      cache_creation_input_tokens: 0,
      output_tokens: 203,
    });
  });

  it("exposes the last request's full prompt size as the resident context", () => {
    // Used for the cache-rewrite estimate in the UI: what would have to be
    // written again if the cache expired = the last prompt, cached or not.
    const acc = new CodexTurnUsageAccumulator();
    acc.onTokenUsage({
      turnId: "t1",
      tokenUsage: {
        total: { totalTokens: 1000, inputTokens: 900, cachedInputTokens: 0, outputTokens: 100 },
        last: { totalTokens: 1000, inputTokens: 900, cachedInputTokens: 0, outputTokens: 100 },
      },
    });
    expect(acc.lastPromptTokensFor(undefined)).toBe(900);
  });

  it("a turn with no usage notification (e.g. interrupted before any request) yields null", () => {
    const acc = new CodexTurnUsageAccumulator();
    expect(acc.takeForTurn("never-seen", "main")).toBeNull();
  });
});

// Review fix (PR #365 STOP): collab subagent threads send their OWN
// thread/tokenUsage/updated with their own cumulative `total`. A single
// thread-agnostic accumulator let them wipe the main turn's bucket and
// corrupt the duplicate detector (lost usage / double counting). State is
// now keyed by threadId and a turn's usage is claimed per (thread, turn).
describe("CodexTurnUsageAccumulator — multi-thread (main + collab subagent)", () => {
  const frame = (threadId: string, turnId: string, total: number, inputTokens: number, cachedInputTokens: number, outputTokens: number) => ({
    threadId,
    turnId,
    tokenUsage: {
      total: { totalTokens: total },
      last: { inputTokens, cachedInputTokens, outputTokens },
    },
  });

  it("interleaved main/subagent frames with duplicates: main turn gets exactly its own requests", () => {
    const acc = new CodexTurnUsageAccumulator();
    acc.onTokenUsage(frame("main", "t1", 1000, 900, 500, 100));
    acc.onTokenUsage(frame("sub", "s1", 400, 380, 0, 20));
    acc.onTokenUsage(frame("main", "t1", 1000, 900, 500, 100)); // dup of main#1 after a sub frame
    acc.onTokenUsage(frame("sub", "s1", 400, 380, 0, 20)); // dup of sub#1
    acc.onTokenUsage(frame("sub", "s1", 900, 480, 300, 20));
    acc.onTokenUsage(frame("main", "t1", 2200, 1100, 800, 100));
    acc.onTokenUsage(frame("main", "t1", 2200, 1100, 800, 100)); // dup

    expect(acc.takeForTurn("t1", "main")).toEqual({
      input_tokens: (900 - 500) + (1100 - 800),
      cache_read_input_tokens: 1300,
      cache_creation_input_tokens: 0,
      output_tokens: 200,
    });
    // Subagent usage stays attributable to its own thread/turn, never the main result.
    expect(acc.takeForTurn("s1", "sub")).toEqual({
      input_tokens: 380 + (480 - 300),
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 0,
      output_tokens: 40,
    });
  });

  it("a subagent turn id never claims the main thread's bucket", () => {
    const acc = new CodexTurnUsageAccumulator();
    acc.onTokenUsage(frame("main", "t1", 1000, 900, 500, 100));
    expect(acc.takeForTurn("t1", "sub")).toBeNull();
    expect(acc.takeForTurn("t1", "main")).not.toBeNull();
  });

  it("lastPromptTokensFor reports per thread", () => {
    const acc = new CodexTurnUsageAccumulator();
    acc.onTokenUsage(frame("main", "t1", 1000, 900, 500, 100));
    acc.onTokenUsage(frame("sub", "s1", 400, 380, 0, 20));
    expect(acc.lastPromptTokensFor("main")).toBe(900);
    expect(acc.lastPromptTokensFor("sub")).toBe(380);
  });
});
