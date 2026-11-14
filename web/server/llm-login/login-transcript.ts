import type { LoginFailureReason, ProviderId } from "../auth-status/auth-types.js";

/**
 * Strict parsers for the output of the official sign-in CLIs
 * (`claude auth login`, `codex login --device-auth`), phase 2 plan task 3.
 *
 * The output is untrusted text (willison P4): terminal controls are stripped,
 * every line before the prompt must be a known line, the sign-in link must be
 * `https:` with the exact host + path, and the Codex device code must match a
 * closed template. Anything else is `cli_output_unrecognised` (fail-closed,
 * EC-5). Success is NEVER read from text — only the CLI exit status plus the
 * credential files decide it (credential-promotion.ts).
 *
 * Pure: no I/O. Fed incrementally (`push`), because Claude's prompt has no
 * trailing newline and chunks may split UTF-8 and escape sequences.
 * Replay-tested against the 2026-11-14 transcripts in `fixtures/` (EC-6).
 */

/** CLI versions whose sign-in output and side effects were verified (not the probe table). */
export const PROVEN_LOGIN_VERSIONS: Readonly<Record<ProviderId, readonly string[]>> = {
  claude: ["2.1.283"],
  codex: ["0.162.1"],
};

/** An unproven version is still allowed (the staging dir protects the live files); UI says "unverified CLI version". */
export function isProvenLoginVersion(provider: ProviderId, version: string | null): boolean {
  return version !== null && PROVEN_LOGIN_VERSIONS[provider].includes(version);
}

/** Output kept for parsing; the runner caps each stream at the same size. */
export const MAX_TRANSCRIPT_CHARS = 64 * 1024;

const CLAUDE_LINK = { host: "claude.com", path: "/cai/oauth/authorize" } as const;
const CODEX_LINK = { host: "auth.openai.com", path: "/codex/device" } as const;

/** Claude's PKCE `state`: base64url, as observed (43 chars) with slack. */
const CLAUDE_STATE = /^[A-Za-z0-9_-]{16,128}$/;
/** Codex one-time code as observed: `XXXX-XXXXX`, upper-case letters and digits. */
const CODEX_USER_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{5}$/;

const CLAUDE_PROMPT = "Paste code here if prompted >";

export type LoginPrompt =
  | { provider: "claude"; url: string; state: string }
  | { provider: "codex"; url: string; userCode: string; expiresInMinutes: number };

export type TranscriptVerdict =
  /** Not everything needed is printed yet. */
  | { kind: "pending" }
  /** Link (+ code / prompt) complete: the attempt can go to `awaiting_user`. */
  | { kind: "ready"; prompt: LoginPrompt }
  /** The CLI printed a known failure line. */
  | { kind: "failed"; reason: Extract<LoginFailureReason, "code_rejected" | "network" | "cli_output_unrecognised"> }
  /** Output not understood — stop the attempt (fail-closed). */
  | { kind: "unrecognised"; why: string };

// ─── Terminal controls ────────────────────────────────────────────────────────

/** OSC: ESC ] … (BEL | ESC \). Captures the payload so OSC 8 link targets can be checked. */
const OSC = /\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
/** CSI: ESC [ params intermediates final. */
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
/** Other two-byte escapes (ESC + one char). */
const ESC2 = /\x1b[@-Z\\-_]/g;
/** C0 except \t and \n, DEL, and C1. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * Removes terminal controls. Returns the OSC 8 hyperlink targets separately:
 * a hidden target can differ from the visible link text, so the caller
 * refuses a transcript whose targets are not the link it extracted.
 */
export function stripTerminalControls(raw: string): { text: string; hyperlinkTargets: string[] } {
  const hyperlinkTargets: string[] = [];
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(OSC, (_m, payload: string) => {
      // OSC 8 ; params ; URI — an empty URI closes the link.
      const osc8 = /^8;[^;]*;(.*)$/s.exec(payload);
      if (osc8 && osc8[1]) hyperlinkTargets.push(osc8[1]);
      return "";
    })
    .replace(CSI, "")
    .replace(ESC2, "")
    .replace(CONTROL, "");
  return { text, hyperlinkTargets };
}

// ─── Links ────────────────────────────────────────────────────────────────────

