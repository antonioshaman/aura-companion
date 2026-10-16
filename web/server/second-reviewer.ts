/**
 * W15 multi-model review — the host-run "second opinion" reviewer.
 *
 * Design choice (option A, not a second observer session): on each
 * in-scope checkpoint the host runs ONE headless, read-only CLI invocation
 * on the second backend/model (`claude -p` / `codex exec`), with the same
 * observer system prompt and the same wake text the observer gets. Its
 * final message is a findings array; the host stamps the envelope exactly
 * like `observer-reply.ts` does (plus `reviewer_role: "second"`) and writes
 * it to `.council/reviews/<phase>-<group>-second-<provider>-observer.md`,
 * then hands it to the EXISTING review pipeline (`handleCouncilReview`):
 * grounding, disputes, frozen verdicts, `group:review` fan-out, banner. The
 * file on disk feeds the REST bootstrap and the auto-proceed hold restore.
 *
 * Why not a second long-lived observer session: it would double every piece
 * of observer lifecycle machinery (spawn, auto-heal, wake queue, probes,
 * reconnect grace, degrade, EC-2 kill ordering) for a reviewer that has no
 * conversational state worth keeping. A one-shot process has none of that:
 * it either writes a review, or fails/times out and is logged — it can
 * never degrade the pair.
 *
 * Read-only by construction (EC-1 spirit, enforced at argv):
 *  - claude: `--tools Read,Grep,Glob` (the only tools that exist in the
 *    process), the same list in `--allowedTools`, an explicit
 *    `--disallowedTools` denylist, `--permission-mode dontAsk` (anything not
 *    pre-approved is denied, never prompted), `--strict-mcp-config` (no MCP
 *    servers) and `--no-session-persistence`.
 *  - codex: `--sandbox read-only` (+ `approval_policy="never"`), `--ephemeral`.
 *
 * Bounded: one run per group at a time (a newer checkpoint waits in a
 * newest-wins slot; the superseded one is logged), a hard timeout, and a
 * per-backend cooldown after a usage-limit answer. Every decision logs one
 * structured line: `council.second_review.{dispatched,completed,skipped,failed}`
 * with sessionGroupId, checkpointId, backend, model (EC-9).
 */

import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CheckpointPayload,
  type ObserverReviewPayload,
  STALE_REVIEW_SLACK_MS,
  parseObserverReviewPayload,
} from "./council-types.js";
import { buildHostObserverReview, extractObserverFindings } from "./observer-reply.js";
import { buildObserverContextManifest, buildObserverWakePayload } from "./observer-prompt.js";
import type { ClaimLanguage } from "./observer-language.js";
import { buildSecondReviewFilename, isSecondReviewFilename, OBSERVER_REVIEW_FILE_PATTERN } from "./review-watcher.js";
import { isClaudeUsageLimitText, parseResetFromText } from "./usage-limit-parse.js";
import { CLAUDE_AUTH_ENV_VARS } from "./provider-auth-env.js";
import {
  type ResolvedSecondReviewer,
  type SecondReviewerBackend,
  type SecondReviewerConfig,
  isPhaseInSecondReviewScope,
  resolveSecondReviewer,
} from "./second-reviewer-config.js";
import { log } from "./logger.js";

/** Hard ceiling on one second-review run (env `COMPANION_SECOND_REVIEW_TIMEOUT_MS`). */
export const DEFAULT_SECOND_REVIEW_TIMEOUT_MS = 10 * 60_000;
/** Process-wide concurrent second reviews (env `COMPANION_SECOND_REVIEW_MAX_CONCURRENCY`). */
export const DEFAULT_SECOND_REVIEW_MAX_CONCURRENCY = 2;
/** Cooldown after a usage-limit answer when the reset time cannot be parsed. */
export const SECOND_REVIEW_LIMIT_COOLDOWN_MS = 60 * 60_000;
/** Bytes of stdout/stderr kept from a run (the reply itself is small). */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

