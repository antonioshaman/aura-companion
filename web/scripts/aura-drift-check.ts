#!/usr/bin/env bun
// Aura upstream-drift detector (Carmack C6 + Beck B7 + Hunt H5).
//
// Read-only oracle. Fetches the npm `the-companion` package (and the upstream
// GitHub releases as a secondary source), compares to a local pin file, and
// — if drift is detected — opens a GitHub issue via the `gh` CLI on the Aura
// repo. Never installs, never executes, never reads auth tokens. The npm
// version stopper at web/package.json is unrelated; the version this script
// tracks is upstream's, written to .aura-drift-pin.json so we don't re-fire.
//
// Usage:
//   bun web/scripts/aura-drift-check.ts                 # check + open issue if drift
//   bun web/scripts/aura-drift-check.ts --dry-run       # report only, no issue
//   bun web/scripts/aura-drift-check.ts --pin           # write current upstream as the pin (no fire)
//   bun web/scripts/aura-drift-check.ts --reset         # delete the pin (next check fires fresh)

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(__dirname, "..", "..");
const PIN_PATH = resolve(REPO_ROOT, ".aura-drift-pin.json");
const NPM_URL = "https://registry.npmjs.org/the-companion/latest";
const GH_RELEASES_URL =
  "https://api.github.com/repos/The-Vibe-Company/companion/releases/latest";
// Single source of truth for the issue title prefix — we dedupe by title.
const ISSUE_TITLE_PREFIX = "[upstream-drift]";

interface DriftPin {
  /** Last-seen upstream version. We dedupe issue creation against this. */
  pinnedVersion: string;
  /** ISO timestamp of last fire. */
  lastFiredAt: string;
}

interface UpstreamSources {
  npmVersion: string | null;
  ghTag: string | null;
}

interface DriftReport {
  current: UpstreamSources;
  pin: DriftPin | null;
  drifted: boolean;
  /** A version string we'll write to the pin once an issue fires (or under --pin). */
  resolvedVersion: string | null;
}

