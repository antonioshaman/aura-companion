import { hasAnyClaudeAuthEnv, hasNonEmptyEnvVar } from "../provider-auth-env.js";
import {
  knownField,
  unknownField,
  type AuthLoginMethod,
  type Known,
  type NotVerifiedReason,
  type ProviderAuthState,
  type ProviderAuthStatus,
  type ProviderId,
} from "./auth-types.js";
import type { ClaudeUsageOutcome } from "./claude-usage-request.js";
import type {
  ClaudeOAuthLocation,
  ClaudeOAuthSecret,
  CodexAuthLocation,
  CredentialFileMeta,
} from "./credential-locator.js";
import type { BoundedProbeResult, ProbeOptions } from "./probe-runner.js";

/**
 * Provider probes: one concrete function per CLI (no plugin interface).
 *
 * Fail-closed (EC-17): anything not positively understood ends as
 * `not_verified`, never as `working` or `invalid`. Only allowlisted fields are
 * read from CLI output; raw output never leaves this module.
 *
 * Rotation guard (plan task 4, preventive):
 *  1. a CLI status command runs only for an exact (CLI, version) pair proven
 *     NOT to refresh/write credentials — see PROVEN_STATUS_PROBE_VERSIONS;
 *  2. nothing runs when the local access token is expired or within
 *     EXPIRY_MARGIN_MS of expiring;
 *  3. second line: the credential file's (dev, ino, size, mtime) is compared
 *     before/after; any change disables the probe until process restart and
 *     emits a structured event.
 */

/**
 * (CLI, version) pairs whose status command is PROVEN not to refresh or write
 * credentials. Evidence (2026-11-13/14, this repo's 1a session, synthetic
 * credentials only, isolated HOME via `mktemp -d`, `bwrap --unshare-net`,
 * `strace -e connect,openat,rename*`, plus a refusing logging HTTPS proxy):
 *
 * | CLI    | version | command        | expired token result                                             |
 * |--------|---------|----------------|------------------------------------------------------------------|
 * | claude | 2.1.283 | `auth status`  | file dev/ino/size/mtime/sha unchanged; 0 HTTP requests via proxy; |
 * |        |         |                | token endpoint platform.claude.com never resolved                  |
 * | codex  | 0.162.1 | `login status` | file unchanged (also with last_refresh 30 days old); 0 connects   |
 *
 * A new CLI version is `not_verified` (no spawn) until the experiment is
 * re-run and the version appended here.
 */
export const PROVEN_STATUS_PROBE_VERSIONS: Readonly<Record<ProviderId, readonly string[]>> = {
  claude: ["2.1.283"],
  codex: ["0.162.1"],
};

/** Constant argv — nothing here is ever request-derived. */
export const STATUS_PROBE_ARGV: Readonly<Record<ProviderId, readonly string[]>> = {
  claude: ["auth", "status"],
  codex: ["login", "status"],
};
export const VERSION_ARGV: readonly string[] = ["--version"];

/** How old a Codex rate-limits read may be to count as provider evidence. */
export const STATUS_TTL_FOR_EVIDENCE_MS = 5 * 60 * 1000;

/** Treat a token expiring within this margin as already expired (rotation guard 2). */
export const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export interface ProbeEvent {
  event: "auth_probe.rotation_detected" | "auth_probe.skipped";
  provider: ProviderId;
  reason?: NotVerifiedReason;
  cliVersion?: string;
}

export interface CodexProviderEvidence {
  /** Epoch ms the provider answered. */
  checkedAt: number;
  /** `credentialFingerprint()` of the access token the session used. */
  credentialFingerprint: string;
}

