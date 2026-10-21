import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const temporaryDirs: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runScript(script: string, overrides: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "aura-recovery-test-"));
  temporaryDirs.push(directory);
  const logPath = join(directory, "calls");
  writeFileSync(logPath, "");
  writeFileSync(join(directory, "systemctl"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALL_LOG"
case "$1" in
  is-enabled) exit "$ENABLED_EXIT" ;;
  show)
    [[ "$SHOW_EXIT" == 0 ]] || exit "$SHOW_EXIT"
    case "$*" in
      *ActiveState*) printf '%s\\n' "$UNIT_STATE" ;;
      *Result*) printf '%s\\n' "$UNIT_RESULT" ;;
    esac ;;
  reset-failed) exit "$RESET_EXIT" ;;
  start|restart) exit "$START_EXIT" ;;
esac
`, { mode: 0o755 });
  const result = spawnSync("bash", [join(repoRoot, script)], {
    encoding: "utf8",
    env: {
      PATH: `${directory}:${process.env.PATH}`,
      CALL_LOG: logPath,
      ENABLED_EXIT: "0",
      SHOW_EXIT: "0",
      RESET_EXIT: "0",
      START_EXIT: "0",
      UNIT_STATE: "active",
      UNIT_RESULT: "start-limit-hit",
      ...overrides,
    },
  });
  return { status: result.status, calls: readFileSync(logPath, "utf8").trim().split("\n") };
}

describe("service recovery after the 2026-10-21 package-update restart storm", () => {
  it("clears the exhausted start budget before restarting a failed enabled service", () => {
    const result = runScript("scripts/aura-recover.sh", { UNIT_STATE: "failed" });
    expect(result.status).toBe(0);
    expect(result.calls.slice(-2)).toEqual([
      "reset-failed aura-companion.service",
      "start aura-companion.service",
    ]);
  });

  it.each(["active", "inactive", "activating", "deactivating", "reloading"])(
    "leaves a %s service alone, including an intentional manual stop",
    (state) => {
      const result = runScript("scripts/aura-recover.sh", { UNIT_STATE: state });
      expect(result.status).toBe(0);
      expect(result.calls).toHaveLength(2);
    },
  );

  it.each(["scripts/aura-recover.sh", "scripts/deploy-drop-ins/aura-companion.needrestart"])(
    "%s does not revive a disabled or masked service",
    (script) => {
      const result = runScript(script, { ENABLED_EXIT: "1", UNIT_STATE: "failed" });
      expect(result.status).toBe(0);
      expect(result.calls).toEqual(["is-enabled --quiet aura-companion.service"]);
    },
  );

  it("does not mutate service state if inspection fails", () => {
    const result = runScript("scripts/aura-recover.sh", { SHOW_EXIT: "1" });
    expect(result.status).toBe(1);
    expect(result.calls).toHaveLength(2);
  });

  it("does not start if resetting the failure budget fails", () => {
    const result = runScript("scripts/aura-recover.sh", { UNIT_STATE: "failed", RESET_EXIT: "1" });
    expect(result.status).toBe(1);
    expect(result.calls.at(-1)).toBe("reset-failed aura-companion.service");
  });

  it("reports a failed recovery instead of claiming success", () => {
    expect(runScript("scripts/aura-recover.sh", { UNIT_STATE: "failed", START_EXIT: "1" }).status).toBe(1);
  });

  it("package hooks only reset the debounce timer, never restart the live server directly", () => {
    const result = runScript("scripts/deploy-drop-ins/aura-companion.needrestart");
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      "is-enabled --quiet aura-companion.service",
      "restart aura-companion-update-restart.timer",
    ]);
  });
});
