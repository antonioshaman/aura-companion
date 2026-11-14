import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeAuthState,
  describeDoctorClear,
  describeDoctorFinding,
  describeDoctorUnchecked,
  doctorPlaceLabel,
  formatAction,
  formatKnown,
  providerLabel,
} from "../server/auth-status/auth-catalog.js";
import {
  PROVIDER_IDS,
  assertNever,
  type CatalogEntry,
  type DoctorBinary,
  type DoctorFile,
  type DoctorFinding,
  type DoctorPlace,
  type DoctorReport,
  type ProviderAuthStatus,
} from "../server/auth-status/auth-types.js";
import { doctorExitCode } from "../server/auth-status/doctor-checks.js";
import { parsePasswd } from "../server/auth-status/doctor-service.js";
import type { StatusSnapshot } from "../server/auth-status/status-core.js";

/**
 * `aura-companion auth status` and `aura-companion doctor` (plan task 9).
 *
 * Thin adapter: when the server answers on localhost, print ITS result (so
 * CLI and UI show the same state/account/plan — S1-AC5); otherwise compute
 * the same core locally (identity from the systemd unit). Every title,
 * detail and action comes from `auth-catalog.ts`, the catalog the UI uses.
 * Full paths are printed here — and only here (REST carries home-relative
 * paths; the CLI expands them with the passwd home of `homeUser`).
 */

export interface CliAuthDeps {
  /** Localhost API call; throws when the server is unreachable. */
  fetchJson: (path: string, init?: { method?: string }) => Promise<{ status: number; body: unknown }>;
  localStatus: () => Promise<StatusSnapshot>;
  localDoctor: () => Promise<DoctorReport>;
  /** passwd HOME of a user name (expands REST home-relative paths). */
  homeOf: (user: string) => string | null;
  out: (line: string) => void;
}

export interface CliAuthFlags {
  json: boolean;
  offline: boolean;
}

export function parseCliAuthFlags(argv: readonly string[]): CliAuthFlags {
  return { json: argv.includes("--json"), offline: argv.includes("--offline") };
}

type LocalWhy = "offline_flag" | "unreachable" | "unsupported" | "no_result";
type Source = { kind: "server" } | { kind: "local"; why: LocalWhy };

/** The running server answered but has no such route (older build). */
class ServerUnsupported extends Error {}

function failureWhy(err: unknown): LocalWhy {
  return err instanceof ServerUnsupported ? "unsupported" : "unreachable";
}

function sourceLine(source: Source, serviceUser: string | null): string {
  const user = serviceUser ? ` as service user ${serviceUser}` : "";
  if (source.kind === "server") return `Source: running server${user}`;
  const why = {
    offline_flag: "--offline",
    unreachable: "server not reachable",
    unsupported: "running server does not support this yet",
    no_result: "server had no result",
  }[source.why];
  return `Source: computed locally${user} (${why})`;
}

function entryLines(entry: CatalogEntry, indent: string): string[] {
  const lines = [`${indent}${entry.detail}`];
  const action = formatAction(entry.action);
  if (action) lines.push(`${indent}Action: ${action}`);
  return lines;
}

const iso = (ms: number) => new Date(ms).toISOString();

// ─── auth status ──────────────────────────────────────────────────────────────

export function renderStatus(snapshot: StatusSnapshot, source: Source): string[] {
  const lines: string[] = [];
  const serviceUser = PROVIDER_IDS.map((id) => snapshot.providers[id].serviceUser).find(Boolean) ?? null;
  lines.push(sourceLine(source, serviceUser));
  for (const id of PROVIDER_IDS) {
    const s: ProviderAuthStatus = snapshot.providers[id];
    const entry = describeAuthState(s.state, s.provider, s.reason);
    lines.push("", entry.title);
    lines.push(
      `  Account: ${formatKnown(s.account)} · Plan: ${formatKnown(s.plan)} · Sign-in: ${formatKnown(s.method)}`,
      `  Token expires: ${formatKnown(s.tokenExpiresAt, iso)} · Last successful check: ${s.lastSuccessAt === null ? "never" : iso(s.lastSuccessAt)}`,
      `  Checked: ${iso(s.checkedAt)} (${s.verifiedBy === "provider" ? "with the provider" : "local only"}) · CLI: ${formatKnown(s.cli.path)} ${formatKnown(s.cli.version)}`,
    );
    if (s.serviceUser) lines.push(`  Service user: ${s.serviceUser}`);
    lines.push(...entryLines(entry, "  "));
  }
  return lines;
}

