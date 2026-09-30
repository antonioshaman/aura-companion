/**
 * Tests for the bench's Claude OAuth handling (P6/FIX-D2-CLAUDE-AUTH).
 *
 * Incident 2026-09-30: the bench held a COPY of prod's `.credentials.json`;
 * a bench Claude CLI refreshed it, spent prod's single-use refresh token, and
 * prod's login died. Validates, on fake tokens only:
 *   - the incident itself, replayed against a fake OAuth server with
 *     single-use refresh tokens: with a credentials COPY in the cell config
 *     (pre-fix) prod's next refresh fails; with the fixed naked-A runner (bare
 *     access token in env, empty config dir) the fake CLI has nothing to
 *     refresh and prod's refresh succeeds;
 *   - readClaudeAccessToken returns only access token + expiry (fail-closed on
 *     missing / malformed files), never the refresh token;
 *   - claudeTokenGate: ok only when the token outlives the cell + margin;
 *     expiring → hold (prod refreshes it itself), unreadable → fatal;
 *   - quarantineClaudeCredentialCopies moves (never deletes) every copy under
 *     the bench root, skips symlinks / node_modules / the quarantine dir, and
 *     never touches the real file.
 */

import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_CREDENTIALS_FILE,
  CLAUDE_TOKEN_ENV,
  TOKEN_MARGIN_MS,
  claudeCredentialCopyEvidence,
  claudeTokenGate,
  quarantineClaudeCredentialCopies,
  readClaudeAccessToken,
} from "./claude-auth.js";
import { nakedClaudeRunner, type NakedDeps } from "./naked-agents.js";
import { VARIANTS } from "./variants.js";
import type { AuraBenchTask } from "../task.js";
import type { SpawnOptions, SpawnResult } from "./proc.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const creds = (at: string, rt: string, expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: at, refreshToken: rt, expiresAt } });

/** Fake OAuth server: refresh tokens are single-use, like Anthropic's. */
function fakeOAuth(initialRt: string) {
  const live = new Set([initialRt]);
  let n = 0;
  return {
    refresh(rt: string): { at: string; rt: string } | null {
      if (!live.delete(rt)) return null; // spent or unknown → "could not be refreshed"
      n++;
      const next = { at: `at-${n}`, rt: `rt-${n}` };
      live.add(next.rt);
      return next;
    },
  };
}

/**
 * Fake Claude CLI: with a credentials file in CLAUDE_CONFIG_DIR it refreshes
 * (as the real CLI did at 03:03) and writes the new pair into THAT file; with
 * only CLAUDE_CODE_OAUTH_TOKEN it just uses the token.
 */
function fakeClaudeSpawn(server: ReturnType<typeof fakeOAuth>, seen: { env?: Record<string, string> }) {
  return async (_cmd: string, _args: string[], o: SpawnOptions): Promise<SpawnResult> => {
    seen.env = o.env;
    const file = join(o.env!.CLAUDE_CONFIG_DIR!, CLAUDE_CREDENTIALS_FILE);
    if (existsSync(file)) {
      const c = JSON.parse(readFileSync(file, "utf8")).claudeAiOauth;
      const next = server.refresh(c.refreshToken);
      if (next) writeFileSync(file, creds(next.at, next.rt, Date.now() + 8 * 3600_000));
    }
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", model: "m", skills: [], plugins: [], mcp_servers: [], memory_paths: {} }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ].join("\n");
    return { code: 0, output: "", stdout, stderr: "", timedOut: false };
  };
}

function nakedDeps(realClaudeDir: string, spawn: NakedDeps["spawn"], prepareClaudeConfig: NakedDeps["prepareClaudeConfig"]): NakedDeps {
  return {
    spawn,
    env: (e) => ({ PATH: "/bin", ...e }),
    realClaudeDir,
    realCodexDir: "/nonexistent",
    userSkillNames: () => [],
    prepareClaudeConfig,
    claudeAccessToken: () => {
      const r = readClaudeAccessToken(realClaudeDir);
      if (!r.ok) throw new Error(r.reason);
      return r.accessToken;
    },
    present: () => false,
    now: () => 0,
  };
}