interface CliOptions {
  dryRun: boolean;
  pinNow: boolean;
  reset: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  const opts: CliOptions = { dryRun: false, pinNow: false, reset: false };
  for (const a of args) {
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--pin") opts.pinNow = true;
    else if (a === "--reset") opts.reset = true;
    else if (a === "-h" || a === "--help") {
      console.log("Usage: bun web/scripts/aura-drift-check.ts [--dry-run|--pin|--reset]");
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

/** Fetch a URL as JSON with a hard timeout and no auth headers. Hunt H5. */
async function fetchJson(url: string, timeoutMs = 8_000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Validate the small JSON shape we depend on. Strict — no field, no read. */
function readVersionField(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>).version;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function readTagField(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const t = (payload as Record<string, unknown>).tag_name;
  return typeof t === "string" && t.length > 0 ? t : null;
}

async function probeUpstream(
  fetchImpl: typeof fetchJson = fetchJson,
): Promise<UpstreamSources> {
  // Querying both sources gives provenance — if they disagree, we surface it.
  // Either source failing is acceptable; we log and continue.
  const result: UpstreamSources = { npmVersion: null, ghTag: null };
  try {
    const npmPayload = await fetchImpl(NPM_URL);
    result.npmVersion = readVersionField(npmPayload);
  } catch (err) {
    console.warn(`[drift] npm probe failed: ${describeError(err)}`);
  }
  try {
    const ghPayload = await fetchImpl(GH_RELEASES_URL);
    result.ghTag = readTagField(ghPayload);
  } catch (err) {
    console.warn(`[drift] github probe failed: ${describeError(err)}`);
  }
  return result;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function loadPin(): DriftPin | null {
  if (!existsSync(PIN_PATH)) return null;
  try {
    const raw = readFileSync(PIN_PATH, "utf-8");
    const parsed = JSON.parse(raw) as DriftPin;
    if (typeof parsed.pinnedVersion === "string") return parsed;
  } catch {
    // Corrupt pin — treat as no pin, force fresh fire.
  }
  return null;
}

function savePin(version: string): void {
  const pin: DriftPin = {
    pinnedVersion: version,
    lastFiredAt: new Date().toISOString(),
  };
  writeFileSync(PIN_PATH, JSON.stringify(pin, null, 2) + "\n");
}

function computeReport(current: UpstreamSources, pin: DriftPin | null): DriftReport {
  // Pick the npm version as canonical (release-please publishes here first);
  // fall back to gh tag if npm is unavailable.
  const resolvedVersion = current.npmVersion ?? current.ghTag;
  if (!resolvedVersion) {
    // Neither source returned — not drift, not pin-update. Return as not-drifted
    // so the CLI exits clean; the warnings already logged tell the operator.
    return { current, pin, drifted: false, resolvedVersion: null };
  }
  if (!pin) {
    // No pin yet — treat as drift so the operator gets a baseline issue, then
    // we pin and stop firing on this version.
    return { current, pin, drifted: true, resolvedVersion };
  }
  const drifted = pin.pinnedVersion !== resolvedVersion;
  return { current, pin, drifted, resolvedVersion };
}

function fireGitHubIssue(report: DriftReport): boolean {
  // Use `gh issue create`. We dedupe against the issue title — `gh issue list`
  // with a label or query would be cheaper, but title-uniqueness is enough
  // for a one-VPS one-maintainer workflow.
  const version = report.resolvedVersion!;
  const title = `${ISSUE_TITLE_PREFIX} the-companion@${version}`;
  const body = renderIssueBody(report);

  // Check the gh CLI is present.
  const hasGh = spawnSync("gh", ["--version"], { encoding: "utf-8" });
  if (hasGh.status !== 0) {
    console.warn("[drift] `gh` CLI not found on PATH; skipping issue creation.");
    console.warn(`[drift] Manual reproduction: gh issue create --title "${title}" --body "..."`);
    return false;
  }

  // Don't double-create.
  const existing = spawnSync(
    "gh",
    ["issue", "list", "--state", "open", "--search", title, "--json", "title"],
    { encoding: "utf-8" },
  );
  if (existing.status === 0) {
    try {
      const arr = JSON.parse(existing.stdout) as Array<{ title: string }>;
      const dup = arr.some((i) => i.title === title);
      if (dup) {
        console.log(`[drift] issue already open: ${title}`);
        return true;
      }
    } catch {
      // Treat parse failure as "no dup" and proceed; gh will report on collision.
    }
  }

  const create = spawnSync(
    "gh",
    ["issue", "create", "--title", title, "--body", body, "--label", "upstream-sync"],
    { encoding: "utf-8" },
  );
  if (create.status !== 0) {
    console.warn(`[drift] gh issue create failed: ${create.stderr || create.stdout}`);
    return false;
  }
  console.log(`[drift] opened issue: ${(create.stdout || "").trim()}`);
  return true;
}

function renderIssueBody(report: DriftReport): string {
  const cur = report.current;
  const pinSection = report.pin
    ? `**Previously pinned:** \`${report.pin.pinnedVersion}\` (fired ${report.pin.lastFiredAt})`
    : "**Previously pinned:** none — this is the baseline fire";
  const provenance = [
    cur.npmVersion ? `- npm \`the-companion@latest\`: \`${cur.npmVersion}\`` : `- npm: unavailable`,
    cur.ghTag ? `- github releases tag: \`${cur.ghTag}\`` : `- github releases: unavailable`,
  ].join("\n");
  return [
    `Upstream Vibe-Companion (\`the-companion\`) appears to have shipped a new release: \`${report.resolvedVersion}\`.`,
    "",
    pinSection,
    "",
    "## Provenance",
    "",
    provenance,
    "",
    "## Next step",
    "",
    "When ready to absorb upstream changes, follow `docs/aura/upstream-sync.md`. ",
    "After landing the merge (or deciding to skip this version), run:",
    "",
    "```bash",
    "bun web/scripts/aura-drift-check.ts --pin",
    "```",
    "",
    "to refresh the pin so this issue isn't re-fired against the same version.",
    "",
    "_This issue was opened automatically by `aura-drift-check.ts`._",
  ].join("\n");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  if (opts.reset) {
    if (existsSync(PIN_PATH)) unlinkSync(PIN_PATH);
    console.log("[drift] pin reset");
    return;
  }

  const current = await probeUpstream();
  const pin = loadPin();
  const report = computeReport(current, pin);

  if (opts.pinNow) {
    if (!report.resolvedVersion) {
      console.error("[drift] cannot --pin without a resolved upstream version");
      process.exit(1);
    }
    savePin(report.resolvedVersion);
    console.log(`[drift] pinned to ${report.resolvedVersion}`);
    return;
  }

  if (!report.drifted) {
    console.log(`[drift] no drift (pinned ${pin?.pinnedVersion ?? "unset"}, current ${report.resolvedVersion ?? "unknown"})`);
    return;
  }

  console.log(`[drift] DRIFT detected: pinned=${pin?.pinnedVersion ?? "<none>"} current=${report.resolvedVersion}`);

  if (opts.dryRun) {
    console.log("[drift] dry-run — would open GitHub issue:");
    console.log("---");
    console.log(`Title: ${ISSUE_TITLE_PREFIX} the-companion@${report.resolvedVersion}`);
    console.log("");
    console.log(renderIssueBody(report));
    return;
  }

  const fired = fireGitHubIssue(report);
  if (fired && report.resolvedVersion) {
    savePin(report.resolvedVersion);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[drift] unexpected error: ${describeError(err)}`);
    process.exit(1);
  });
}

export {
  computeReport,
  loadPin,
  readVersionField,
  readTagField,
  probeUpstream,
  renderIssueBody,
};
export type { DriftPin, DriftReport, UpstreamSources };
