#!/usr/bin/env bun
// Rendered-UI accessibility scan for council reviews (PLAN-aura-uiux-agent-enrichment
// Task 15, spec Story 4).
//
// Opens loopback dev-server URLs in agent-browser, injects the pinned axe-core
// from node_modules at run time (HANDOFF-A decision 2A: a run-time tool only,
// never vendored or copied into shipped files) and runs the WCAG 2.0–2.2 A/AA
// rules on every (url × theme) state at a phone viewport.
//
// Exactly three outcomes, written to an artifact the review quotes:
//   pass    — every state was scanned and axe found no violation. This is NOT
//             "accessible": axe covers roughly a third of WCAG, so the artifact
//             always carries the manual checklist as "not verified" lines.
//   fail    — at least one violation: rule id, selector, WCAG criterion, state.
//   skipped — the scan could not vouch for anything (no browser, server down,
//             blank page, axe missing, timeout, crash partway), with the reason.
//             A skipped scan never reads as a pass; partial violations found
//             before a crash are still listed.
// axe "incomplete" results are listed as "needs manual check", never as a pass.
//
// Safety: only loopback URLs can be opened (and the browser is limited to those
// hosts), every browser call has a hard timeout and runs in its own process
// group, the browser session is closed and then force-killed by its own session
// id, the temp profile is removed, and all output is passed through secret
// redaction.
//
// Pure core (`checkUrl`, `criteriaFromTags`, `summarizeState`, `decide`,
// `renderMarkdown`) + an effect shell (`runScan`) whose process/network calls are
// injectable for tests.
//
// Usage:
//   bun scripts/a11y-scan.ts --url http://127.0.0.1:5174/#/playground [--url …]
//     [--themes light,dark] [--viewport 375x812] [--out DIR] [--timeout-ms 180000]
//     [--settle-ms 1500] [--browser-args=--no-sandbox]
// Exit: 0 pass · 1 fail · 3 skipped · 2 usage error.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { redactSecretsInText } from "../server/secret-redaction.js";

// ─── Policy ──────────────────────────────────────────────────────────────────

export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] as const;
export const DEFAULT_VIEWPORT = { width: 375, height: 812 } as const;
export const DEFAULT_THEMES = ["light", "dark"] as const;
export type Theme = "light" | "dark";
export type ScanStatus = "pass" | "fail" | "skipped";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** What axe cannot check. Appended to every artifact as explicit "not verified" lines. */
export const MANUAL_CHECKLIST: readonly string[] = [
  "Keyboard: every control reachable with Tab in a logical order, no focus trap, Escape closes dialogs (2.1.1, 2.1.2, 2.4.3)",
  "Focus visible on every control in both themes, not hidden under sticky bars (2.4.7, 2.4.11)",
  "Screen reader: names, roles and states announced correctly; live updates (streaming, toasts) announced once (4.1.2, 4.1.3)",
  "Text alternatives are meaningful, not just present (1.1.1)",
  "Reflow at 320 CSS px and 400% zoom without loss of content (1.4.10); text spacing override (1.4.12)",
  "Contrast of states axe cannot compute: hover, focus, disabled, text over images/gradients (1.4.3, 1.4.11)",
  "Motion: animations respect prefers-reduced-motion; nothing flashes (2.3.1, 2.3.3)",
  "Errors identified in text with a suggestion for the fix (3.3.1, 3.3.3)",
  "Target size of touch controls at the phone viewport (2.5.8)",
  "Consistent navigation and identification across the changed screens (3.2.3, 3.2.4)",
];

export const NOT_A_CLAIM =
  "axe checks roughly a third of WCAG success criteria. A pass means axe found nothing on the scanned states; it does not mean the UI is accessible.";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StateRef {
  url: string;
  theme: Theme;
  viewport: string;
}

export interface Violation {
  ruleId: string;
  impact: string | null;
  criteria: string[];
  selector: string;
  state: StateRef;
  help: string;
  helpUrl: string;
}

export interface ManualCheck {
  ruleId: string;
  criteria: string[];
  selector: string;
  state: StateRef;
  help: string;
}

export interface StateResult {
  state: StateRef;
  elements: number;
  nodesChecked: number;
  violations: Violation[];
  incomplete: ManualCheck[];
  blank: boolean;
}