export interface ProviderProbeDeps {
  env: NodeJS.ProcessEnv;
  settings: { claudeCodeOAuthToken: string; anthropicApiKey: string; openaiApiKey: string };
  now: () => number;
  resolveBinary: (name: string) => string | null;
  runProbe: (binaryPath: string, args: readonly string[], opts?: ProbeOptions) => Promise<BoundedProbeResult>;
  locateClaude: (env: NodeJS.ProcessEnv) => ClaudeOAuthLocation | null;
  locateCodex: (env: NodeJS.ProcessEnv) => CodexAuthLocation | null;
  readClaudeSecret: (env: NodeJS.ProcessEnv) => Pick<ClaudeOAuthSecret, "accessToken" | "expiresAt"> | null;
  requestClaudeUsage: (accessToken: string) => Promise<ClaudeUsageOutcome>;
  statMeta: (path: string) => CredentialFileMeta | null;
  /**
   * Codex has no token-free provider endpoint we call directly; its app-server
   * returns `account/rateLimits/read` inside live sessions. Latest successful
   * read, with the fingerprint of the credentials that session used. It only
   * counts when that fingerprint equals the PRIMARY auth.json's — a session
   * running on its own (older) copy must not vouch for the main sign-in.
   */
  codexProviderEvidence?: () => CodexProviderEvidence | null;
  provenVersions?: Readonly<Record<ProviderId, readonly string[]>>;
  onEvent?: (event: ProbeEvent) => void;
}

// Rotation guard 3: once tripped, stays tripped for the process lifetime.
const rotationTripped = new Set<ProviderId>();
export function _resetRotationGuardForTests(): void {
  rotationTripped.clear();
}

function sameFile(a: CredentialFileMeta | null, b: CredentialFileMeta | null): boolean {
  if (!a || !b) return a === b;
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Strict version parse: first `X.Y.Z` in `--version` output, else null. */
export function parseCliVersion(stdout: string): string | null {
  const m = /\b(\d+\.\d+\.\d+)\b/.exec(stdout);
  return m ? m[1] : null;
}

interface StatusSeed {
  provider: ProviderId;
  method: Known<AuthLoginMethod>;
  account: Known<string>;
  plan: Known<string>;
  tokenExpiresAt: Known<number>;
  cliPath: Known<string>;
  cliVersion: Known<string>;
}

function result(
  seed: StatusSeed,
  state: ProviderAuthState,
  reason: NotVerifiedReason | null,
  checkedAt: number,
  verifiedBy: "provider" | "local",
  /** When the provider actually accepted the credentials, if earlier than `checkedAt`. */
  successAt: number = checkedAt,
): ProviderAuthStatus {
  return {
    provider: seed.provider,
    state,
    reason: state === "not_verified" ? reason ?? "probe_inconclusive" : null,
    account: seed.account,
    plan: seed.plan,
    method: seed.method,
    tokenExpiresAt: seed.tokenExpiresAt,
    lastSuccessAt: state === "working" ? successAt : null,
    checkedAt,
    verifiedBy,
    cli: { path: seed.cliPath, version: seed.cliVersion },
  };
}

/** Resolve + `--version` + proven-list gate. Returns the binary path or a skip reason. */
async function gateCli(
  seed: StatusSeed,
  deps: ProviderProbeDeps,
): Promise<{ ok: true; path: string } | { ok: false; reason: NotVerifiedReason }> {
  const path = deps.resolveBinary(seed.provider);
  if (!path) return { ok: false, reason: "cli_missing" };
  seed.cliPath = knownField(path);
  const ver = await deps.runProbe(path, VERSION_ARGV, { env: deps.env });
  const version = ver.kind === "exited" && ver.exitCode === 0 ? parseCliVersion(ver.stdout) : null;
  if (!version) return { ok: false, reason: ver.kind === "spawn_error" ? "cli_missing" : "probe_inconclusive" };
  seed.cliVersion = knownField(version);
  const proven = (deps.provenVersions ?? PROVEN_STATUS_PROBE_VERSIONS)[seed.provider];
  if (!proven.includes(version)) return { ok: false, reason: "cli_version_unproven" };
  return { ok: true, path };
}

/** Run the status command with the before/after metadata snapshot (guard 3). */
async function runGuardedStatus(
  seed: StatusSeed,
  path: string,
  credentialPath: string,
  deps: ProviderProbeDeps,
): Promise<{ ok: true; stdout: string; stderr: string; exitCode: number | null } | { ok: false; reason: NotVerifiedReason }> {
  const before = deps.statMeta(credentialPath);
  const run = await deps.runProbe(path, STATUS_PROBE_ARGV[seed.provider], { env: deps.env });
  const after = deps.statMeta(credentialPath);
  if (!sameFile(before, after)) {
    rotationTripped.add(seed.provider);
    deps.onEvent?.({
      event: "auth_probe.rotation_detected",
      provider: seed.provider,
      cliVersion: seed.cliVersion.known ? seed.cliVersion.value : undefined,
    });
    return { ok: false, reason: "rotation_detected" };
  }
  if (run.kind !== "exited") return { ok: false, reason: "probe_inconclusive" };
  return { ok: true, stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode };
}

function skip(seed: StatusSeed, reason: NotVerifiedReason, deps: ProviderProbeDeps): ProviderAuthStatus {
  deps.onEvent?.({ event: "auth_probe.skipped", provider: seed.provider, reason });
  return result(seed, "not_verified", reason, deps.now(), "local");
}

function locallyExpired(expiresAt: number | null, now: number): boolean {
  // Unknown expiry cannot be proven safe → treated as expired (fail-closed).
  return expiresAt === null || expiresAt - EXPIRY_MARGIN_MS <= now;
}

// ─── Claude ───────────────────────────────────────────────────────────────────

/** Allowlisted fields of `claude auth status` JSON. Anything else is ignored. */
export interface ClaudeAuthStatusFields {
  loggedIn: boolean;
  authMethod: string | null;
  email: string | null;
  subscriptionType: string | null;
}

export function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatusFields | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.loggedIn !== "boolean") return null;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  return { loggedIn: o.loggedIn, authMethod: str(o.authMethod), email: str(o.email), subscriptionType: str(o.subscriptionType) };
}