/** The ONLY tools a claude second reviewer has. */
export const SECOND_REVIEW_CLAUDE_TOOLS: readonly string[] = Object.freeze(["Read", "Grep", "Glob"]);
/** Explicit denylist on top of `--tools` (defence in depth + static-grep canary). */
export const SECOND_REVIEW_CLAUDE_DISALLOWED_TOOLS: readonly string[] = Object.freeze([
  "Bash",
  "BashOutput",
  "KillShell",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Task",
]);

const SECOND_REVIEW_PREAMBLE =
  "Second-opinion review: you review this checkpoint independently of the pair's observer, " +
  "on a different model. Do not assume anyone else will catch what you skip. " +
  "You cannot write files; your final message is the findings array.";

// ── Pure: argv ──────────────────────────────────────────────────────────────

export interface SecondReviewInvocation {
  /** argv[0] is the resolved binary. */
  cmd: string[];
  /** Text written to the process's stdin. */
  stdin: string;
  /** codex only: the file `--output-last-message` writes the reply to. */
  lastMessageFile?: string;
}

/**
 * Build the read-only argv for one second-review run. Pure: binary path,
 * workspace and prompt are inputs; nothing is resolved here.
 */
export function buildSecondReviewInvocation(args: {
  reviewer: ResolvedSecondReviewer;
  binary: string;
  cwd: string;
  systemPrompt: string;
  wakeText: string;
  /** codex only: where `--output-last-message` writes. */
  lastMessageFile?: string;
}): SecondReviewInvocation {
  const { reviewer, binary, cwd, systemPrompt, wakeText } = args;
  const userText = `${SECOND_REVIEW_PREAMBLE}\n\n${wakeText}`;
  if (reviewer.backend === "claude") {
    return {
      cmd: [
        binary,
        "-p",
        "--output-format", "json",
        ...(reviewer.model ? ["--model", reviewer.model] : []),
        "--tools", SECOND_REVIEW_CLAUDE_TOOLS.join(","),
        "--allowedTools", SECOND_REVIEW_CLAUDE_TOOLS.join(","),
        "--disallowedTools", SECOND_REVIEW_CLAUDE_DISALLOWED_TOOLS.join(","),
        "--permission-mode", "dontAsk",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--append-system-prompt", systemPrompt,
      ],
      stdin: userText,
    };
  }
  if (!args.lastMessageFile) throw new Error("buildSecondReviewInvocation: codex needs lastMessageFile");
  return {
    cmd: [
      binary,
      "exec",
      "--sandbox", "read-only",
      "-c", 'approval_policy="never"',
      // Belt and braces: the read-only sandbox already has no network
      // (verified: `curl` → "Could not resolve host" inside it); this keeps it
      // off even if the sandbox mode is ever widened.
      "-c", "sandbox_workspace_write.network_access=false",
      "--skip-git-repo-check",
      "--ephemeral",
      "--color", "never",
      "--json",
      "--cd", cwd,
      "--output-last-message", args.lastMessageFile,
      ...(reviewer.model ? ["--model", reviewer.model] : []),
      "-",
    ],
    // `codex exec` has no system-prompt flag: the observer prompt leads the
    // input, separated from the wake by a rule.
    stdin: `${systemPrompt}\n\n---\n\n${userText}`,
    lastMessageFile: args.lastMessageFile,
  };
}

// ── Pure: output parsing ────────────────────────────────────────────────────

export type SecondReviewOutput =
  | { ok: true; text: string; model?: string }
  | { ok: false; reason: "usage_limited"; detail: string }
  | { ok: false; reason: "cli_error"; detail: string };