export interface ScanArtifact {
  schemaVersion: 1;
  status: ScanStatus;
  reason: string | null;
  tool: { name: "axe-core"; version: string | null; tags: readonly string[] };
  viewport: string;
  themes: Theme[];
  urls: string[];
  states: StateResult[];
  violations: Violation[];
  needsManualCheck: ManualCheck[];
  notAClaim: string;
  manualChecklist: readonly string[];
  startedAt: string;
  finishedAt: string;
}

/** Raw shape the in-page script returns (counts only for passes, details for the rest). */
export interface RawAxeState {
  axeVersion: string;
  elements: number;
  passNodes: number;
  violations: { id: string; impact: string | null; tags: string[]; help: string; helpUrl: string; nodes: { target: unknown[] }[] }[];
  incomplete: { id: string; tags: string[]; help: string; nodes: { target: unknown[] }[] }[];
}

// ─── Pure core ───────────────────────────────────────────────────────────────

/** null when the URL may be scanned; otherwise why not. Loopback http(s) only. */
export function checkUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `not a URL: ${raw}`;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `only http(s) URLs can be scanned: ${raw}`;
  if (!LOOPBACK_HOSTS.has(u.hostname)) return `only loopback dev-server URLs can be scanned (127.0.0.1, localhost, ::1): ${u.hostname}`;
  if (u.username || u.password) return "URLs with credentials are refused";
  return null;
}

/** `wcag143` → `1.4.3`, `wcag2411` → `2.4.11`; level tags (`wcag2aa`) are not criteria. */
export function criteriaFromTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const m = /^wcag(\d)(\d)(\d{1,2})$/.exec(t);
    if (m) out.push(`${m[1]}.${m[2]}.${m[3]}`);
  }
  return out.sort();
}

function selectorOf(target: unknown[]): string {
  return target.map((t) => (Array.isArray(t) ? t.join(" >>> ") : String(t))).join(" ");
}

export function summarizeState(state: StateRef, raw: RawAxeState): StateResult {
  const violations: Violation[] = [];
  for (const v of raw.violations) {
    for (const n of v.nodes) {
      violations.push({
        ruleId: v.id, impact: v.impact, criteria: criteriaFromTags(v.tags), selector: selectorOf(n.target),
        state, help: v.help, helpUrl: v.helpUrl,
      });
    }
  }
  const incomplete: ManualCheck[] = [];
  for (const v of raw.incomplete) {
    for (const n of v.nodes) {
      incomplete.push({ ruleId: v.id, criteria: criteriaFromTags(v.tags), selector: selectorOf(n.target), state, help: v.help });
    }
  }
  const nodesChecked = raw.passNodes + violations.length + incomplete.length;
  return { state, elements: raw.elements, nodesChecked, violations, incomplete, blank: raw.elements === 0 || nodesChecked === 0 };
}

/**
 * The status is decided here and only here. `abort` is the first reason the run
 * could not finish (no browser, timeout, crash …). Any abort or blank state
 * makes the run `skipped`, even when violations were found before it.
 */
export function decide(states: readonly StateResult[], expected: number, abort: string | null): { status: ScanStatus; reason: string | null } {
  if (abort) return { status: "skipped", reason: abort };
  const blank = states.find((s) => s.blank);
  if (blank) return { status: "skipped", reason: `blank page: ${stateLabel(blank.state)} rendered ${blank.elements} element(s) and axe checked ${blank.nodesChecked} node(s)` };
  if (states.length < expected) return { status: "skipped", reason: `only ${states.length} of ${expected} state(s) were scanned` };
  if (states.length === 0) return { status: "skipped", reason: "nothing was scanned" };
  if (states.some((s) => s.violations.length > 0)) return { status: "fail", reason: null };
  return { status: "pass", reason: null };
}

export function stateLabel(s: StateRef): string {
  return `${s.url} · ${s.theme} · ${s.viewport}`;
}