export async function probeClaudeAuth(deps: ProviderProbeDeps): Promise<ProviderAuthStatus> {
  const seed: StatusSeed = {
    provider: "claude",
    method: unknownField,
    account: unknownField,
    plan: unknownField,
    tokenExpiresAt: unknownField,
    cliPath: unknownField,
    cliVersion: unknownField,
  };
  // Precedence mirrors the CLI: env > companion OAuth token > companion API key > OAuth file.
  if (hasAnyClaudeAuthEnv(deps.env) || deps.settings.claudeCodeOAuthToken.trim()) {
    seed.method = knownField("env_token");
    return skip(seed, "no_provider_check", deps);
  }
  if (deps.settings.anthropicApiKey.trim()) {
    seed.method = knownField("api_key");
    return skip(seed, "no_provider_check", deps);
  }
  const loc = deps.locateClaude(deps.env);
  if (!loc) return result(seed, "not_signed_in", null, deps.now(), "local");

  seed.method = knownField("subscription");
  if (loc.subscriptionType) seed.plan = knownField(loc.subscriptionType);
  if (loc.expiresAt !== null) seed.tokenExpiresAt = knownField(loc.expiresAt);

  if (rotationTripped.has("claude")) return skip(seed, "rotation_detected", deps);
  if (locallyExpired(loc.expiresAt, deps.now())) return skip(seed, "token_expired_locally", deps);

  const gate = await gateCli(seed, deps);
  if (!gate.ok) return skip(seed, gate.reason, deps);

  const status = await runGuardedStatus(seed, gate.path, loc.meta.path, deps);
  if (!status.ok) return skip(seed, status.reason, deps);
  const fields = status.exitCode === 0 ? parseClaudeAuthStatus(status.stdout) : null;
  if (!fields || !fields.loggedIn) return skip(seed, "probe_inconclusive", deps);
  if (fields.email) seed.account = knownField(fields.email);
  if (fields.subscriptionType) seed.plan = knownField(fields.subscriptionType);

  // Provider check: the token-free usage request with the non-expired token.
  const secret = deps.readClaudeSecret(deps.env);
  if (!secret || locallyExpired(secret.expiresAt, deps.now())) return skip(seed, "token_expired_locally", deps);
  const outcome = await deps.requestClaudeUsage(secret.accessToken);
  const checkedAt = deps.now();
  switch (outcome.kind) {
    case "ok": return result(seed, "working", null, checkedAt, "provider");
    case "rejected": return result(seed, "invalid", null, checkedAt, "provider");
    case "network": return result(seed, "no_network", null, checkedAt, "local");
    case "http": return result(seed, "not_verified", "probe_inconclusive", checkedAt, "local");
  }
}