function lastJsonObject(text: string, accept: (o: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const o = JSON.parse(line) as unknown;
      if (typeof o === "object" && o !== null && !Array.isArray(o) && accept(o as Record<string, unknown>)) {
        return o as Record<string, unknown>;
      }
    } catch {
      // not a JSON line
    }
  }
  // `--output-format json` may pretty-print across lines: try the whole text.
  try {
    const o = JSON.parse(text.trim()) as unknown;
    if (typeof o === "object" && o !== null && !Array.isArray(o) && accept(o as Record<string, unknown>)) {
      return o as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return null;
}

const CODEX_LIMIT_PATTERN = /usage limit|rate limit|hit your .*limit|quota exceeded|insufficient_quota/i;

/**
 * Turn one run's raw output into the reply text (or a reasoned failure).
 * claude: the `--output-format json` result object (`result` is the reply,
 * `modelUsage` names the model that answered — a host fact).
 * codex: the `--output-last-message` file; `--json` stdout is only scanned
 * for a usage-limit error and the model id.
 */
export function parseSecondReviewOutput(
  backend: SecondReviewerBackend,
  raw: { stdout: string; stderr: string; exitCode: number | null; lastMessage?: string | null },
): SecondReviewOutput {
  if (backend === "claude") {
    const result = lastJsonObject(raw.stdout, (o) => o.type === "result");
    const resultText = typeof result?.result === "string" ? result.result : "";
    if (isClaudeUsageLimitText(resultText) || (!result && isClaudeUsageLimitText(raw.stderr))) {
      return { ok: false, reason: "usage_limited", detail: (resultText || raw.stderr).slice(0, 300) };
    }
    if (!result) {
      return { ok: false, reason: "cli_error", detail: `no result object (exit ${raw.exitCode}): ${raw.stderr.slice(0, 300)}` };
    }
    if (result.is_error === true) {
      return { ok: false, reason: "cli_error", detail: `${String(result.subtype ?? "error")}: ${resultText.slice(0, 300)}` };
    }
    let model: string | undefined;
    const usage = result.modelUsage;
    if (typeof usage === "object" && usage !== null) {
      // The answering model is the one that produced the most output (small
      // helper models may appear alongside it).
      let best = -1;
      for (const [id, u] of Object.entries(usage as Record<string, unknown>)) {
        const out = typeof (u as { outputTokens?: unknown })?.outputTokens === "number" ? (u as { outputTokens: number }).outputTokens : 0;
        if (out > best) {
          best = out;
          model = id;
        }
      }
    }
    return { ok: true, text: resultText, ...(model ? { model } : {}) };
  }
  const combined = `${raw.stdout}\n${raw.stderr}`;
  const lastMessage = raw.lastMessage ?? "";
  if (lastMessage.trim().length === 0) {
    if (CODEX_LIMIT_PATTERN.test(combined)) {
      const m = combined.match(/[^\n]*(?:usage limit|rate limit|quota)[^\n]*/i);
      return { ok: false, reason: "usage_limited", detail: (m?.[0] ?? "usage limit").slice(0, 300) };
    }
    return { ok: false, reason: "cli_error", detail: `no final message (exit ${raw.exitCode}): ${raw.stderr.slice(-300)}` };
  }
  let model: string | undefined;
  const withModel = lastJsonObject(raw.stdout, (o) => typeof o.model === "string");
  if (withModel && typeof withModel.model === "string") model = withModel.model;
  return { ok: true, text: lastMessage, ...(model ? { model } : {}) };
}

// ── Pure: environment ───────────────────────────────────────────────────────

/** Variables any CLI needs to run; nothing secret. */
const BASE_ENV_ALLOWLIST = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "TMPDIR"] as const;

/**
 * The second reviewer's environment, built from an ALLOWLIST — never the
 * server's whole env (Sonnet review of PR #372, security STOP): codex keeps a
 * shell inside its sandbox, so every variable it inherits is readable by a
 * prompt-injected reviewer. Server tokens (COMPANION_*, AURA_*), provider API
 * keys, GitHub tokens etc. are never passed.
 *  - codex: authenticates from its home (`CODEX_HOME`, default `~/.codex`) —
 *    no API key in the env.
 *  - claude: has no shell (Read/Grep/Glob only); gets only Claude's own auth
 *    variables (`CLAUDE_AUTH_ENV_VARS`), else its `~/.claude` credentials.
 */
export function buildSecondReviewEnv(
  backend: SecondReviewerBackend,
  source: Record<string, string | undefined>,
  opts: { path: string },
): Record<string, string> {
  const env: Record<string, string> = { PATH: opts.path };
  for (const k of BASE_ENV_ALLOWLIST) {
    const v = source[k];
    if (typeof v === "string" && v.length > 0) env[k] = v;
  }
  if (backend === "codex") {
    const home = source.HOME && source.HOME.length > 0 ? source.HOME : homedir();
    env.CODEX_HOME = source.CODEX_HOME && source.CODEX_HOME.length > 0 ? source.CODEX_HOME : join(home, ".codex");
  } else {
    for (const k of CLAUDE_AUTH_ENV_VARS) {
      const v = source[k];
      if (typeof v === "string" && v.trim().length > 0) env[k] = v;
    }
  }
  return env;
}