/** Non-zero when a provider has credentials the provider rejects or none at all. */
export function statusExitCode(snapshot: StatusSnapshot): 0 | 1 {
  return PROVIDER_IDS.some((id) => ["invalid", "not_signed_in"].includes(snapshot.providers[id].state)) ? 1 : 0;
}

async function serverStatus(deps: CliAuthDeps): Promise<StatusSnapshot | null> {
  // POST = explicit recheck (rate-limited server-side); 429 still carries the cached snapshot.
  const res = await deps.fetchJson("/api/llm-auth/recheck", { method: "POST" });
  const fromBody = (body: unknown) => (body as { status?: StatusSnapshot | null } | null)?.status ?? null;
  if (res.status === 200 || res.status === 429) {
    const snap = fromBody(res.body);
    if (snap) return snap;
    const cached = await deps.fetchJson("/api/llm-auth/status");
    return cached.status === 200 ? fromBody(cached.body) : null;
  }
  if (res.status === 404) throw new ServerUnsupported();
  throw new Error(`unexpected status ${res.status}`);
}

export async function runAuthStatusCommand(argv: readonly string[], deps: CliAuthDeps): Promise<number> {
  const flags = parseCliAuthFlags(argv);
  let snapshot: StatusSnapshot | null = null;
  let source: Source = { kind: "local", why: "offline_flag" };
  if (!flags.offline) {
    try {
      snapshot = await serverStatus(deps);
      source = snapshot ? { kind: "server" } : { kind: "local", why: "no_result" };
    } catch (err) {
      source = { kind: "local", why: failureWhy(err) };
    }
  }
  snapshot ??= await deps.localStatus();
  if (flags.json) deps.out(JSON.stringify({ source: source.kind, ...snapshot }, null, 2));
  else renderStatus(snapshot, source).forEach((l) => deps.out(l));
  return statusExitCode(snapshot);
}

// ─── doctor ───────────────────────────────────────────────────────────────────

/** Full path: in-process `absPath`, else REST place expanded with the passwd HOME. */
export function fullPath(place: DoctorPlace, homeOf: (user: string) => string | null): string {
  if (place.absPath) return place.absPath;
  if (place.homeUser === null) return place.relPath;
  const home = homeOf(place.homeUser);
  return home ? join(home, place.relPath) : `~${place.homeUser}/${place.relPath}`;
}

function fileLine(file: DoctorFile, homeOf: CliAuthDeps["homeOf"]): string {
  return `${fullPath(file, homeOf)} (owner ${file.owner}, mode ${file.mode.toString(8).padStart(4, "0")}, ${doctorPlaceLabel(file.place)})`;
}

function binaryLine(bin: DoctorBinary, homeOf: CliAuthDeps["homeOf"]): string {
  const at = fullPath(bin.location, homeOf);
  const target = fullPath(bin.target, homeOf);
  return `${at}${target !== at ? ` → ${target}` : ""} (version ${formatKnown(bin.version)}, owner ${bin.target.owner})`;
}

function findingFacts(f: DoctorFinding, homeOf: CliAuthDeps["homeOf"]): string[] {
  switch (f.kind) {
    case "binary_divergence":
      return [
        `Sessions launch: ${binaryLine(f.launched, homeOf)}`,
        `Service user's install: ${f.reference ? binaryLine(f.reference, homeOf) : "none"}`,
      ];
    case "cli_outdated":
      return [`Sessions launch: ${binaryLine(f.launched, homeOf)}`, `Required: ${f.required} or newer`];
    case "credential_copy":
      return [`Copy: ${fileLine(f.copy, homeOf)}`, "Contents were not read."];
    case "credential_foreign_owner":
    case "credential_unreadable":
      return [`File: ${fileLine(f.file, homeOf)}`, `Service user: ${f.serviceUser}`];
    default:
      return assertNever(f);
  }
}