describe("incident replay: a bench refresh must never spend prod's refresh token", () => {
  const task = { id: "t1", prompt: "x" } as AuraBenchTask;

  function world() {
    const real = tmp("aurabench-realclaude-");
    writeFileSync(join(real, CLAUDE_CREDENTIALS_FILE), creds("at-0", "rt-0", Date.now() + 8 * 3600_000));
    const artifactDir = tmp("aurabench-cell-");
    return { real, artifactDir, server: fakeOAuth("rt-0"), ctx: { task, variant: VARIANTS.A, worktree: "/wt", timeoutMs: 1000, artifactDir } };
  }
  const prodRefresh = (real: string, server: ReturnType<typeof fakeOAuth>) =>
    server.refresh(JSON.parse(readFileSync(join(real, CLAUDE_CREDENTIALS_FILE), "utf8")).claudeAiOauth.refreshToken);

  it("control: a credentials COPY in the cell (pre-fix harness) logs prod out", async () => {
    const w = world();
    const copyIn = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, CLAUDE_CREDENTIALS_FILE), readFileSync(join(w.real, CLAUDE_CREDENTIALS_FILE)));
    };
    await nakedClaudeRunner(nakedDeps(w.real, fakeClaudeSpawn(w.server, {}), copyIn))(w.ctx);
    // The copy rotated; prod's refresh token is spent.
    expect(prodRefresh(w.real, w.server)).toBeNull();
  });

  it("fixed: the cell gets only the access token, prod's refresh still works", async () => {
    const w = world();
    const before = readFileSync(join(w.real, CLAUDE_CREDENTIALS_FILE), "utf8");
    const seen: { env?: Record<string, string> } = {};
    const r = await nakedClaudeRunner(nakedDeps(w.real, fakeClaudeSpawn(w.server, seen), (dir) => mkdirSync(dir, { recursive: true })))(w.ctx);
    expect(seen.env?.[CLAUDE_TOKEN_ENV]).toBe("at-0");
    expect(JSON.stringify(seen.env)).not.toContain("rt-0");
    expect(r).toMatchObject({ kind: "done", status: "completed", isolation: { isolated: true, credential_copies: [] } });
    expect(readFileSync(join(w.real, CLAUDE_CREDENTIALS_FILE), "utf8")).toBe(before);
    expect(prodRefresh(w.real, w.server)).toEqual({ at: "at-1", rt: "rt-1" });
  });
});

describe("readClaudeAccessToken", () => {
  it("returns only the access token and expiry", () => {
    const dir = tmp("aurabench-cl-");
    writeFileSync(join(dir, CLAUDE_CREDENTIALS_FILE), creds("at-x", "rt-secret", 123));
    const r = readClaudeAccessToken(dir);
    expect(r).toEqual({ ok: true, accessToken: "at-x", expiresAt: 123 });
    expect(JSON.stringify(r)).not.toContain("rt-secret");
  });

  it("fails closed on a missing file, non-JSON, no access token or a bad expiry", () => {
    expect(readClaudeAccessToken(tmp("aurabench-cl-")).ok).toBe(false);
    const t = (text: string) => readClaudeAccessToken("/x", () => text);
    expect(t("not json").ok).toBe(false);
    expect(t("null").ok).toBe(false);
    expect(t('{"claudeAiOauth":{"accessToken":"  ","expiresAt":1}}').ok).toBe(false);
    expect(t('{"claudeAiOauth":{"accessToken":"a"}}').ok).toBe(false);
    expect(t('{"claudeAiOauth":{"accessToken":"a","expiresAt":"1"}}').ok).toBe(false);
  });
});