/**
 * First launchable model slug from the codex CLI's own models cache
 * (`$CODEX_HOME/models_cache.json`). The config.toml default can be a model a
 * ChatGPT account cannot launch (observed: `gpt-5.5` → HTTP 400), so `auto`
 * and "codex, default model" pin this instead. `undefined` = unknown.
 */
export function readCodexDefaultModel(codexHome: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(codexHome, "models_cache.json"), "utf-8")) as { models?: unknown };
    if (!Array.isArray(parsed.models)) return undefined;
    for (const m of parsed.models) {
      const slug = (m as { slug?: unknown })?.slug;
      if (typeof slug === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(slug)) return slug;
    }
  } catch {
    // no cache / unreadable
  }
  return undefined;
}

// ── Disk: is this checkpoint already second-reviewed? ───────────────────────

/**
 * The group's second-opinion review of `checkpoint` already on disk and not
 * older than the checkpoint's emission (restart / redelivery idempotency).
 */
export function findFreshSecondReview(
  cwd: string,
  sessionGroupId: string,
  checkpoint: Pick<CheckpointPayload, "checkpoint_id" | "emitted_at">,
): string | null {
  const dir = join(cwd, ".council", "reviews");
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => OBSERVER_REVIEW_FILE_PATTERN.test(f) && isSecondReviewFilename(f, sessionGroupId));
  } catch {
    return null;
  }
  const emittedAt = Date.parse(checkpoint.emitted_at);
  for (const file of entries) {
    let payload: ObserverReviewPayload | null = null;
    try {
      payload = parseObserverReviewPayload(readFileSync(join(dir, file), "utf-8"));
    } catch {
      continue;
    }
    if (!payload || payload.reviewer_role !== "second") continue;
    if (payload.session_group_id !== sessionGroupId || payload.checkpoint_id !== checkpoint.checkpoint_id) continue;
    try {
      const mtime = statSync(join(dir, file)).mtimeMs;
      if (Number.isFinite(emittedAt) && mtime < emittedAt - STALE_REVIEW_SLACK_MS) continue;
    } catch {
      // unreadable mtime: the checkpoint id is unique per emission — fresh
    }
    return file;
  }
  return null;
}

// ── Runner ──────────────────────────────────────────────────────────────────

export interface HeadlessRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface HeadlessRunOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  stdin: string;
  timeoutMs: number;
  signal: AbortSignal;
}

/** Bus signal for the convergence tracker: `dispatched` / `queued` = a second
 *  verdict is owed for this checkpoint (queued = waiting behind a running
 *  review); `missing` = it will not come (failed, timed out, limited,
 *  superseded, dropped from the queue). */
export interface SecondReviewBusEvent {
  sessionGroupId: string;
  checkpointId: string;
  status: "dispatched" | "queued" | "missing";
  backend: SecondReviewerBackend;
  model: string;
  reason?: string;
}

