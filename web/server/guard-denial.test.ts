import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  GUARD_ALLOW_TTL_MS,
  GUARD_DENIAL_MAX_AGE_MS,
  allowSigningString,
  commandSha256,
  guardAllowDir,
  guardAllowOnceBlocker,
  parseGuardDenial,
  writeGuardAllowEntry,
  type GuardDenial,
} from "./guard-denial.js";

/**
 * Unit tests for the guards-pack denial parser and the one-shot allow store.
 * The allow-entry format is shared with packs/guards/guards.py
 * (`consume_allow_once`); the last block runs the real hook against an entry
 * written here, so the two implementations cannot drift apart silently.
 */

const FRAME = {
  type: "system",
  subtype: "permission_denied",
  tool_name: "Bash",
  tool_use_id: "toolu_1",
  decision_reason_type: "hook",
  message: "[guards:git-reset-hard] reset\n[guards:service-restart] restart\n[guards:service-restart] again\n(guards decision: ask. x)",
  uuid: "u",
  session_id: "cli",
};

describe("parseGuardDenial", () => {
  it("collects every rule tag in order, de-duplicated, with the marker level", () => {
    expect(parseGuardDenial(FRAME)).toEqual({
      toolUseId: "toolu_1",
      toolName: "Bash",
      rule: "git-reset-hard",
      rules: ["git-reset-hard", "service-restart"],
      level: "ask",
      reason: FRAME.message,
    });
  });

  it("falls back to the legacy deny-rule set when the marker is missing (old guards.py)", () => {
    expect(parseGuardDenial({ ...FRAME, message: "[guards:pkill] no\n(Disable with GUARDS_DISABLE=pkill …)" })?.level).toBe("deny");
    expect(parseGuardDenial({ ...FRAME, message: "[guards:rm-rf] careful" })?.level).toBe("ask");
  });

  it("returns null for anything that is not a guards hook denial", () => {
    expect(parseGuardDenial(null)).toBeNull();
    expect(parseGuardDenial({ ...FRAME, subtype: "init" })).toBeNull();
    expect(parseGuardDenial({ ...FRAME, decision_reason_type: "rule" })).toBeNull();
    expect(parseGuardDenial({ ...FRAME, message: "other hook said no" })).toBeNull();
    expect(parseGuardDenial({ ...FRAME, tool_use_id: undefined })).toBeNull();
    expect(parseGuardDenial({ ...FRAME, message: 42 })).toBeNull();
  });
});

describe("guardAllowOnceBlocker", () => {
  const base: GuardDenial = {
    sessionId: "s", toolUseId: "t", toolName: "Bash", rule: "r", rules: ["r"], level: "ask",
    reason: "[guards:r] x", command: "systemctl restart x", deniedAt: 1_000_000, status: "pending",
  };
  it("allows a fresh pending ask-level Bash denial with a command", () => {
    expect(guardAllowOnceBlocker(base, base.deniedAt + 1000)).toBeNull();
  });
  it.each([
    ["not_found", undefined, 0],
    ["already_resolved", { ...base, status: "allowed" as const }, base.deniedAt],
    ["deny_level", { ...base, level: "deny" as const }, base.deniedAt],
    ["expired", base, base.deniedAt + GUARD_DENIAL_MAX_AGE_MS + 1],
    ["no_command", { ...base, command: null }, base.deniedAt],
    ["no_command", { ...base, toolName: "Write" }, base.deniedAt],
  ])("blocks with %s", (want, denial, now) => {
    expect(guardAllowOnceBlocker(denial as GuardDenial | undefined, now as number)).toBe(want);
  });
});

describe("allow store", () => {
  let dir: string;
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "guard-allow-"));
    dir = join(root, "home", ".companion", "guards-allow");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("guardAllowDir follows $HOME", () => {
    const prev = process.env.HOME;
    process.env.HOME = "/tmp/some-home";
    try {
      expect(guardAllowDir()).toBe("/tmp/some-home/.companion/guards-allow");
    } finally {
      process.env.HOME = prev;
    }
  });

  it("writes a 0600 signed entry in a 0700 dir with a 0600 key, and leaves no temp files", () => {
    const { path, entry } = writeGuardAllowEntry({ rules: ["service-restart"], command: "c", cwd: "/w", now: 1000, dir });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, ".hmac-key")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual([".hmac-key", path.split("/").pop()].sort());
    expect(entry).toMatchObject({ v: 1, rule: "service-restart", commandSha256: commandSha256("c"), cwd: "/w", expiresAt: 1000 + GUARD_ALLOW_TTL_MS });
    const key = readFileSync(join(dir, ".hmac-key"), "utf8").trim();
    const want = createHmac("sha256", key)
      .update(allowSigningString(entry.rules, entry.commandSha256, entry.cwd, entry.expiresAt, entry.nonce))
      .digest("hex");
    expect(entry.sig).toBe(want);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(entry);
  });

  it("reuses the existing key across entries", () => {
    writeGuardAllowEntry({ rules: ["a"], command: "c", cwd: "", dir });
    const k1 = readFileSync(join(dir, ".hmac-key"), "utf8");
    writeGuardAllowEntry({ rules: ["a"], command: "c", cwd: "", dir });
    expect(readFileSync(join(dir, ".hmac-key"), "utf8")).toBe(k1);
  });

  // Cross-language contract: an entry written by the server is accepted (and
  // consumed exactly once) by the real guards.py hook. Skipped where python3
  // is not installed.
  const python = spawnSync("python3", ["--version"]).status === 0;
  const GUARDS_PY = resolve(__dirname, "../../packs/guards/guards.py");
  it.skipIf(!python || !existsSync(GUARDS_PY))("guards.py consumes a server-written entry exactly once", () => {
    const home = join(root, "home");
    const cwd = join(root, "proj");
    const command = "ssh prod 'systemctl restart auraengine-bot.service'";
    writeGuardAllowEntry({ rules: ["service-restart"], command, cwd, dir: join(home, ".companion", "guards-allow") });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GUARDS_")) env[k] = v;
    env.HOME = home;
    const run = () =>
      JSON.parse(
        spawnSync("python3", [GUARDS_PY, "pre"], {
          input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }),
          env,
          encoding: "utf8",
        }).stdout,
      ).hookSpecificOutput;
    const first = run();
    expect(first.permissionDecision).toBeUndefined();
    expect(first.additionalContext).toContain("Allowed once");
    expect(run().permissionDecision).toBe("ask");
  });
});