describe("claudeTokenGate", () => {
  const hour = 3600_000;
  const read = (expiresAt: number) => ({ ok: true as const, accessToken: "at", expiresAt });

  it("opens only when the token outlives the cell plus the margin", () => {
    expect(claudeTokenGate(read(hour + TOKEN_MARGIN_MS), hour, 0)).toEqual({ ok: true, accessToken: "at", expiresAt: hour + TOKEN_MARGIN_MS });
    const g = claudeTokenGate(read(hour + TOKEN_MARGIN_MS - 1), hour, 0);
    // Expiring soon is a hold, not fatal: prod refreshes its own token.
    expect(g).toMatchObject({ ok: false, fatal: false });
    expect(claudeTokenGate(read(0), hour, 5 * hour)).toMatchObject({ ok: false, fatal: false });
  });

  it("is fatal when no token can be read (prod logged out)", () => {
    expect(claudeTokenGate({ ok: false, reason: "gone" }, hour, 0)).toEqual({ ok: false, fatal: true, reason: "gone" });
  });
});

describe("quarantineClaudeCredentialCopies", () => {
  it("moves every copy under the roots, keeps content, skips symlinks and node_modules", () => {
    const root = tmp("aurabench-q-");
    const q = join(root, "claude-auth", "quarantine");
    const put = (rel: string) => {
      mkdirSync(join(root, rel), { recursive: true });
      writeFileSync(join(root, rel, CLAUDE_CREDENTIALS_FILE), `{"from":"${rel}"}`);
    };
    put("aura-home/.claude");
    put("cells/t1/A-1/claude-config");
    put("node_modules/pkg");
    const real = tmp("aurabench-realclaude-");
    writeFileSync(join(real, CLAUDE_CREDENTIALS_FILE), "REAL");
    mkdirSync(join(root, "linked"), { recursive: true });
    symlinkSync(join(real, CLAUDE_CREDENTIALS_FILE), join(root, "linked", CLAUDE_CREDENTIALS_FILE));
    symlinkSync(real, join(root, "linkdir"));

    const moved = quarantineClaudeCredentialCopies([root], q, { stamp: "S" });
    expect(moved.sort()).toEqual([
      join(root, "aura-home/.claude", CLAUDE_CREDENTIALS_FILE),
      join(root, "cells/t1/A-1/claude-config", CLAUDE_CREDENTIALS_FILE),
    ]);
    expect(readdirSync(q).sort()).toEqual(["S__aura-home__.claude__.credentials.json", "S__cells__t1__A-1__claude-config__.credentials.json"]);
    expect(readFileSync(join(q, "S__aura-home__.claude__.credentials.json"), "utf8")).toBe('{"from":"aura-home/.claude"}');
    expect(statSync(q).mode & 0o777).toBe(0o700);
    expect(statSync(join(q, "S__aura-home__.claude__.credentials.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(root, "node_modules/pkg", CLAUDE_CREDENTIALS_FILE))).toBe(true);
    // The real file (behind symlinks) is untouched.
    expect(readFileSync(join(real, CLAUDE_CREDENTIALS_FILE), "utf8")).toBe("REAL");
    // Idempotent: the quarantine itself is never re-swept.
    expect(quarantineClaudeCredentialCopies([root], q, { stamp: "T" })).toEqual([]);
  });

  it("respects maxDepth and creates no quarantine dir when nothing is found", () => {
    const root = tmp("aurabench-q-");
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "a", "b", CLAUDE_CREDENTIALS_FILE), "{}");
    const q = join(root, "q");
    expect(quarantineClaudeCredentialCopies([root], q, { maxDepth: 2 })).toEqual([]);
    expect(existsSync(q)).toBe(false);
    expect(quarantineClaudeCredentialCopies([root], q, { maxDepth: 3 })).toHaveLength(1);
  });
});

describe("claudeCredentialCopyEvidence", () => {
  it("lists the dirs that hold a credentials file", () => {
    const a = tmp("aurabench-e-");
    const b = tmp("aurabench-e-");
    writeFileSync(join(b, CLAUDE_CREDENTIALS_FILE), "{}");
    expect(claudeCredentialCopyEvidence([a, b])).toEqual({ credential_copies: [join(b, CLAUDE_CREDENTIALS_FILE)] });
  });
});