export interface SecondReviewerDeps {
  /** Effective config for the group (group file, else global default). */
  getConfig(sessionGroupId: string, cwd: string): SecondReviewerConfig;
  /** Observer system prompt for the workspace (workspace override or bundled). */
  loadSystemPrompt(cwd: string): string;
  /** Absolute path of a CLI binary, or null when not installed. */
  resolveBinary(name: "claude" | "codex"): string | null;
  /** Spawn env for the CLI — an allowlist ({@link buildSecondReviewEnv}), never the server's env. */
  buildEnv(binary: string, backend: SecondReviewerBackend): Record<string, string | undefined>;
  /** Model for a reviewer with none set (codex: {@link readCodexDefaultModel}). */
  defaultModel?(backend: SecondReviewerBackend): string | undefined;
  /** Process-wide cap on concurrent runs (default {@link DEFAULT_SECOND_REVIEW_MAX_CONCURRENCY}). */
  maxConcurrency?: number;
  run(cmd: string[], opts: HeadlessRunOptions): Promise<HeadlessRunResult>;
  writeReview(path: string, payload: ObserverReviewPayload): void;
  /**
   * Hand the written review to the council review pipeline
   * (`CouncilCheckpointPipeline.handleCouncilReview`). Direct, not via the
   * `fs.watch` review watcher: two review files landing back to back can lose
   * a watch event, and the host already holds the payload. `reviewedAtMs` is
   * the file's mtime (same clock the REST bootstrap uses).
   */
  ingestReview(sessionGroupId: string, payload: ObserverReviewPayload, reviewedAtMs: number): void;
  /** Another live session on this backend is in a usage limit right now. */
  isBackendLimited(backend: SecondReviewerBackend): boolean;
  /** The group still exists (not archived / torn down). */
  isGroupLive(sessionGroupId: string): boolean;
  emit(event: SecondReviewBusEvent): void;
  now(): number;
  /** codex `--output-last-message` scratch file; production: a fresh tmp dir. */
  makeScratchFile(): { path: string; cleanup(): void };
  readScratchFile(path: string): string | null;
  timeoutMs?: number;
}

export interface SecondReviewContext {
  cwd: string;
  observerBackend: SecondReviewerBackend;
  /** The checkpoint before this one (delta manifest, same as the observer's wake). */
  previous: CheckpointPayload | null;
  claimLanguage?: ClaimLanguage | null;
}

export type SecondReviewOutcome =
  | { kind: "off" }
  | { kind: "skipped"; reason: "phase_out_of_scope" | "already_reviewed" | "in_flight" | "usage_limited" | "binary_missing" | "build_error" }
  | { kind: "queued" }
  | { kind: "dispatched"; done: Promise<void> };

interface Pending {
  payload: CheckpointPayload;
  ctx: SecondReviewContext;
  reviewer: ResolvedSecondReviewer;
}

interface Running {
  checkpointId: string;
  abort: AbortController;
}

function modelLabel(r: ResolvedSecondReviewer): string {
  return r.model ?? "default";
}

export class SecondReviewer {
  private readonly running = new Map<string, Running>();
  private readonly pending = new Map<string, Pending>();
  /** backend → epoch ms until which runs are skipped after a usage-limit answer. */
  private readonly limitedUntil = new Map<SecondReviewerBackend, number>();

  constructor(private readonly deps: SecondReviewerDeps) {}

  /**
   * A checkpoint was accepted by the pipeline. Decide whether it gets a
   * second opinion and start (or queue) the run. Never throws.
   */
  onCheckpoint(sessionGroupId: string, payload: CheckpointPayload, ctx: SecondReviewContext): SecondReviewOutcome {
    let config: SecondReviewerConfig;
    try {
      config = this.deps.getConfig(sessionGroupId, ctx.cwd);
    } catch {
      return { kind: "off" };
    }
    const reviewer = resolveSecondReviewer(config.reviewer, ctx.observerBackend);
    if (!reviewer) return { kind: "off" };
    const base = {
      sessionGroupId,
      checkpointId: payload.checkpoint_id,
      phase: payload.phase,
      backend: reviewer.backend,
      model: modelLabel(reviewer),
    };
    if (!isPhaseInSecondReviewScope(payload.phase, config.scope)) {
      this.logSkipped(base, "phase_out_of_scope", { scope: config.scope });
      return { kind: "skipped", reason: "phase_out_of_scope" };
    }
    const existing = findFreshSecondReview(ctx.cwd, sessionGroupId, payload);
    if (existing) {
      this.logSkipped(base, "already_reviewed", { file: existing });
      return { kind: "skipped", reason: "already_reviewed" };
    }
    const run = this.running.get(sessionGroupId);
    if (run?.checkpointId === payload.checkpoint_id) {
      this.logSkipped(base, "in_flight");
      return { kind: "skipped", reason: "in_flight" };
    }
    if (this.isLimited(reviewer.backend)) {
      this.logSkipped(base, "usage_limited");
      this.deps.emit({ ...this.busBase(base), status: "missing", reason: "usage_limited" });
      return { kind: "skipped", reason: "usage_limited" };
    }
    if (run || this.running.size >= this.maxConcurrency()) {
      const prior = this.pending.get(sessionGroupId);
      if (prior) {
        this.logSkipped({ ...base, checkpointId: prior.payload.checkpoint_id, phase: prior.payload.phase }, "superseded", {
          supersededBy: payload.checkpoint_id,
        });
        this.deps.emit({
          sessionGroupId,
          checkpointId: prior.payload.checkpoint_id,
          status: "missing",
          backend: prior.reviewer.backend,
          model: modelLabel(prior.reviewer),
          reason: "superseded",
        });
      }
      this.pending.set(sessionGroupId, { payload, ctx, reviewer });
      // Owed from the moment it is queued: the observer's clean review of this
      // checkpoint must wait for it (observer STOP2 on PR #372).
      this.deps.emit({ ...this.busBase(base), status: "queued" });
      log.info("second-reviewer", "second review queued behind a running one", {
        event: "council.second_review.queued",
        ...base,
        runningCheckpointId: run?.checkpointId ?? null,
        runningGroups: this.running.size,
      });
      return { kind: "queued" };
    }
    return this.start(sessionGroupId, payload, ctx, reviewer);
  }