export function renderMarkdown(a: ScanArtifact): string {
  const lines: string[] = [];
  const head =
    a.status === "pass" ? "PASS (axe found no violations; this is not an accessibility claim)"
      : a.status === "fail" ? `FAIL: ${a.violations.length} violation(s)`
        : `SKIPPED: ${a.reason}`;
  lines.push(`# Rendered a11y scan: ${head}`, "");
  if (a.status === "skipped") lines.push("**Scan skipped. This is not a pass:** nothing below vouches for the UI.", "");
  lines.push(`- Tool: axe-core ${a.tool.version ?? "(not loaded)"}, tags ${a.tool.tags.join(", ")}`);
  lines.push(`- States: ${a.urls.length} url(s) × ${a.themes.join("/")} at ${a.viewport}; scanned ${a.states.length}`);
  lines.push(`- ${a.notAClaim}`, "");
  if (a.violations.length) {
    lines.push(a.status === "skipped" ? "## Violations found before the scan stopped (partial)" : "## Violations", "");
    lines.push("| Rule | Impact | WCAG | Selector | State |", "|---|---|---|---|---|");
    for (const v of a.violations) {
      lines.push(`| \`${v.ruleId}\` | ${v.impact ?? "?"} | ${v.criteria.join(", ") || "best practice"} | \`${v.selector.replace(/\|/g, "\\|")}\` | ${stateLabel(v.state)} |`);
    }
    lines.push("");
  }
  if (a.needsManualCheck.length) {
    lines.push("## Needs manual check (axe incomplete, not a pass)", "");
    for (const m of a.needsManualCheck) lines.push(`- not verified: \`${m.ruleId}\` on \`${m.selector}\` (${stateLabel(m.state)}): ${m.help}`);
    lines.push("");
  }
  lines.push("## What axe cannot see (not verified)", "");
  for (const c of a.manualChecklist) lines.push(`- [ ] not verified: ${c}`);
  return redactOutput(`${lines.join("\n")}\n`);
}

/** Secret redaction plus URL/header token shapes, applied to everything written or printed. */
export function redactOutput(text: string): string {
  return redactSecretsInText(text)
    .replace(/([?&#;](?:token|auth|access_token|api_key|key|session)=)[^&#\s"'`|)]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1[REDACTED]");
}

// ─── Args ────────────────────────────────────────────────────────────────────

export interface ScanOptions {
  urls: string[];
  themes: Theme[];
  viewport: { width: number; height: number };
  out: string;
  timeoutMs: number;
  settleMs: number;
  browserArgs: string | null;
}

export function parseArgs(argv: readonly string[], now = new Date()): ScanOptions | { error: string } {
  const o: ScanOptions = {
    urls: [], themes: [...DEFAULT_THEMES], viewport: { ...DEFAULT_VIEWPORT },
    out: join(tmpdir(), `aura-a11y-scan-${now.toISOString().replace(/[:.]/g, "-")}`),
    timeoutMs: 180_000, settleMs: 1_500, browserArgs: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].includes("=") ? [argv[i].slice(0, argv[i].indexOf("=")), argv[i].slice(argv[i].indexOf("=") + 1)] : [argv[i], undefined];
    const val = (): string | undefined => inline ?? argv[++i];
    switch (flag) {
      case "--url": { const v = val(); if (!v) return { error: "--url needs a value" }; o.urls.push(v); break; }
      case "--themes": {
        const v = (val() ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (!v.length || v.some((t) => t !== "light" && t !== "dark")) return { error: "--themes takes light,dark" };
        o.themes = v as Theme[];
        break;
      }
      case "--viewport": {
        const m = /^(\d{3,4})x(\d{3,4})$/.exec(val() ?? "");
        if (!m) return { error: "--viewport takes WIDTHxHEIGHT, e.g. 375x812" };
        o.viewport = { width: Number(m[1]), height: Number(m[2]) };
        break;
      }
      case "--out": { const v = val(); if (!v) return { error: "--out needs a directory" }; o.out = v; break; }
      case "--timeout-ms": { const n = Number(val()); if (!Number.isInteger(n) || n < 1000) return { error: "--timeout-ms must be an integer ≥ 1000" }; o.timeoutMs = n; break; }
      case "--settle-ms": { const n = Number(val()); if (!Number.isInteger(n) || n < 0) return { error: "--settle-ms must be an integer ≥ 0" }; o.settleMs = n; break; }
      case "--browser-args": { const v = val(); if (!v) return { error: "--browser-args needs a value" }; o.browserArgs = v; break; }
      default: return { error: `unknown option ${argv[i]}` };
    }
  }
  if (!o.urls.length) return { error: "at least one --url is required" };
  for (const u of o.urls) {
    const why = checkUrl(u);
    if (why) return { error: why };
  }
  return o;
}

// ─── Effect shell ────────────────────────────────────────────────────────────

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

export interface ScanDeps {
  /** Path to agent-browser, or null when it is not on PATH. */
  which: (bin: string) => string | null;
  /** Run a command in its own process group with a hard timeout. */
  run: (cmd: string, args: string[], opts: { timeoutMs: number; stdin?: string; env?: NodeJS.ProcessEnv }) => Promise<RunResult>;
  /** Resolve the pinned axe-core: its axe.min.js path and version, or why it cannot be used. */
  axe: () => { path: string; version: string } | { error: string };
  /** Is the server answering? null when yes, otherwise why not. */
  probe: (url: string, timeoutMs: number) => Promise<string | null>;
  /** Force-kill whatever the browser session left behind (by its session id). */
  killSession: (session: string) => void;
  now: () => Date;
}

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, "..");

/** The exact axe-core version web/package.json pins. A range is refused: the pin is the point. */
export function pinnedAxeVersion(pkgJson: string): string | null {
  const pkg = JSON.parse(pkgJson) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const v = pkg.dependencies?.["axe-core"] ?? pkg.devDependencies?.["axe-core"];
  return v && /^\d+\.\d+\.\d+$/.test(v) ? v : null;
}

function resolveAxe(): { path: string; version: string } | { error: string } {
  const pinned = pinnedAxeVersion(readFileSync(join(webDir, "package.json"), "utf-8"));
  if (!pinned) return { error: "web/package.json does not pin axe-core to an exact version" };
  let pkgPath: string;
  try {
    pkgPath = createRequire(join(webDir, "package.json")).resolve("axe-core/package.json");
  } catch {
    return { error: "axe-core is not installed (run `bun install` in web/)" };
  }
  const version = (JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string }).version;
  if (version !== pinned) return { error: `installed axe-core ${version} is not the pinned ${pinned}` };
  const path = join(dirname(pkgPath), "axe.min.js");
  if (!existsSync(path)) return { error: `axe-core ${version} has no axe.min.js` };
  return { path, version };
}

function which(bin: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    if (existsSync(p)) return p;
  }
  return null;
}

