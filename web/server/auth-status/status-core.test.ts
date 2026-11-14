import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeAuthState } from "./auth-catalog.js";
import { knownField, unknownField, type ProviderAuthStatus, type ProviderId } from "./auth-types.js";
import {
  LAST_CHECK_SCHEMA_VERSION,
  RECHECK_MIN_INTERVAL_MS,
  STATUS_TTL_MS,
  StatusCore,
  isFresh,
  parseLastCheckFile,
  parseSystemdUnit,
  resolveServiceIdentity,
  type StatusCoreDeps,
} from "./status-core.js";

// The status core is what both UI and CLI read (S1-AC5 rests on it). Under test:
//  - S1-AC1 working + every field; S1-AC2 invalid + relogin action;
//    S1-AC3 no_network keeps lastSuccessAt (in memory AND across restart);
//  - cost bounds: TTL 5 min, single-flight, peek never probes, recheck ≥30 s;
//  - persistence: atomic file under COMPANION_HOME, written only when
//    persist=true, corrupt / unknown-version file = "no checks yet";
//  - identity: the unit's User/HOME/PATH, wrong uid → wrong_user without probing;
//  - EC-38: a backwards clock never keeps a cache fresh forever.

let dir: string;
let now: number;
const T0 = 1_800_000_000_000;

function status(provider: ProviderId, state: ProviderAuthStatus["state"], over: Partial<ProviderAuthStatus> = {}): ProviderAuthStatus {
  return {
    provider,
    state,
    reason: state === "not_verified" ? "no_provider_check" : null,
    account: knownField(`${provider}@example.invalid`),
    plan: knownField("max"),
    method: knownField("subscription"),
    tokenExpiresAt: knownField(T0 + 3_600_000),
    lastSuccessAt: state === "working" ? now : null,
    checkedAt: now,
    verifiedBy: state === "working" || state === "invalid" ? "provider" : "local",
    cli: { path: knownField(`/usr/bin/${provider}`), version: knownField("1.0.0") },
    ...over,
  };
}

const caller = { uid: 1001, username: "svc", env: { HOME: "/home/svc", PATH: "/usr/bin" } };

function makeCore(over: Partial<StatusCoreDeps> = {}, states: Partial<Record<ProviderId, ProviderAuthStatus["state"]>> = {}) {
  const probes = {
    claude: vi.fn(async () => status("claude", states.claude ?? "working")),
    codex: vi.fn(async () => status("codex", states.codex ?? "not_verified")),
  };
  const deps: StatusCoreDeps = {
    identity: { user: "svc", env: caller.env, source: "service" },
    caller,
    probes,
    now: () => now,
    lastCheckPath: join(dir, "auth-status", "last-check.json"),
    persist: true,
    computedBy: "service",
    ...over,
  };
  return { core: new StatusCore(deps), probes, deps };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "status-core-"));
  now = T0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("StatusCore — acceptance", () => {
  it("S1-AC1: working status carries account, plan, method, expiry and last success", async () => {
    const { core } = makeCore();
    const snap = await core.get();
    expect(snap.computedBy).toBe("service");
    expect(snap.providers.claude).toMatchObject({
      state: "working",
      account: { known: true, value: "claude@example.invalid" },
      plan: { known: true, value: "max" },
      method: { known: true, value: "subscription" },
      tokenExpiresAt: { known: true },
      lastSuccessAt: T0,
    });
    // Codex parity: same shape, honest not_verified with explicit unknowns allowed.
    expect(snap.providers.codex.state).toBe("not_verified");
  });

  it("S1-AC2: rejected credentials → invalid with a relogin action", async () => {
    const { core } = makeCore({}, { claude: "invalid" });
    const s = (await core.get()).providers.claude;
    expect(s.state).toBe("invalid");
    expect(describeAuthState(s.state, s.provider, s.reason).action.kind).toBe("relogin");
  });

  it("S1-AC3: no_network keeps lastSuccessAt, in memory and across a restart", async () => {
    const first = makeCore();
    await first.core.get();
    now += STATUS_TTL_MS + 1;
    first.probes.claude.mockResolvedValueOnce(status("claude", "no_network"));
    const later = (await first.core.get()).providers.claude;
    expect(later).toMatchObject({ state: "no_network", lastSuccessAt: T0 });
    expect(describeAuthState(later.state, "claude").title).not.toMatch(/expired|invalid/i);

    // Restart: a fresh core reads the persisted file.
    const restarted = makeCore({}, { claude: "no_network" });
    expect((await restarted.core.get()).providers.claude.lastSuccessAt).toBe(T0);
  });
});