  /** Group torn down: kill its run, drop its queue. */
  forgetGroup(sessionGroupId: string): void {
    this.pending.delete(sessionGroupId);
    const run = this.running.get(sessionGroupId);
    if (run) run.abort.abort();
  }

  /** Test/diagnostic view. */
  isRunning(sessionGroupId: string): boolean {
    return this.running.has(sessionGroupId);
  }

  private isLimited(backend: SecondReviewerBackend): boolean {
    const until = this.limitedUntil.get(backend);
    if (until !== undefined && until > this.deps.now()) return true;
    try {
      return this.deps.isBackendLimited(backend);
    } catch {
      return false;
    }
  }

  private busBase(base: { sessionGroupId: string; checkpointId: string; backend: SecondReviewerBackend; model: string }) {
    return { sessionGroupId: base.sessionGroupId, checkpointId: base.checkpointId, backend: base.backend, model: base.model };
  }

  private logSkipped(
    base: { sessionGroupId: string; checkpointId: string; phase: string; backend: SecondReviewerBackend; model: string },
    reason: string,
    extra: Record<string, unknown> = {},
  ): void {
    log.info("second-reviewer", "second review skipped", { event: "council.second_review.skipped", ...base, reason, ...extra });
  }

  private maxConcurrency(): number {
    const n = this.deps.maxConcurrency;
    return typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_SECOND_REVIEW_MAX_CONCURRENCY;
  }

  private start(
    sessionGroupId: string,
    payload: CheckpointPayload,
    ctx: SecondReviewContext,
    resolved: ResolvedSecondReviewer,
  ): SecondReviewOutcome {
    let reviewer = resolved;
    if (!reviewer.model) {
      let fallback: string | undefined;
      try {
        fallback = this.deps.defaultModel?.(reviewer.backend);
      } catch {
        fallback = undefined;
      }
      if (fallback) reviewer = { ...reviewer, model: fallback };
    }
    const base = {
      sessionGroupId,
      checkpointId: payload.checkpoint_id,
      phase: payload.phase,
      backend: reviewer.backend,
      model: modelLabel(reviewer),
    };
    const binary = this.deps.resolveBinary(reviewer.backend);
    if (!binary) {
      log.warn("second-reviewer", "second review skipped: CLI not installed", {
        event: "council.second_review.skipped",
        ...base,
        reason: "binary_missing",
      });
      this.deps.emit({ ...this.busBase(base), status: "missing", reason: "binary_missing" });
      return { kind: "skipped", reason: "binary_missing" };
    }
    let wakeText: string;
    let systemPrompt: string;
    try {
      systemPrompt = this.deps.loadSystemPrompt(ctx.cwd);
      const manifest = buildObserverContextManifest({ current: payload, previous: ctx.previous ?? undefined });
      wakeText = buildObserverWakePayload({
        checkpoint: payload,
        manifest,
        workspaceRoot: ctx.cwd,
        observerProvider: reviewer.backend,
        ...(ctx.claimLanguage ? { claimLanguage: ctx.claimLanguage } : {}),
      }).textBody;
    } catch (err) {
      log.warn("second-reviewer", "second review skipped: wake build failed", {
        event: "council.second_review.skipped",
        ...base,
        reason: "build_error",
        error: err instanceof Error ? err.message : String(err),
      });
      this.deps.emit({ ...this.busBase(base), status: "missing", reason: "build_error" });
      return { kind: "skipped", reason: "build_error" };
    }

    const abort = new AbortController();
    this.running.set(sessionGroupId, { checkpointId: payload.checkpoint_id, abort });
    this.deps.emit({ ...this.busBase(base), status: "dispatched" });
    log.info("second-reviewer", "second review dispatched", { event: "council.second_review.dispatched", ...base });
    const startedAt = this.deps.now();
    const done = this.execute(sessionGroupId, payload, ctx, reviewer, binary, systemPrompt, wakeText, abort, base, startedAt)
      .catch((err) => {
        this.fail(base, "internal_error", err instanceof Error ? err.message : String(err), startedAt);
      })
      .finally(() => {
        const cur = this.running.get(sessionGroupId);
        if (cur?.abort === abort) this.running.delete(sessionGroupId);
        this.drain();
      });
    return { kind: "dispatched", done };
  }