function runGrouped(cmd: string, args: string[], opts: { timeoutMs: number; stdin?: string; env?: NodeJS.ProcessEnv }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { detached: true, stdio: ["pipe", "pipe", "pipe"], env: opts.env ?? process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const killGroup = () => {
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, opts.timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr + String(e), timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    child.stdin.end(opts.stdin ?? "");
  });
}

async function probe(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    return res.status >= 500 ? `server answered ${res.status}` : null;
  } catch (e) {
    return `server down: ${new URL(url).origin} is not answering (${(e as Error).name})`;
  }
}

/**
 * agent-browser runs one daemon per session; the daemon is a session leader and
 * Chrome lives in that session. Kill every process group of THAT session only —
 * never by command line (a shared box runs other browsers and servers).
 */
function killSession(session: string): void {
  const pidFile = join(process.env.HOME ?? "", ".agent-browser", `${session}.pid`);
  let leader: number;
  try {
    leader = Number(readFileSync(pidFile, "utf-8").trim());
  } catch {
    return; // closed cleanly: the daemon removed its pid file
  }
  if (!Number.isInteger(leader) || leader <= 1) return;
  try {
    if (!readFileSync(`/proc/${leader}/cmdline`, "utf-8").includes("agent-browser")) return; // pid reused
  } catch {
    return;
  }
  const groups = new Set<number>([leader]);
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf-8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[3]) === leader) groups.add(Number(fields[2])); // fields: state ppid pgrp session
    } catch { /* exited */ }
  }
  for (const g of groups) {
    try { process.kill(-g, "SIGKILL"); } catch { /* gone */ }
  }
  // A killed daemon cannot remove its own socket/pid files; they are named by our unique session id.
  for (const ext of SESSION_FILE_EXTS) rmSync(join(dirname(pidFile), `${session}.${ext}`), { force: true });
}

