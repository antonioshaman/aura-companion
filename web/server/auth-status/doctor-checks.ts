import { basename, dirname, join, relative, sep } from "node:path";
import {
  PROVIDER_IDS,
  assertNever,
  knownField,
  unknownField,
  type DoctorBinary,
  type DoctorCheck,
  type DoctorFile,
  type DoctorPlace,
  type DoctorReport,
  type DoctorUncheckedReason,
  type Known,
  type ProviderDoctorResult,
  type ProviderId,
} from "./auth-types.js";
import { CLAUDE_CREDENTIAL_FILE_NAMES, CODEX_CREDENTIAL_FILE_NAME } from "./credential-locator.js";
import type { BoundedProbeResult, ProbeOptions } from "./probe-runner.js";
import { VERSION_ARGV, parseCliVersion } from "./provider-probes.js";

/**
 * Doctor checks (spec story 2, plan task 7) — METADATA ONLY.
 *
 * Pure core: filesystem, process runner, user database and clock are
 * injected, so this module has no Hono / session-store dependency and runs
 * the same in the server and in the offline CLI.
 *
 * Hard rules (spec 🚫, plan Risks hunt #2):
 * - Credential files are only `lstat`/`stat`-ed — never opened, read, hashed
 *   or copied. The only file this module reads is a CLI's `package.json`
 *   (to learn its version without executing it).
 * - A binary is executed (`--version`) only when this process IS the service
 *   user and the binary is owned by that user or root and not group/other
 *   writable. A root-run doctor therefore never runs another user's binary,
 *   and never creates root-owned files in the service HOME.
 * - EACCES / EPERM is "not checked", never "nothing found" (EC-17).
 */

/**
 * Minimum CLI version sessions need. Claude: 2.1.280 — the API answered
 * "Claude Code 2.1.278 does not support this model; version 2.1.280 or newer
 * is required" on this box (memory project_aura_claude_cli_update_blocked…).
 * Codex: no floor is published (models_cache.json carries none) → unknown,
 * the check is not applicable rather than guessed.
 */
export const REQUIRED_CLI_VERSIONS: Readonly<Record<ProviderId, string | null>> = {
  claude: "2.1.280",
  codex: null,
};

/** Where a user-local install of each CLI lives, relative to the service HOME, in preference order. */
export const USER_INSTALL_DIRS: readonly string[] = [join(".local", "bin"), join(".bun", "bin"), join(".npm-global", "bin")];

/** npm packages whose `package.json` may be read for a version (never anything else). */
const CLI_PACKAGE_NAMES: Readonly<Record<ProviderId, string>> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};

export interface DoctorStat {
  uid: number;
  gid: number;
  /** Full `st.mode` (type + permission bits). */
  mode: number;
  dev: number;
  ino: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface DoctorServiceUser {
  /** Null when no unit names a user (dev / non-systemd); the caller stands in. */
  name: string | null;
  uid: number;
  gid: number;
  home: string;
  /** Environment the service runs with (HOME/PATH). */
  env: NodeJS.ProcessEnv;
}

export interface DoctorDeps {
  computedBy: DoctorReport["computedBy"];
  service: DoctorServiceUser;
  /** uid of the process running the checks. */
  callerUid: number;
  /** The service's companion dir (its `codex-home/*` holds per-session Codex homes). */
  companionHome: string;
  /** Path the service resolves when it launches a session (the real resolver in service mode). */
  resolveLaunchBinary: (name: ProviderId) => string | null;
  /** Throw Node-style errors carrying `.code` (ENOENT, EACCES, …). */
  lstat: (path: string) => DoctorStat;
  stat: (path: string) => DoctorStat;
  realpath: (path: string) => string;
  readdir: (path: string) => string[];
  /** Used ONLY for a CLI's own `package.json`. */
  readTextFile: (path: string) => string;
  runProbe: (binaryPath: string, args: readonly string[], opts?: ProbeOptions) => Promise<BoundedProbeResult>;
  userName: (uid: number) => string | null;
  now: () => number;
  /** Root of other users' homes; `/home` in production. */
  homesRoot?: string;
  rootHome?: string;
  requiredVersions?: Readonly<Record<ProviderId, string | null>>;
}

type FsOutcome<T> = { ok: true; value: T } | { ok: false; absent: true } | { ok: false; absent: false; reason: DoctorUncheckedReason };

function fsTry<T>(fn: () => T): FsOutcome<T> {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return { ok: false, absent: true };
    if (code === "EACCES" || code === "EPERM") return { ok: false, absent: false, reason: "permission_denied" };
    return { ok: false, absent: false, reason: "io_error" };
  }
}