export function renderDoctor(report: DoctorReport, source: Source, homeOf: CliAuthDeps["homeOf"]): string[] {
  const lines = [sourceLine(source, report.serviceUser), `Checked: ${iso(report.checkedAt)}`];
  for (const id of PROVIDER_IDS) {
    const r = report.providers[id];
    lines.push("", providerLabel(id));
    lines.push(
      `  CLI: ${r.launched ? binaryLine(r.launched, homeOf) : "not found on the service PATH"} · required: ${formatKnown(r.requiredVersion, (v) => `${v} or newer`)}`,
    );
    for (const f of r.findings) {
      const entry = describeDoctorFinding(f.kind, id);
      lines.push(`  ✗ ${entry.title}`);
      for (const fact of findingFacts(f, homeOf)) lines.push(`    ${fact}`);
      lines.push(...entryLines(entry, "    "));
    }
    for (const u of r.unchecked) {
      const entry = describeDoctorUnchecked(u.check, u.reason, id);
      lines.push(`  ? ${entry.title}${u.place ? `: ${fullPath(u.place, homeOf)}` : ""}`);
      lines.push(...entryLines(entry, "    "));
    }
    if (r.findings.length === 0 && r.unchecked.length === 0) lines.push(`  ✓ ${describeDoctorClear(id).title}`);
  }
  return lines;
}

async function serverDoctor(deps: CliAuthDeps): Promise<DoctorReport | null> {
  const res = await deps.fetchJson("/api/llm-auth/doctor/recheck", { method: "POST" });
  if (res.status === 404) throw new ServerUnsupported();
  if (res.status !== 200 && res.status !== 429) throw new Error(`unexpected status ${res.status}`);
  return (res.body as { report?: DoctorReport | null } | null)?.report ?? null;
}

export async function runDoctorCommand(argv: readonly string[], deps: CliAuthDeps): Promise<number> {
  const flags = parseCliAuthFlags(argv);
  let report: DoctorReport | null = null;
  let source: Source = { kind: "local", why: "offline_flag" };
  if (!flags.offline) {
    try {
      report = await serverDoctor(deps);
      source = report ? { kind: "server" } : { kind: "local", why: "no_result" };
    } catch (err) {
      source = { kind: "local", why: failureWhy(err) };
    }
  }
  report ??= await deps.localDoctor();
  if (flags.json) deps.out(JSON.stringify({ source: source.kind, ...report }, null, 2));
  else renderDoctor(report, source, deps.homeOf).forEach((l) => deps.out(l));
  return doctorExitCode(report);
}

// ─── Production deps ─────────────────────────────────────────────────────────

export function defaultCliAuthDeps(port: number): CliAuthDeps {
  let passwd: Map<string, string> | null = null;
  return {
    fetchJson: async (path, init) => {
      const res = await fetch(`http://localhost:${port}${path}`, {
        method: init?.method ?? "GET",
        signal: AbortSignal.timeout(30_000),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    localStatus: async () => {
      const { createAuthStatusCore } = await import("../server/auth-status/service-status.js");
      return createAuthStatusCore({ mode: "local_cli" }).get();
    },
    localDoctor: async () => {
      const { createDoctorRunner } = await import("../server/auth-status/doctor-service.js");
      return createDoctorRunner({ mode: "local_cli" }).get();
    },
    homeOf: (user) => {
      if (!passwd) {
        passwd = new Map();
        try {
          for (const e of parsePasswd(readFileSync("/etc/passwd", "utf-8"))) passwd.set(e.name, e.home);
        } catch { /* no passwd: fall back to ~user/ */ }
      }
      return passwd.get(user) ?? null;
    },
    out: (line) => console.log(line),
  };
}

export function cliPort(argv: readonly string[]): number {
  const i = argv.indexOf("--port");
  const raw = i !== -1 ? Number(argv[i + 1]) : Number(process.env.COMPANION_PORT);
  return Number.isInteger(raw) && raw > 0 ? raw : 3456;
}
