import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isProvenLoginVersion,
  LoginTranscript,
  parseLoginOutput,
  stripTerminalControls,
  type TranscriptVerdict,
} from "./login-transcript.js";

// Replay tests (EC-6) for the sign-in output parsers (phase 2 plan task 3,
// S1-AC1). The fixtures are the byte-for-byte transcripts captured 2026-11-14
// from claude 2.1.283 and codex 0.162.1 (ANSI colours included), with the
// attempt secrets (Claude `state` / `code_challenge`, the Codex one-time code)
// replaced by synthetic values of the same shape. Each transcript is fed
// whole and cut into 1-byte chunks (UTF-8 "…" and ANSI escapes split
// mid-sequence) — the verdict must be identical. Negatives prove fail-closed:
// a foreign host, an OSC 8 hyperlink whose hidden target differs, trailing
// junk after the link, an unknown line, a code outside the template.

const FIXTURES = join(import.meta.dirname, "fixtures");
const claudeTranscript = readFileSync(join(FIXTURES, "claude-auth-login-2.1.283.txt"));
const codexTranscript = readFileSync(join(FIXTURES, "codex-login-device-auth-0.162.1.txt"));

function feedBytewise(provider: "claude" | "codex", bytes: Uint8Array): TranscriptVerdict[] {
  const t = new LoginTranscript(provider);
  const verdicts: TranscriptVerdict[] = [];
  for (let i = 0; i < bytes.length; i++) verdicts.push(t.push(bytes.subarray(i, i + 1)));
  return verdicts;
}