const SESSION_FILE_EXTS = ["pid", "sock", "engine", "version", "stream"] as const;

export const realDeps: ScanDeps = { which, run: runGrouped, axe: resolveAxe, probe, killSession, now: () => new Date() };

/** The in-page script: run axe on the WCAG A/AA tags, return counts for passes and details for the rest. */
export function pageScript(): string {
  return `(async () => {
  if (typeof axe === "undefined") return JSON.stringify({ error: "axe-core was not injected into the page" });
  const r = await axe.run(document, { runOnly: { type: "tag", values: ${JSON.stringify(WCAG_TAGS)} } });
  const pick = (v) => ({ id: v.id, impact: v.impact || null, tags: v.tags, help: v.help, helpUrl: v.helpUrl, nodes: v.nodes.map((n) => ({ target: n.target })) });
  return JSON.stringify({
    axeVersion: axe.version,
    elements: document.body ? document.body.querySelectorAll("*").length : 0,
    passNodes: r.passes.reduce((s, v) => s + v.nodes.length, 0),
    violations: r.violations.map(pick),
    incomplete: r.incomplete.map(pick),
  });
})()`;
}

function parseEval(stdout: string): RawAxeState | { error: string } {
  let env: { success?: boolean; data?: { result?: unknown }; error?: unknown };
  try {
    env = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop() ?? "");
  } catch {
    return { error: "agent-browser returned no JSON" };
  }
  if (!env.success) return { error: `agent-browser eval failed: ${String(env.error ?? "unknown error")}` };
  const result = env.data?.result;
  let raw: unknown;
  try {
    raw = typeof result === "string" ? JSON.parse(result) : result;
  } catch {
    return { error: "the page script returned no JSON" };
  }
  const r = raw as Partial<RawAxeState> & { error?: string };
  if (r?.error) return { error: r.error };
  if (!r || !Array.isArray(r.violations) || !Array.isArray(r.incomplete) || typeof r.elements !== "number" || typeof r.passNodes !== "number") {
    return { error: "the page script returned an unexpected shape" };
  }
  return r as RawAxeState;
}

function launchFailure(stderr: string): string {
  const s = redactOutput(stderr.trim()).split("\n").slice(-3).join(" ").slice(0, 300);
  const hint = /No usable sandbox|setuid sandbox|user namespace/i.test(stderr) ? " (this host blocks the Chrome sandbox; retry with --browser-args=--no-sandbox)" : "";
  return `browser failed to launch: ${s || "no output"}${hint}`;
}