describe("StatusCore — cost bounds", () => {
  it("serves the cache within the TTL and recomputes after it", async () => {
    const { core, probes } = makeCore();
    await core.get();
    now += STATUS_TTL_MS - 1;
    await core.get();
    expect(probes.claude).toHaveBeenCalledTimes(1);
    now += 2;
    await core.get();
    expect(probes.claude).toHaveBeenCalledTimes(2);
  });

  it("is single-flight: concurrent callers share one probe run", async () => {
    const { core, probes } = makeCore();
    await Promise.all([core.get(), core.get(), core.get()]);
    expect(probes.claude).toHaveBeenCalledTimes(1);
    expect(probes.codex).toHaveBeenCalledTimes(1);
  });

  it("peek never probes", async () => {
    const { core, probes } = makeCore();
    expect(core.peek()).toBeNull();
    expect(probes.claude).not.toHaveBeenCalled();
    await core.get();
    expect(core.peek()?.providers.claude.state).toBe("working");
  });

  it("recheck bypasses the TTL but is limited to one per 30 s", async () => {
    const { core, probes } = makeCore();
    await core.get();
    expect((await core.recheck()).kind).toBe("ok");
    expect(probes.claude).toHaveBeenCalledTimes(2);
    now += RECHECK_MIN_INTERVAL_MS - 1000;
    const r = await core.recheck();
    expect(r).toMatchObject({ kind: "too_soon", retryAfterMs: 1000 });
    expect(probes.claude).toHaveBeenCalledTimes(2);
    now += 1000;
    expect((await core.recheck()).kind).toBe("ok");
  });

  it("EC-38: a cache stamped in the future (clock went back) is stale", () => {
    expect(isFresh(T0, T0 + 1000)).toBe(true);
    expect(isFresh(T0, T0 + STATUS_TTL_MS)).toBe(false);
    expect(isFresh(T0, T0 - 60_000)).toBe(false);
  });
});

describe("StatusCore — persistence", () => {
  it("writes a token-free versioned file only when persist=true", async () => {
    const { core } = makeCore();
    await core.get();
    const raw = readFileSync(join(dir, "auth-status", "last-check.json"), "utf-8");
    const file = JSON.parse(raw);
    expect(file.schemaVersion).toBe(LAST_CHECK_SCHEMA_VERSION);
    expect(file.providers.claude).toEqual({ state: "working", plan: "max", method: "subscription", checkedAt: T0, lastSuccessAt: T0 });
    // Allowlisted record: no account email, no paths.
    expect(raw).not.toContain("example.invalid");
    expect(raw).not.toContain("/usr/bin");

    const readOnly = makeCore({ persist: false, lastCheckPath: join(dir, "other.json") });
    await readOnly.core.get();
    expect(() => readFileSync(join(dir, "other.json"))).toThrow();
  });

  it.each([
    ["corrupt", "{oops"],
    ["unknown version", JSON.stringify({ schemaVersion: 99, providers: {} })],
    ["bad entry", JSON.stringify({ schemaVersion: 1, providers: { claude: { state: "bogus" } } })],
  ])("a %s file means 'no checks yet'", async (_label, content) => {
    const path = join(dir, "auth-status", "last-check.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    expect(parseLastCheckFile(content)).toBeNull();
    const { core } = makeCore({}, { claude: "no_network" });
    expect((await core.get()).providers.claude.lastSuccessAt).toBeNull();
  });
});

describe("service identity", () => {
  const UNIT = `[Unit]
Description=Aura
[Service]
User=auracomp
Environment="PATH=/home/auracomp/.bun/bin:/usr/bin" "NODE_ENV=production"
Environment=HOME=/home/auracomp
ExecStart=/home/auracomp/.bun/bin/bun server/index.ts
`;
  const DROPIN = "[Service]\nEnvironment=\"PATH=/home/auracomp/.local/bin:/usr/bin\"\n";

  it("parses User and Environment, with drop-ins overriding the unit", () => {
    expect(parseSystemdUnit([UNIT])).toEqual({
      user: "auracomp",
      env: { PATH: "/home/auracomp/.bun/bin:/usr/bin", NODE_ENV: "production", HOME: "/home/auracomp" },
    });
    expect(parseSystemdUnit([UNIT, DROPIN]).env.PATH).toBe("/home/auracomp/.local/bin:/usr/bin");
  });

  it("the offline CLI adopts the unit's HOME/PATH", () => {
    const id = resolveServiceIdentity({ isServiceProcess: false, caller: { ...caller, username: "auracomp" }, unitTexts: [UNIT] });
    expect(id).toMatchObject({ user: "auracomp", source: "unit", env: { HOME: "/home/auracomp", PATH: "/home/auracomp/.bun/bin:/usr/bin" } });
    expect(resolveServiceIdentity({ isServiceProcess: true, caller, unitTexts: [UNIT] }).source).toBe("service");
    expect(resolveServiceIdentity({ isServiceProcess: false, caller, unitTexts: [] }).source).toBe("caller");
  });

  it("a different OS user gets wrong_user for both providers and no probe runs", async () => {
    const identity = resolveServiceIdentity({ isServiceProcess: false, caller: { uid: 0, username: "root", env: {} }, unitTexts: [UNIT] });
    const { core, probes } = makeCore({ identity, caller: { uid: 0, username: "root", env: {} }, persist: false, computedBy: "local_cli" });
    const snap = await core.get();
    for (const id of ["claude", "codex"] as const) {
      expect(snap.providers[id]).toMatchObject({ state: "not_verified", reason: "wrong_user", serviceUser: "auracomp", account: unknownField });
    }
    expect(snap.computedBy).toBe("local_cli");
    expect(probes.claude).not.toHaveBeenCalled();
    expect(probes.codex).not.toHaveBeenCalled();
  });
});
