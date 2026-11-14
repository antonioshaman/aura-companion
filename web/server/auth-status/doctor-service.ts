import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { log } from "../logger.js";
import { COMPANION_HOME } from "../paths.js";
import { resolveBinary } from "../path-resolver.js";
import type { DoctorReport } from "./auth-types.js";
import { doctorExitCode, runDoctorChecks, type DoctorDeps, type DoctorServiceUser, type DoctorStat } from "./doctor-checks.js";
import { runBoundedProbe } from "./probe-runner.js";
import { readUnitTexts, resolveInPath } from "./service-status.js";
import { RECHECK_MIN_INTERVAL_MS, resolveServiceIdentity } from "./status-core.js";

/**
 * Production wiring of the doctor core: real fs, `/etc/passwd`, the service
 * identity (live process, or the systemd unit for the offline CLI) and a
 * cache with the same ≥30 s recheck pause as the status core.
 */

export interface PasswdEntry {
  name: string;
  uid: number;
  gid: number;
  home: string;
}

/** `/etc/passwd` lines → entries; malformed lines are skipped. */
export function parsePasswd(text: string): PasswdEntry[] {
  const out: PasswdEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const f = line.split(":");
    if (f.length < 7) continue;
    const uid = Number(f[2]);
    const gid = Number(f[3]);
    if (!f[0] || !Number.isInteger(uid) || !Number.isInteger(gid)) continue;
    out.push({ name: f[0], uid, gid, home: f[5] ?? "" });
  }
  return out;
}

function readPasswd(): PasswdEntry[] {
  try {
    return parsePasswd(readFileSync("/etc/passwd", "utf-8"));
  } catch {
    return [];
  }
}

function toDoctorStat(st: Stats): DoctorStat {
  return {
    uid: st.uid,
    gid: st.gid,
    mode: st.mode,
    dev: st.dev,
    ino: st.ino,
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
    isSymbolicLink: st.isSymbolicLink(),
  };
}

export interface CreateDoctorDepsOptions {
  mode: "service" | "local_cli";
  unitTexts?: readonly string[];
  companionHome?: string;
}

export function createDoctorDeps(opts: CreateDoctorDepsOptions): DoctorDeps {
  const me = userInfo();
  const callerUid = typeof process.getuid === "function" ? process.getuid() : me.uid;
  const passwd = readPasswd();
  const byUid = new Map(passwd.map((e) => [e.uid, e.name]));

  let service: DoctorServiceUser;
  let resolveLaunchBinary: DoctorDeps["resolveLaunchBinary"];
  let companionHome: string;
  if (opts.mode === "service") {
    service = {
      name: me.username,
      uid: callerUid,
      gid: typeof process.getgid === "function" ? process.getgid() : me.gid,
      home: process.env.HOME || homedir(),
      env: process.env,
    };
    // Exactly the resolver session launches use (cli-launcher → resolveBinary).
    resolveLaunchBinary = (name) => resolveBinary(name);
    companionHome = opts.companionHome ?? COMPANION_HOME;
  } else {
    const identity = resolveServiceIdentity({
      isServiceProcess: false,
      caller: { uid: callerUid, username: me.username, env: process.env },
      unitTexts: opts.unitTexts ?? readUnitTexts(),
    });
    const entry = identity.user ? passwd.find((e) => e.name === identity.user) : undefined;
    const name = identity.user ?? me.username;
    const home = (identity.source === "unit" ? identity.env.HOME : undefined) || entry?.home || process.env.HOME || homedir();
    service = {
      name,
      uid: entry?.uid ?? (identity.user ? -1 : callerUid),
      gid: entry?.gid ?? (identity.user ? -1 : me.gid),
      home,
      env: { ...identity.env, HOME: home },
    };
    // Offline we cannot run the service user's login shell; the unit's PATH is the launch PATH.
    resolveLaunchBinary = (name) => resolveInPath(name, service.env);
    companionHome = opts.companionHome ?? (identity.env.COMPANION_HOME || join(home, ".companion"));
  }

  return {
    computedBy: opts.mode === "service" ? "service" : "local_cli",
    service,
    callerUid,
    companionHome,
    resolveLaunchBinary,
    lstat: (p) => toDoctorStat(lstatSync(p)),
    stat: (p) => toDoctorStat(statSync(p)),
    realpath: (p) => realpathSync(p),
    readdir: (p) => readdirSync(p),
    readTextFile: (p) => readFileSync(p, "utf-8"),
    runProbe: runBoundedProbe,
    userName: (uid) => byUid.get(uid) ?? null,
    now: Date.now,
  };
}

export type DoctorRecheckOutcome =
  | { kind: "ok"; report: DoctorReport }
  | { kind: "too_soon"; retryAfterMs: number; report: DoctorReport | null };

/** Cache + single-flight + recheck pause around `runDoctorChecks` (GET = cache only, POST = recheck). */
export class DoctorRunner {
  private cached: DoctorReport | null = null;
  private inFlight: Promise<DoctorReport> | null = null;
  private lastForcedAt: number | null = null;

  constructor(
    private readonly run: () => Promise<DoctorReport>,
    private readonly now: () => number = Date.now,
    /** Server only: the CLI must not print log lines into its output. */
    private readonly onCompleted?: (report: DoctorReport) => void,
  ) {}

  peek(): DoctorReport | null {
    return this.cached;
  }

  /** Run now (offline CLI) — shares an in-flight run. */
  get(): Promise<DoctorReport> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run()
      .then((report) => {
        this.cached = report;
        this.onCompleted?.(report);
        return report;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  async recheck(): Promise<DoctorRecheckOutcome> {
    const now = this.now();
    if (this.lastForcedAt !== null) {
      const elapsed = now - this.lastForcedAt;
      if (elapsed >= 0 && elapsed < RECHECK_MIN_INTERVAL_MS) {
        // A run still in flight is the answer the caller is waiting for.
        const report = this.inFlight ? await this.inFlight.catch(() => this.cached) : this.cached;
        return { kind: "too_soon", retryAfterMs: RECHECK_MIN_INTERVAL_MS - elapsed, report };
      }
    }
    this.lastForcedAt = now;
    return { kind: "ok", report: await this.get() };
  }
}

function logDoctorCompleted(report: DoctorReport): void {
  // EC-9 / EC-23: counts only, never paths.
  log.info("auth-status", "doctor.completed", {
    event: "doctor.completed",
    computedBy: report.computedBy,
    exitCode: doctorExitCode(report),
    findings: report.providers.claude.findings.length + report.providers.codex.findings.length,
    unchecked: report.providers.claude.unchecked.length + report.providers.codex.unchecked.length,
  });
}

export function createDoctorRunner(opts: CreateDoctorDepsOptions): DoctorRunner {
  const deps = createDoctorDeps(opts);
  return new DoctorRunner(() => runDoctorChecks(deps), Date.now, opts.mode === "service" ? logDoctorCompleted : undefined);
}

let serviceDoctor: DoctorRunner | null = null;
/** The server's single doctor instance (lazy). */
export function getServiceDoctorRunner(): DoctorRunner {
  serviceDoctor ??= createDoctorRunner({ mode: "service" });
  return serviceDoctor;
}