  /** Start queued checkpoints (oldest-queued group first) while capacity allows. */
  private drain(): void {
    for (const [sessionGroupId, next] of [...this.pending]) {
      if (this.running.size >= this.maxConcurrency()) return;
      if (this.running.has(sessionGroupId)) continue;
      this.pending.delete(sessionGroupId);
      if (!this.deps.isGroupLive(sessionGroupId)) continue;
      const out = this.onCheckpoint(sessionGroupId, next.payload, next.ctx);
      // The queued checkpoint was announced as owed. If it is now skipped
      // without its own bus event (config switched off / out of scope, or
      // already reviewed), release the owed verdict so nothing waits forever.
      if (out.kind === "off" || (out.kind === "skipped" && (out.reason === "phase_out_of_scope" || out.reason === "already_reviewed" || out.reason === "in_flight"))) {
        this.deps.emit({
          sessionGroupId,
          checkpointId: next.payload.checkpoint_id,
          status: "missing",
          backend: next.reviewer.backend,
          model: modelLabel(next.reviewer),
          reason: out.kind === "off" ? "disabled" : out.reason,
        });
      }
    }
  }

  private fail(
    base: { sessionGroupId: string; checkpointId: string; phase: string; backend: SecondReviewerBackend; model: string },
    reason: string,
    detail: string,
    startedAt: number,
  ): void {
    log.warn("second-reviewer", "second review failed", {
      event: "council.second_review.failed",
      ...base,
      reason,
      detail: detail.slice(0, 500),
      durationMs: this.deps.now() - startedAt,
    });
    this.deps.emit({ ...this.busBase(base), status: "missing", reason });
  }