describe("login transcript replay (2026-11-14 captures)", () => {
  it("S1-AC1 claude: link + state + prompt → ready; whole and 1-byte chunks agree", () => {
    const whole = new LoginTranscript("claude").push(claudeTranscript);
    expect(whole).toEqual({
      kind: "ready",
      prompt: { provider: "claude", url: expect.stringMatching(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/), state: `SYNTHstate${"x".repeat(33)}` },
    });
    const verdicts = feedBytewise("claude", claudeTranscript);
    expect(verdicts.at(-1)).toEqual(whole);
    // Ready only once the newline-less prompt is complete ("…prompted >" + the trailing space).
    const firstReady = verdicts.findIndex((v) => v.kind === "ready");
    expect(firstReady).toBe(claudeTranscript.length - 2);
    expect(verdicts.slice(0, firstReady).every((v) => v.kind === "pending")).toBe(true);
  });

  it("S1-AC1 codex: link + device code + expiry → ready through the ANSI colours; whole and 1-byte chunks agree", () => {
    const whole = new LoginTranscript("codex").push(codexTranscript);
    expect(whole).toEqual({
      kind: "ready",
      prompt: { provider: "codex", url: "https://auth.openai.com/codex/device", userCode: "SYN7-H3TIC", expiresInMinutes: 15 },
    });
    const verdicts = feedBytewise("codex", codexTranscript);
    expect(verdicts.at(-1)).toEqual(whole);
    // Never ready before the code line is complete, never a failure on the way.
    const firstReady = verdicts.findIndex((v) => v.kind === "ready");
    expect(verdicts.slice(0, firstReady).every((v) => v.kind === "pending")).toBe(true);
    expect(codexTranscript.subarray(0, firstReady + 1).toString()).toMatch(/SYN7-H3TIC\x1b\[0m\n$/);
  });

  it("a prefix without the full field set stays pending (claude: no prompt; codex: no code)", () => {
    const claudeText = claudeTranscript.toString();
    expect(parseLoginOutput("claude", claudeText.slice(0, claudeText.indexOf("Paste")))).toEqual({ kind: "pending" });
    const codexText = codexTranscript.toString();
    expect(parseLoginOutput("codex", codexText.slice(0, codexText.indexOf("2. Enter")))).toEqual({ kind: "pending" });
  });

  it("known failure lines map to reasons (claude 400 → code_rejected; codex no network → network)", () => {
    const t = new LoginTranscript("claude");
    t.push(claudeTranscript);
    expect(t.push("Login failed: Request failed with status code 400\n", "stderr")).toEqual({ kind: "failed", reason: "code_rejected" });
    expect(
      parseLoginOutput(
        "codex",
        "Error logging in with device code: error sending request for url (https://auth.openai.com/api/accounts/deviceauth/usercode)\n",
      ),
    ).toEqual({ kind: "failed", reason: "network" });
  });

  it("success is never read from text: output after the prompt changes nothing", () => {
    const t = new LoginTranscript("claude");
    t.push(claudeTranscript);
    expect(t.push("Login successful.\n").kind).toBe("ready");
    const c = new LoginTranscript("codex");
    c.push(codexTranscript);
    expect(c.push("Successfully logged in\n").kind).toBe("ready");
  });

  it("stdout and stderr lines do not splice into each other", () => {
    const t = new LoginTranscript("codex");
    const text = codexTranscript.toString();
    const cut = text.indexOf("SYN7");
    t.push(text.slice(0, cut), "stdout");
    // A warning on stderr while the stdout code line is half written.
    t.push("WARNING: proceeding, even though we could not create PATH aliases: x\n", "stderr");
    expect(t.push(text.slice(cut), "stdout").kind).toBe("ready");
  });
});

describe("login transcript — fail-closed negatives", () => {
  const claudeText = claudeTranscript.toString();
  const codexText = codexTranscript.toString();

  it("foreign host, http, credentials or port in the link → unrecognised", () => {
    for (const bad of [
      "https://claude.com.evil.test/cai/oauth/authorize?",
      "http://claude.com/cai/oauth/authorize?",
      "https://user@claude.com/cai/oauth/authorize?",
      "https://claude.com:8443/cai/oauth/authorize?",
      "https://claude.com/cai/oauth/authorize/../x?",
    ]) {
      const v = parseLoginOutput("claude", claudeText.replace("https://claude.com/cai/oauth/authorize?", bad));
      expect(v.kind, bad).toBe("unrecognised");
    }
    expect(parseLoginOutput("codex", codexText.replace("https://auth.openai.com/codex/device", "https://auth.openai.co/codex/device")).kind).toBe(
      "unrecognised",
    );
  });

  it("OSC 8 hyperlink with a different hidden target → unrecognised; same target → ready", () => {
    const url = "https://auth.openai.com/codex/device";
    const spoofed = codexText.replace(url, `\x1b]8;;https://evil.test/phish\x1b\\${url}\x1b]8;;\x1b\\`);
    expect(parseLoginOutput("codex", spoofed)).toEqual({ kind: "unrecognised", why: "hyperlink target differs from the sign-in link" });
    const honest = codexText.replace(url, `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`);
    expect(parseLoginOutput("codex", honest).kind).toBe("ready");
  });

  it("trailing junk after the link, a missing state, or an unknown line → unrecognised", () => {
    expect(parseLoginOutput("claude", claudeText.replace(/(state=\S+)\n/, "$1 trailing-junk\n")).kind).toBe("unrecognised");
    expect(parseLoginOutput("claude", claudeText.replace(/&state=\S+/, "")).kind).toBe("unrecognised");
    expect(parseLoginOutput("claude", `Something new\n${claudeText}`).kind).toBe("unrecognised");
    expect(parseLoginOutput("codex", codexText.replace("Follow these steps", "Follow these new steps")).kind).toBe("unrecognised");
  });

  it("codex device code outside the closed template → unrecognised", () => {
    for (const code of ["SYN7-H3TI", "syn7-h3tic", "SYN7H3TIC", "SYN7-H3TIC-X", "<b>-H3TIC"]) {
      expect(parseLoginOutput("codex", codexText.replace("SYN7-H3TIC", code)).kind, code).toBe("unrecognised");
    }
  });

  it("unknown failure text is not guessed: Login failed with a non-4xx → cli_output_unrecognised", () => {
    expect(parseLoginOutput("claude", `${claudeText}Login failed: socket hang up\n`)).toEqual({ kind: "failed", reason: "cli_output_unrecognised" });
  });

  it("output beyond the 64KB cap → unrecognised and sticky", () => {
    const t = new LoginTranscript("codex");
    expect(t.push("x".repeat(65 * 1024)).kind).toBe("unrecognised");
    expect(t.push(codexText).kind).toBe("unrecognised");
  });

  it("a half-received line never yields a verdict (incomplete escape, unknown text)", () => {
    expect(parseLoginOutput("codex", "garbage without newline \x1b[9")).toEqual({ kind: "pending" });
    expect(parseLoginOutput("claude", "garbage without newline")).toEqual({ kind: "pending" });
  });
});

describe("terminal control stripping", () => {
  it("removes CSI, OSC, C0 and C1 controls and normalises CR", () => {
    const { text, hyperlinkTargets } = stripTerminalControls("a\x1b[94mb\x1b[0m\x07c\x9bd\r\ne\x1b]0;title\x07f\x1b]8;;https://x.test\x1b\\g");
    expect(text).toBe("abcd\nefg");
    expect(hyperlinkTargets).toEqual(["https://x.test"]);
  });
});

describe("PROVEN_LOGIN_VERSIONS", () => {
  it("lists the verified CLI versions; unknown or other versions are unproven (allowed, flagged)", () => {
    expect(isProvenLoginVersion("claude", "2.1.283")).toBe(true);
    expect(isProvenLoginVersion("codex", "0.162.1")).toBe(true);
    expect(isProvenLoginVersion("claude", "2.1.284")).toBe(false);
    expect(isProvenLoginVersion("codex", null)).toBe(false);
  });
});