/** Numeric X.Y.Z comparison; non-numeric parts compare as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** 1 = findings, 2 = no findings but some checks did not run, 0 = clean (spec S2-AC5). */
export function doctorExitCode(report: DoctorReport): 0 | 1 | 2 {
  const results = PROVIDER_IDS.map((id) => report.providers[id]);
  if (results.some((r) => r.findings.length > 0)) return 1;
  if (results.some((r) => r.unchecked.length > 0)) return 2;
  return 0;
}

/** REST projection: no absolute paths leave the process (plan task 8). */
export function toRestDoctorReport(report: DoctorReport): DoctorReport {
  return JSON.parse(JSON.stringify(report, (key, value) => (key === "absPath" ? undefined : value))) as DoctorReport;
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

class DoctorRun {
  private readonly homesRoot: string;
  private readonly rootHome: string;

  constructor(private readonly deps: DoctorDeps) {
    this.homesRoot = deps.homesRoot ?? "/home";
    this.rootHome = deps.rootHome ?? "/root";
  }

  place(absPath: string): DoctorPlace {
    const { service, companionHome } = this.deps;
    const serviceName = service.name ?? this.deps.userName(service.uid) ?? `uid:${service.uid}`;
    const rel = (home: string) => relative(home, absPath) || ".";
    if (within(absPath, join(companionHome, "codex-home"))) {
      return within(absPath, service.home)
        ? { place: "codex_session_home", homeUser: serviceName, relPath: rel(service.home), absPath }
        : { place: "codex_session_home", homeUser: null, relPath: absPath, absPath };
    }
    if (within(absPath, service.home)) return { place: "service_home", homeUser: serviceName, relPath: rel(service.home), absPath };
    if (within(absPath, this.rootHome)) return { place: "root_home", homeUser: "root", relPath: rel(this.rootHome), absPath };
    if (within(absPath, this.homesRoot) && absPath !== this.homesRoot) {
      const user = relative(this.homesRoot, absPath).split(sep)[0]!;
      return { place: "other_user_home", homeUser: user, relPath: rel(join(this.homesRoot, user)), absPath };
    }
    return { place: "system", homeUser: null, relPath: absPath, absPath };
  }

  file(absPath: string, st: DoctorStat): DoctorFile {
    return { ...this.place(absPath), owner: this.deps.userName(st.uid) ?? `uid:${st.uid}`, mode: st.mode & 0o777 };
  }

  // ─── Binaries ───────────────────────────────────────────────────────────────

  /** Version from the install path alone: `…/versions/<X.Y.Z>` or the owning npm package's `package.json`. */
  versionFromPath(provider: ProviderId, real: string): string | null {
    const base = basename(real);
    if (/^\d+\.\d+\.\d+$/.test(base)) return base;
    const pkgName = CLI_PACKAGE_NAMES[provider];
    const marker = `${sep}node_modules${sep}${pkgName.split("/").join(sep)}${sep}`;
    const at = real.indexOf(marker);
    if (at < 0) return null;
    const pkgJson = join(real.slice(0, at + marker.length), "package.json");
    const read = fsTry(() => this.deps.readTextFile(pkgJson));
    if (!read.ok) return null;
    try {
      const parsed = JSON.parse(read.value) as { name?: unknown; version?: unknown };
      return parsed.name === pkgName && typeof parsed.version === "string" ? parseCliVersion(parsed.version) : null;
    } catch {
      return null;
    }
  }

  /** hunt #2: exec only as the service user, only a binary owned by it (or root) and not writable by others. */
  mayExec(target: DoctorStat): boolean {
    const { callerUid, service } = this.deps;
    if (callerUid !== service.uid) return false;
    if (target.uid !== callerUid && target.uid !== 0) return false;
    return (target.mode & 0o022) === 0;
  }

  async binary(provider: ProviderId, path: string): Promise<{ ok: true; bin: DoctorBinary } | { ok: false; reason: DoctorUncheckedReason; place: DoctorPlace } | null> {
    const link = fsTry(() => this.deps.lstat(path));
    if (!link.ok) return link.absent ? null : { ok: false, reason: link.reason, place: this.place(path) };
    const real = fsTry(() => this.deps.realpath(path));
    if (!real.ok) return real.absent ? null : { ok: false, reason: real.reason, place: this.place(path) };
    const target = fsTry(() => this.deps.stat(real.value));
    if (!target.ok) return target.absent ? null : { ok: false, reason: target.reason, place: this.place(real.value) };

    let version: Known<string> = unknownField;
    let versionSource: DoctorBinary["versionSource"] = "none";
    const fromPath = this.versionFromPath(provider, real.value);
    if (fromPath) {
      version = knownField(fromPath);
      versionSource = "path";
    } else if (this.mayExec(target.value)) {
      const run = await this.deps.runProbe(real.value, VERSION_ARGV, { env: this.deps.service.env });
      const parsed = run.kind === "exited" && run.exitCode === 0 ? parseCliVersion(run.stdout) : null;
      if (parsed) {
        version = knownField(parsed);
        versionSource = "exec";
      }
    }
    return {
      ok: true,
      bin: { location: this.file(path, link.value), target: this.file(real.value, target.value), version, versionSource },
    };
  }

  /** The service user's own install of the CLI, first match in USER_INSTALL_DIRS. */
  userInstallPath(provider: ProviderId): string | null {
    for (const dir of USER_INSTALL_DIRS) {
      const candidate = join(this.deps.service.home, dir, provider);
      if (fsTry(() => this.deps.lstat(candidate)).ok) return candidate;
    }
    return null;
  }

  // ─── Credentials ────────────────────────────────────────────────────────────

  credentialRelPaths(provider: ProviderId): string[] {
    switch (provider) {
      case "claude": return CLAUDE_CREDENTIAL_FILE_NAMES.map((name) => join(".claude", name));
      case "codex": return [join(".codex", CODEX_CREDENTIAL_FILE_NAME)];
      default: return assertNever(provider);
    }
  }

  /** Readability for the service user from mode bits alone (primary group only). */
  serviceCanRead(st: DoctorStat): boolean {
    const { uid, gid } = this.deps.service;
    if (uid === 0) return true;
    if (st.uid === uid) return (st.mode & 0o400) !== 0;
    if (st.gid === gid) return (st.mode & 0o040) !== 0;
    return (st.mode & 0o004) !== 0;
  }
}

/**
 * Scan one HOME's candidate credential files. Copies = regular files that are
 * not the primary (a symlink or hard link to the primary is the same file).
 */
function scanHome(
  run: DoctorRun,
  deps: DoctorDeps,
  provider: ProviderId,
  home: string,
  primary: DoctorStat | null,
  out: ProviderDoctorResult,
  skipPath: string | null,
): void {
  const dirs = new Map<string, string[]>();
  for (const rel of run.credentialRelPaths(provider)) {
    const dir = dirname(rel);
    dirs.set(dir, [...(dirs.get(dir) ?? []), rel]);
  }
  for (const [dir, rels] of dirs) {
    const dirStat = fsTry(() => deps.lstat(join(home, dir)));
    if (!dirStat.ok) {
      if (!dirStat.absent) out.unchecked.push({ provider, check: "credential_copies", reason: dirStat.reason, place: run.place(join(home, dir)) });
      continue;
    }
    for (const rel of rels) {
      const path = join(home, rel);
      if (path === skipPath) continue;
      const copy = candidateCopy(run, deps, path, primary);
      if (copy === null) continue;
      if ("reason" in copy) {
        out.unchecked.push({ provider, check: "credential_copies", reason: copy.reason, place: run.place(path) });
        break;
      }
      out.findings.push({ kind: "credential_copy", provider, copy: copy.file });
    }
  }
}

function sameInode(a: DoctorStat, b: DoctorStat | null): boolean {
  return b !== null && a.dev === b.dev && a.ino === b.ino;
}

function candidateCopy(
  run: DoctorRun,
  deps: DoctorDeps,
  path: string,
  primary: DoctorStat | null,
): { file: DoctorFile } | { reason: DoctorUncheckedReason } | null {
  const link = fsTry(() => deps.lstat(path));
  if (!link.ok) return link.absent ? null : { reason: link.reason };
  let st = link.value;
  if (st.isSymbolicLink) {
    const target = fsTry(() => deps.stat(path));
    if (!target.ok) return target.absent ? null : { reason: target.reason };
    st = target.value;
  }
  if (!st.isFile || sameInode(st, primary)) return null;
  return { file: run.file(path, st) };
}

async function checkProvider(run: DoctorRun, deps: DoctorDeps, provider: ProviderId): Promise<ProviderDoctorResult> {
  const required = (deps.requiredVersions ?? REQUIRED_CLI_VERSIONS)[provider];
  const out: ProviderDoctorResult = {
    provider,
    launched: null,
    requiredVersion: required ? knownField(required) : unknownField,
    findings: [],
    unchecked: [],
  };
  const unchecked = (check: DoctorCheck, reason: DoctorUncheckedReason, place?: DoctorPlace) =>
    out.unchecked.push(place ? { provider, check, reason, place } : { provider, check, reason });

  // S2-AC1 / S2-AC2: the binary sessions actually launch with.
  const launchPath = deps.resolveLaunchBinary(provider);
  if (launchPath) {
    const launched = await run.binary(provider, launchPath);
    if (launched && !launched.ok) unchecked("binary", launched.reason, launched.place);
    if (launched?.ok) {
      out.launched = launched.bin;
      const lv = launched.bin.version;
      if (!lv.known) unchecked("cli_version", "version_unknown", launched.bin.target);

      const refPath = run.userInstallPath(provider);
      const reference = refPath ? await run.binary(provider, refPath) : null;
      if (reference && !reference.ok) unchecked("binary", reference.reason, reference.place);
      if (reference?.ok) {
        const rv = reference.bin.version;
        const pathDiffers = reference.bin.target.absPath !== launched.bin.target.absPath;
        const versionDiffers = lv.known && rv.known && lv.value !== rv.value;
        if (pathDiffers || versionDiffers) {
          out.findings.push({ kind: "binary_divergence", provider, launched: launched.bin, reference: reference.bin });
        }
      } else if (reference === null) {
        // No own install, but sessions run another user's install (the stale-root-CLI incident).
        const place = launched.bin.target.place;
        if (place === "root_home" || place === "other_user_home") {
          out.findings.push({ kind: "binary_divergence", provider, launched: launched.bin, reference: null });
        }
      }

      if (required && lv.known && compareVersions(lv.value, required) < 0) {
        out.findings.push({ kind: "cli_outdated", provider, launched: launched.bin, required });
      }
    }
  }

  // S2-AC4: the primary credential file — owner and readability from metadata.
  const serviceName = deps.service.name ?? deps.userName(deps.service.uid) ?? `uid:${deps.service.uid}`;
  let primary: DoctorStat | null = null;
  let primaryPath: string | null = null;
  for (const rel of run.credentialRelPaths(provider)) {
    const path = join(deps.service.home, rel);
    const st = fsTry(() => deps.stat(path));
    if (st.ok) {
      if (!st.value.isFile) continue;
      primary = st.value;
      primaryPath = path;
      break;
    }
    if (!st.absent) {
      unchecked("credential_access", st.reason, run.place(path));
      break;
    }
  }
  if (primary && primaryPath) {
    const file = run.file(primaryPath, primary);
    if (primary.uid !== deps.service.uid) {
      out.findings.push({ kind: "credential_foreign_owner", provider, file, serviceUser: serviceName });
    }
    if (!run.serviceCanRead(primary)) {
      out.findings.push({ kind: "credential_unreadable", provider, file, serviceUser: serviceName });
    }
  }

  // S2-AC3: independent copies in the fixed scan list.
  scanHome(run, deps, provider, deps.service.home, primary, out, primaryPath);
  const rootHome = deps.rootHome ?? "/root";
  if (deps.service.home !== rootHome) scanHome(run, deps, provider, rootHome, primary, out, null);

  const homesRoot = deps.homesRoot ?? "/home";
  const users = fsTry(() => deps.readdir(homesRoot));
  if (!users.ok) {
    if (!users.absent) unchecked("credential_copies", users.reason, run.place(homesRoot));
  } else {
    for (const user of [...users.value].sort()) {
      const home = join(homesRoot, user);
      if (home === deps.service.home || home === rootHome) continue;
      scanHome(run, deps, provider, home, primary, out, null);
    }
  }

  if (provider === "codex") {
    const sessionsRoot = join(deps.companionHome, "codex-home");
    const sessions = fsTry(() => deps.readdir(sessionsRoot));
    if (!sessions.ok) {
      if (!sessions.absent) unchecked("credential_copies", sessions.reason, run.place(sessionsRoot));
    } else {
      for (const id of [...sessions.value].sort()) {
        const path = join(sessionsRoot, id, CODEX_CREDENTIAL_FILE_NAME);
        const copy = candidateCopy(run, deps, path, primary);
        if (copy === null) continue;
        if ("reason" in copy) unchecked("credential_copies", copy.reason, run.place(path));
        else out.findings.push({ kind: "credential_copy", provider, copy: copy.file });
      }
    }
  }

  return out;
}

export async function runDoctorChecks(deps: DoctorDeps): Promise<DoctorReport> {
  const run = new DoctorRun(deps);
  const results = await Promise.all(PROVIDER_IDS.map((id) => checkProvider(run, deps, id)));
  const providers = Object.fromEntries(results.map((r) => [r.provider, r])) as Record<ProviderId, ProviderDoctorResult>;
  return {
    checkedAt: deps.now(),
    computedBy: deps.computedBy,
    serviceUser: deps.service.name ?? deps.userName(deps.service.uid),
    providers,
  };
}