  private async execute(
    sessionGroupId: string,
    payload: CheckpointPayload,
    ctx: SecondReviewContext,
    reviewer: ResolvedSecondReviewer,
    binary: string,
    systemPrompt: string,
    wakeText: string,
    abort: AbortController,
    base: { sessionGroupId: string; checkpointId: string; phase: string; backend: SecondReviewerBackend; model: string },
    startedAt: number,
  ): Promise<void> {
    const scratch = reviewer.backend === "codex" ? this.deps.makeScratchFile() : null;
    try {
      const inv = buildSecondReviewInvocation({
        reviewer,
        binary,
        cwd: ctx.cwd,
        systemPrompt,
        wakeText,
        ...(scratch ? { lastMessageFile: scratch.path } : {}),
      });
      const res = await this.deps.run(inv.cmd, {
        cwd: ctx.cwd,
        env: this.deps.buildEnv(binary, reviewer.backend),
        stdin: inv.stdin,
        timeoutMs: this.deps.timeoutMs ?? DEFAULT_SECOND_REVIEW_TIMEOUT_MS,
        signal: abort.signal,
      });
      if (res.aborted || abort.signal.aborted) {
        this.fail(base, "aborted", "group torn down", startedAt);
        return;
      }
      if (res.timedOut) {
        this.fail(base, "timeout", `no reply within ${this.deps.timeoutMs ?? DEFAULT_SECOND_REVIEW_TIMEOUT_MS} ms`, startedAt);
        return;
      }
      const out = parseSecondReviewOutput(reviewer.backend, {
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.exitCode,
        lastMessage: scratch ? this.deps.readScratchFile(scratch.path) : null,
      });
      if (!out.ok) {
        if (out.reason === "usage_limited") {
          const now = this.deps.now();
          const reset = parseResetFromText(out.detail, now);
          this.limitedUntil.set(reviewer.backend, reset && reset > now ? reset : now + SECOND_REVIEW_LIMIT_COOLDOWN_MS);
        }
        this.fail(base, out.reason, out.detail, startedAt);
        return;
      }
      const extracted = extractObserverFindings(out.text);
      if (!extracted.ok) {
        this.fail(base, `reply_${extracted.reason}`, out.text.slice(0, 300), startedAt);
        return;
      }
      if (!this.deps.isGroupLive(sessionGroupId)) {
        log.info("second-reviewer", "second review discarded: group gone", {
          event: "council.second_review.skipped",
          ...base,
          reason: "group_gone",
        });
        return;
      }
      const built = buildHostObserverReview(extracted.findings, {
        sessionGroupId,
        checkpointId: payload.checkpoint_id,
        phase: payload.phase,
        provider: reviewer.backend,
        model: out.model ?? reviewer.model ?? `${reviewer.backend}-default`,
        cliVersion: `${reviewer.backend}-headless`,
        reviewedAt: new Date(this.deps.now()),
        reviewerRole: "second",
      });
      if (!built.ok) {
        this.fail(base, "invalid_findings", built.field ?? built.dropReason, startedAt);
        return;
      }
      const file = buildSecondReviewFilename(payload.phase, reviewer.backend, sessionGroupId);
      const path = join(ctx.cwd, ".council", "reviews", file);
      this.deps.writeReview(path, built.payload);
      let reviewedAtMs = this.deps.now();
      try {
        reviewedAtMs = statSync(path).mtimeMs;
      } catch {
        // keep the clock value
      }
      this.deps.ingestReview(sessionGroupId, built.payload, reviewedAtMs);
      log.info("second-reviewer", "second review completed", {
        event: "council.second_review.completed",
        ...base,
        model: built.payload.observer_model,
        file,
        findingsCount: built.payload.findings.length,
        stopCount: built.payload.findings.filter((f) => f.severity === "STOP").length,
        durationMs: this.deps.now() - startedAt,
      });
    } finally {
      scratch?.cleanup();
    }
  }
}

// ── Production deps ─────────────────────────────────────────────────────────

/** Spawn a headless CLI, feed stdin, capture bounded output, enforce the timeout. */
export function runHeadless(cmd: string[], opts: HeadlessRunOptions): Promise<HeadlessRunResult> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.env)) if (typeof v === "string") env[k] = v;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    // Own process group (detached), so a timeout/abort kills the whole tree —
    // codex's bwrap sandbox and its shells too, not only the direct child.
    const child = nodeSpawn(cmd[0]!, cmd.slice(1), { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      resolve({ exitCode, stdout, stderr, timedOut, aborted });
    };
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (d: string) => {
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += d;
    });
    child.stderr?.on("data", (d: string) => {
      if (stderr.length < MAX_CAPTURE_BYTES) stderr += d;
    });
    child.on("error", (err) => {
      stderr += `\nspawn error: ${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
    child.stdin?.on("error", () => {
      // EPIPE when the CLI exits before reading stdin — the exit code tells the story
    });
    child.stdin?.end(opts.stdin);
  });
}

export function makeTmpScratchFile(): { path: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "aura-second-review-"));
  return {
    path: join(dir, "last-message.txt"),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

export function readScratchFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** PATH for the CLI: its own directory first (codex's sibling `node`), then the enriched PATH. */
export function prependBinaryDir(binary: string, enrichedPath: string): string {
  return [dirname(binary), ...enrichedPath.split(":")].filter(Boolean).join(":");
}