/** Parses a link and requires https + exact host and path, no credentials, no port. */
function strictLink(raw: string, expected: { host: string; path: string }): URL | null {
  if (!/^https:\/\/\S+$/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (url.hostname !== expected.host || url.pathname !== expected.path) return null;
  return url;
}

// ─── Claude ───────────────────────────────────────────────────────────────────

function parseClaude(lines: string[], partials: string[], targets: string[]): TranscriptVerdict {
  let link: { url: string; state: string } | null = null;
  let prompted = false;
  for (const line of lines) {
    const t = line.trim();
    if (t === "") continue;
    if (t === "Opening browser to sign in\u2026" || t === "Opening browser to sign in...") continue;
    const visit = /^If the browser didn't open, visit: (.*)$/.exec(t);
    if (visit) {
      const url = strictLink(visit[1], CLAUDE_LINK);
      const state = url?.searchParams.get("state") ?? null;
      if (!url || !state || !CLAUDE_STATE.test(state)) return { kind: "unrecognised", why: "claude sign-in link is not the expected link" };
      link = { url: url.toString(), state };
      continue;
    }
    // The prompt has no newline, so the CLI's next output lands on its line.
    if (t.startsWith(CLAUDE_PROMPT)) {
      prompted = true;
      const after = t.slice(CLAUDE_PROMPT.length).trim();
      const verdict = after ? claudeAfterPrompt(after) : null;
      if (verdict) return verdict;
      continue;
    }
    const failure = claudeAfterPrompt(t);
    if (failure) return failure;
    // After the prompt the exit status decides; unknown lines are not a verdict.
    if (prompted) continue;
    return { kind: "unrecognised", why: "unexpected claude sign-in output" };
  }
  // An incomplete line is never judged as a failure — only recognised as the prompt.
  if (partials.some((p) => p.trim() === CLAUDE_PROMPT)) prompted = true;
  if (!link || !prompted) return { kind: "pending" };
  if (!targetsMatch(targets, link.url)) return { kind: "unrecognised", why: "hyperlink target differs from the sign-in link" };
  return { kind: "ready", prompt: { provider: "claude", url: link.url, state: link.state } };
}

/** Lines after the prompt: known failures map to a reason; anything else is left to the exit status. */
function claudeAfterPrompt(line: string): TranscriptVerdict | null {
  const failed = /^Login failed: (.*)$/.exec(line);
  if (failed) {
    return { kind: "failed", reason: /status code 4\d\d\b/.test(failed[1]) ? "code_rejected" : "cli_output_unrecognised" };
  }
  // "Invalid code…" is the CLI refusing a malformed code; Aura validates the
  // shape before writing, so seeing it means the shape check and the CLI disagree.
  if (line === "Invalid code. Please make sure the full code was copied.") return { kind: "failed", reason: "code_rejected" };
  return null;
}

// ─── Codex ────────────────────────────────────────────────────────────────────

const CODEX_FIXED_LINES = new Set([
  "OpenAI's command-line coding agent",
  "Follow these steps to sign in with ChatGPT using device code authorization:",
  "1. Open this link in your browser and sign in to your account",
  "Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.",
]);

function parseCodex(lines: string[], targets: string[]): TranscriptVerdict {
  let url: string | null = null;
  let userCode: string | null = null;
  let expiresInMinutes: number | null = null;
  let expectCode = false;
  for (const line of lines) {
    const t = line.trim();
    if (t === "") continue;
    const failed = /^Error logging in with device code: (.*)$/.exec(t);
    if (failed) {
      return { kind: "failed", reason: /^error sending request for url \(/.test(failed[1]) ? "network" : "cli_output_unrecognised" };
    }
    if (CODEX_FIXED_LINES.has(t)) continue;
    // Not fatal: printed when CODEX_HOME is under a temporary dir (may interleave from stderr).
    if (t.startsWith("WARNING: proceeding, even though we could not create PATH aliases:")) continue;
    // The first unknown line after "2. Enter this one-time code" must be the code.
    if (expectCode) {
      expectCode = false;
      if (!CODEX_USER_CODE.test(t)) return { kind: "unrecognised", why: "codex device code does not match the template" };
      userCode = t;
      continue;
    }
    if (/^Welcome to Codex \[v[0-9][0-9A-Za-z.+-]*\]$/.test(t)) continue;
    if (t.startsWith("https://")) {
      const link = strictLink(t, CODEX_LINK);
      if (!link) return { kind: "unrecognised", why: "codex sign-in link is not the expected link" };
      url = link.toString();
      continue;
    }
    const enter = /^2\. Enter this one-time code \(expires in (\d{1,3}) minutes\)$/.exec(t);
    if (enter) {
      expiresInMinutes = Number(enter[1]);
      expectCode = true;
      continue;
    }
    // Lines after a complete prompt (e.g. a success message) are not parsed: the exit status decides.
    if (url && userCode && expiresInMinutes !== null) continue;
    return { kind: "unrecognised", why: "unexpected codex sign-in output" };
  }
  if (!url || !userCode || expiresInMinutes === null) return { kind: "pending" };
  if (!targetsMatch(targets, url)) return { kind: "unrecognised", why: "hyperlink target differs from the sign-in link" };
  return { kind: "ready", prompt: { provider: "codex", url, userCode, expiresInMinutes } };
}

function targetsMatch(targets: string[], url: string): boolean {
  return targets.every((t) => {
    try {
      return new URL(t).toString() === url;
    } catch {
      return false;
    }
  });
}

// ─── Incremental accumulator ──────────────────────────────────────────────────

export type OutputStream = "stdout" | "stderr";

/**
 * Accumulates the CLI's stdout and stderr (bytes or text) per stream and
 * re-parses on every push. Complete lines from both streams are judged in the
 * order they completed; an incomplete line is only ever recognised as Claude's
 * newline-less prompt — so a chunk boundary inside a line, a UTF-8 sequence or
 * an escape sequence cannot produce a verdict. A terminal verdict (`failed` /
 * `unrecognised`) sticks; `ready` may still turn into `failed`.
 */
export class LoginTranscript {
  private readonly decoders: Record<OutputStream, TextDecoder> = {
    stdout: new TextDecoder("utf-8", { fatal: false }),
    stderr: new TextDecoder("utf-8", { fatal: false }),
  };
  private readonly partial: Record<OutputStream, string> = { stdout: "", stderr: "" };
  private readonly lines: string[] = [];
  private size = 0;
  private settled: TranscriptVerdict | null = null;

  constructor(readonly provider: ProviderId) {}

  push(chunk: Uint8Array | string, stream: OutputStream = "stdout"): TranscriptVerdict {
    if (this.settled) return this.settled;
    const text = typeof chunk === "string" ? chunk : this.decoders[stream].decode(chunk, { stream: true });
    this.size += text.length;
    if (this.size > MAX_TRANSCRIPT_CHARS) {
      return (this.settled = { kind: "unrecognised", why: "sign-in output exceeded the size cap" });
    }
    const parts = (this.partial[stream] + text).split("\n");
    this.partial[stream] = parts.pop() ?? "";
    this.lines.push(...parts);
    return this.verdict();
  }

  verdict(): TranscriptVerdict {
    if (this.settled) return this.settled;
    const v = parseLines(this.provider, this.lines, [this.partial.stdout, this.partial.stderr]);
    if (v.kind === "failed" || v.kind === "unrecognised") this.settled = v;
    return v;
  }
}

/** Parses an entire single-stream transcript (or its prefix) — the pure core of `LoginTranscript`. */
export function parseLoginOutput(provider: ProviderId, raw: string): TranscriptVerdict {
  const lines = raw.split("\n");
  const partial = lines.pop() ?? "";
  return parseLines(provider, lines, [partial]);
}

function parseLines(provider: ProviderId, rawLines: readonly string[], rawPartials: readonly string[]): TranscriptVerdict {
  const targets: string[] = [];
  const lines = rawLines.map((l) => {
    const { text, hyperlinkTargets } = stripTerminalControls(l);
    targets.push(...hyperlinkTargets);
    return text;
  });
  // A partial line may end mid-escape: judge only the text before any ESC.
  const partials = rawPartials.map((p) => stripTerminalControls(p.split("\x1b")[0]).text);
  switch (provider) {
    case "claude": return parseClaude(lines, partials, targets);
    case "codex": return parseCodex(lines, targets);
    default: {
      const never: never = provider;
      throw new Error(`unknown provider ${String(never)}`);
    }
  }
}