// ─── Codex ────────────────────────────────────────────────────────────────────

export type CodexLoginStatus = "chatgpt" | "api_key" | "not_logged_in";

/** Allowlisted parse of `codex login status` (codex prints it on stderr). */
export function parseCodexLoginStatus(text: string): CodexLoginStatus | null {
  if (/^Logged in using ChatGPT\b/m.test(text)) return "chatgpt";
  if (/^Logged in using an API key\b/m.test(text)) return "api_key";
  if (/^Not logged in\b/m.test(text)) return "not_logged_in";
  return null;
}

export async function probeCodexAuth(deps: ProviderProbeDeps): Promise<ProviderAuthStatus> {
  const seed: StatusSeed = {
    provider: "codex",
    method: unknownField,
    account: unknownField,
    plan: unknownField,
    tokenExpiresAt: unknownField,
    cliPath: unknownField,
    cliVersion: unknownField,
  };
  if (hasNonEmptyEnvVar(deps.env, "OPENAI_API_KEY") || hasNonEmptyEnvVar(deps.env, "CODEX_API_KEY")) {
    seed.method = knownField("env_token");
    return skip(seed, "no_provider_check", deps);
  }
  if (deps.settings.openaiApiKey.trim()) {
    seed.method = knownField("api_key");
    return skip(seed, "no_provider_check", deps);
  }
  const loc = deps.locateCodex(deps.env);
  if (!loc) return result(seed, "not_signed_in", null, deps.now(), "local");

  if (loc.authMode === "chatgpt") seed.method = knownField("subscription");
  else if (loc.authMode === "api_key") seed.method = knownField("api_key");
  if (loc.email) seed.account = knownField(loc.email);
  if (loc.planType) seed.plan = knownField(loc.planType);
  if (loc.accessTokenExpiresAt !== null) seed.tokenExpiresAt = knownField(loc.accessTokenExpiresAt);

  if (rotationTripped.has("codex")) return skip(seed, "rotation_detected", deps);
  // An API-key auth.json has no expiring token; a ChatGPT one must be provably fresh.
  if (loc.authMode !== "api_key" && locallyExpired(loc.accessTokenExpiresAt, deps.now())) {
    return skip(seed, "token_expired_locally", deps);
  }

  const gate = await gateCli(seed, deps);
  if (!gate.ok) return skip(seed, gate.reason, deps);

  const status = await runGuardedStatus(seed, gate.path, loc.meta.path, deps);
  if (!status.ok) return skip(seed, status.reason, deps);
  const login = status.exitCode === 0 ? parseCodexLoginStatus(`${status.stdout}\n${status.stderr}`) : null;
  if (!login || login === "not_logged_in") return skip(seed, "probe_inconclusive", deps);
  seed.method = knownField(login === "chatgpt" ? "subscription" : "api_key");

  // Provider evidence: a recent app-server `account/rateLimits/read` made
  // with the SAME credential generation as the primary auth.json. Anything
  // else (no evidence, other generation, stale, future-dated) stays honestly
  // `not_verified`.
  const evidence = deps.codexProviderEvidence?.() ?? null;
  const now = deps.now();
  if (
    evidence !== null
    && loc.credentialFingerprint !== null
    && evidence.credentialFingerprint === loc.credentialFingerprint
    // EC-38 (anomaly form): a future-dated read is not evidence, so clock skew can never keep it fresh.
    && evidence.checkedAt <= now
    && now - evidence.checkedAt <= STATUS_TTL_FOR_EVIDENCE_MS
  ) {
    return result(seed, "working", null, now, "provider", evidence.checkedAt);
  }
  return result(seed, "not_verified", "no_provider_check", now, "local");
}
