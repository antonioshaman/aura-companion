/**
 * Guards-pack denials surfaced to the user ("Allow once").
 *
 * CLAUDE-ONLY. The guards pack (`packs/guards/guards.py`) is a Claude Code
 * PreToolUse hook. When it answers `permissionDecision: "ask"` in a session
 * running with `permissionMode: bypassPermissions` (Aura "agent" mode), the
 * Claude CLI never sends a `can_use_tool` control_request — it auto-denies the
 * tool call and emits a stream-json frame:
 *
 *   {"type":"system","subtype":"permission_denied","tool_name":"Bash",
 *    "tool_use_id":"toolu_…","decision_reason_type":"hook",
 *    "message":"[guards:service-restart] `systemctl restart …` …","uuid":"…","session_id":"…"}
 *
 * This module parses that frame into a `GuardDenial`, and writes the one-shot
 * allow entry the hook consumes on the next identical command. Codex sessions
 * never run Claude hooks, so they never produce this frame and the card never
 * appears for them — no UI gating is needed.
 *
 * Allow-entry format v1 is shared with `consume_allow_once` in guards.py —
 * keep the two in sync (signing string, field names, directory, key file).
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A denial older than this can no longer be allowed once (the agent has moved on). */
export const GUARD_DENIAL_MAX_AGE_MS = 10 * 60 * 1000;
/** Lifetime of a written allow entry. guards.py rejects anything > 15 min. */
export const GUARD_ALLOW_TTL_MS = 5 * 60 * 1000;

/** Rules guards.py emits at "deny" level; used only when an old guards.py lacks the decision marker. */
const LEGACY_DENY_RULES = new Set(["pkill"]);

export type GuardDenialStatus = "pending" | "allowed" | "dismissed";

export interface GuardDenial {
  sessionId: string;
  toolUseId: string;
  toolName: string;
  /** First (highest-level) rule in the reason. */
  rule: string;
  /** Every `[guards:<rule>]` tag in the reason, in order, de-duplicated. */
  rules: string[];
  /** "ask" can be allowed once; "deny" never. */
  level: "ask" | "deny";
  /** Full reason text as shown to the agent. */
  reason: string;
  /** Exact Bash command, taken from the server-recorded tool_use input (never from the browser). */
  command: string | null;
  deniedAt: number;
  status: GuardDenialStatus;
  resolvedAt?: number;
}

export interface ParsedGuardDenial {
  toolUseId: string;
  toolName: string;
  rule: string;
  rules: string[];
  level: "ask" | "deny";
  reason: string;
}

const RULE_TAG_RE = /^\[guards:([a-z0-9][a-z0-9-]*)\]/gm;
const DECISION_RE = /\(guards decision: (ask|deny)\b/;

/**
 * Parse a CLI `system/permission_denied` frame. Returns null for anything that
 * is not a guards-pack hook denial (other hooks, a permission rule, a
 * malformed frame) — those are intentionally ignored, never treated as drift
 * (EC-5: the subtype is known; only the guards shape is mapped).
 */
export function parseGuardDenial(frame: unknown): ParsedGuardDenial | null {
  if (!frame || typeof frame !== "object") return null;
  const f = frame as Record<string, unknown>;
  if (f.type !== "system" || f.subtype !== "permission_denied") return null;
  if (f.decision_reason_type !== "hook") return null;
  const message = typeof f.message === "string" ? f.message : "";
  const toolUseId = typeof f.tool_use_id === "string" ? f.tool_use_id : "";
  if (!toolUseId || !message.startsWith("[guards:")) return null;
  const rules: string[] = [];
  for (const m of message.matchAll(RULE_TAG_RE)) {
    if (!rules.includes(m[1])) rules.push(m[1]);
  }
  if (rules.length === 0) return null;
  const marker = DECISION_RE.exec(message)?.[1] as "ask" | "deny" | undefined;
  const level = marker ?? (rules.some((r) => LEGACY_DENY_RULES.has(r)) ? "deny" : "ask");
  return {
    toolUseId,
    toolName: typeof f.tool_name === "string" ? f.tool_name : "",
    rule: rules[0],
    rules,
    level,
    reason: message,
  };
}

/** Why a denial cannot be allowed once (null = it can). */
export function guardAllowOnceBlocker(
  denial: GuardDenial | undefined,
  now: number,
): "not_found" | "already_resolved" | "deny_level" | "expired" | "no_command" | null {
  if (!denial) return "not_found";
  if (denial.status !== "pending") return "already_resolved";
  if (denial.level !== "ask") return "deny_level";
  if (now - denial.deniedAt > GUARD_DENIAL_MAX_AGE_MS) return "expired";
  if (!denial.command || denial.toolName !== "Bash") return "no_command";
  return null;
}

// ── Allow store (shared with guards.py) ─────────────────────────────────────

const ALLOW_KEY_NAME = ".hmac-key";

/** `~/.companion/guards-allow` of the user the CLI (and so the hook) runs as — same user as this server. */
export function guardAllowDir(): string {
  return join(process.env.HOME || homedir(), ".companion", "guards-allow");
}

export function commandSha256(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex");
}

export function allowSigningString(
  rules: string[],
  commandSha: string,
  cwd: string,
  expiresAt: number,
  nonce: string,
): string {
  // Rule ids are ASCII, so JS default sort == Python sorted().
  return ["guards-allow-v1", [...rules].sort().join(","), commandSha, cwd, String(Math.trunc(expiresAt)), nonce].join("\n");
}

function ensureAllowDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Read (or create, 0600) the HMAC key. Created only by the server, never by the hook. */
export function loadOrCreateAllowKey(dir: string): string {
  ensureAllowDir(dir);
  const path = join(dir, ALLOW_KEY_NAME);
  if (existsSync(path)) {
    const key = readFileSync(path, "utf8").trim();
    if (key) return key;
  }
  const key = randomBytes(32).toString("hex");
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, key, { mode: 0o600 });
  renameSync(tmp, path);
  return key;
}

export interface GuardAllowEntry {
  v: 1;
  rule: string;
  rules: string[];
  commandSha256: string;
  cwd: string;
  expiresAt: number;
  nonce: string;
  sig: string;
}

/**
 * Write a signed one-shot allow entry (dir 0700, file 0600, atomic rename).
 * Returns the written entry and its path.
 */
export function writeGuardAllowEntry(opts: {
  rules: string[];
  command: string;
  cwd: string;
  now?: number;
  dir?: string;
}): { path: string; entry: GuardAllowEntry } {
  const dir = opts.dir ?? guardAllowDir();
  const key = loadOrCreateAllowKey(dir);
  const now = opts.now ?? Date.now();
  const expiresAt = now + GUARD_ALLOW_TTL_MS;
  const nonce = randomBytes(12).toString("hex");
  const sha = commandSha256(opts.command);
  const sig = createHmac("sha256", key)
    .update(allowSigningString(opts.rules, sha, opts.cwd, expiresAt, nonce), "utf8")
    .digest("hex");
  const entry: GuardAllowEntry = {
    v: 1,
    rule: opts.rules[0],
    rules: opts.rules,
    commandSha256: sha,
    cwd: opts.cwd,
    expiresAt,
    nonce,
    sig,
  };
  const path = join(dir, `${now}-${nonce}.json`);
  // Write under a non-.json name first: the hook only reads *.json, so it never sees a partial file.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
  renameSync(tmp, path);
  return { path, entry };
}

/** Message injected into the session after "Allow once" so the agent retries the exact command. */
export function allowOnceRetryPrompt(command: string): string {
  return `User approved once via Aura: re-run exactly this command (unchanged, character for character):\n\n${command}`;
}