export async function runScan(opts: ScanOptions, deps: ScanDeps = realDeps): Promise<ScanArtifact> {
  const startedAt = deps.now(); // timestamps only; the deadline is wall-clock
  const deadline = Date.now() + opts.timeoutMs;
  const viewport = `${opts.viewport.width}x${opts.viewport.height}`;
  const states: StateResult[] = [];
  let abort: string | null = null;
  let axeVersion: string | null = null;

  const artifact = (): ScanArtifact => {
    const { status, reason } = decide(states, opts.urls.length * opts.themes.length, abort);
    return {
      schemaVersion: 1, status, reason, tool: { name: "axe-core", version: axeVersion, tags: WCAG_TAGS },
      viewport, themes: opts.themes, urls: opts.urls, states,
      violations: states.flatMap((s) => s.violations), needsManualCheck: states.flatMap((s) => s.incomplete),
      notAClaim: NOT_A_CLAIM, manualChecklist: MANUAL_CHECKLIST,
      startedAt: startedAt.toISOString(), finishedAt: deps.now().toISOString(),
    };
  };

  const ab = deps.which("agent-browser");
  if (!ab) {
    abort = "no browser: agent-browser is not on PATH";
    return artifact();
  }
  const axe = deps.axe();
  if ("error" in axe) {
    abort = `axe-core unavailable: ${axe.error}`;
    return artifact();
  }
  axeVersion = axe.version;
  for (const u of new Set(opts.urls.map((x) => new URL(x).origin))) {
    const down = await deps.probe(u, Math.min(10_000, Math.max(1_000, deadline - Date.now())));
    if (down) {
      abort = down;
      return artifact();
    }
  }

  const work = mkdtempSync(join(tmpdir(), "aura-a11y-"));
  const session = `aura-a11y-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const configPath = join(work, "agent-browser.json");
  writeFileSync(configPath, "{}\n"); // ignore the user's ~/.agent-browser/config.json (proxies, profiles)
  const hosts = [...new Set(opts.urls.map((x) => new URL(x).hostname.replace(/^\[|\]$/g, "")))].join(",");
  const launch = [
    "--session", session, "--config", configPath, "--profile", join(work, "profile"),
    "--init-script", axe.path, "--allowed-domains", hosts, "--json",
    ...(opts.browserArgs ? ["--args", opts.browserArgs] : []),
  ];
  const left = () => Math.max(0, deadline - Date.now());
  const call = async (args: string[], stdin?: string): Promise<RunResult | string> => {
    if (left() <= 0) return `timed out after ${opts.timeoutMs} ms`;
    const r = await deps.run(ab, args, { timeoutMs: Math.min(left(), 60_000), stdin });
    if (r.timedOut) return `timed out after ${opts.timeoutMs} ms (agent-browser ${args.find((a) => !a.startsWith("-") && a !== session) ?? ""})`;
    return r;
  };

  try {
    const first = await call([...launch, "set", "viewport", String(opts.viewport.width), String(opts.viewport.height)]);
    if (typeof first === "string") { abort = first; return artifact(); }
    if (first.code !== 0) { abort = launchFailure(first.stderr || first.stdout); return artifact(); }
    const s = ["--session", session, "--json"];
    for (const theme of opts.themes) {
      const media = await call([...s, "set", "media", theme]);
      if (typeof media === "string") { abort = media; return artifact(); }
      if (media.code !== 0) { abort = `scan crashed setting the ${theme} theme: ${redactOutput(media.stderr || media.stdout).slice(0, 300)}`; return artifact(); }
      for (const url of opts.urls) {
        const ref: StateRef = { url: redactOutput(url), theme, viewport };
        const opened = await call([...s, "open", url]);
        if (typeof opened === "string") { abort = opened; return artifact(); }
        if (opened.code !== 0) { abort = `scan crashed opening ${stateLabel(ref)}: ${redactOutput(opened.stderr || opened.stdout).slice(0, 300)}`; return artifact(); }
        if (opts.settleMs > 0) {
          const waited = await call([...s, "wait", String(opts.settleMs)]);
          if (typeof waited === "string") { abort = waited; return artifact(); }
        }
        const ev = await call([...s, "eval", "--stdin"], pageScript());
        if (typeof ev === "string") { abort = ev; return artifact(); }
        const raw = ev.code === 0 ? parseEval(ev.stdout) : { error: `agent-browser eval exited ${ev.code}: ${(ev.stderr || ev.stdout).slice(0, 300)}` };
        if ("error" in raw) { abort = `scan crashed on ${stateLabel(ref)}: ${redactOutput(raw.error)}`; return artifact(); }
        axeVersion = raw.axeVersion;
        states.push(summarizeState(ref, raw));
      }
    }
    return artifact();
  } finally {
    await deps.run(ab, ["--session", session, "close"], { timeoutMs: 10_000 }).catch(() => undefined);
    deps.killSession(session);
    rmSync(work, { recursive: true, force: true });
  }
}

export function writeArtifact(dir: string, a: ScanArtifact): { json: string; md: string } {
  mkdirSync(dir, { recursive: true });
  const json = join(dir, "a11y-scan.json");
  const md = join(dir, "a11y-scan.md");
  writeFileSync(json, `${redactOutput(JSON.stringify(a, null, 2))}\n`);
  writeFileSync(md, renderMarkdown(a));
  return { json, md };
}

export const EXIT: Record<ScanStatus, number> = { pass: 0, fail: 1, skipped: 3 };

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2));
  if ("error" in opts) {
    console.error(`a11y-scan: ${opts.error}`);
    process.exit(2);
  }
  const a = await runScan(opts);
  const paths = writeArtifact(opts.out, a);
  process.stdout.write(renderMarkdown(a));
  console.log(`\nartifact: ${paths.json}\nsummary:  ${paths.md}`);
  process.exit(EXIT[a.status]);
}
