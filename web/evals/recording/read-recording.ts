/**
 * Eval-local recording reader. The harness must score recordings produced
 * by ANY Aura build, so it deliberately does NOT import `server/replay.ts`
 * (that would couple the portable scorers to server internals and break the
 * import firewall). This is the firewall-permitted "local recording-reader":
 * it knows only the on-disk JSONL shape, nothing about the live server.
 *
 * Truncation tolerance: a recording is appended line-by-line and may be read
 * while the process is still writing (or after a crash), so the final line
 * can be a partial JSON fragment. Malformed lines are skipped, never thrown
 * on — matching the server-side replay loader's contract.
 */

import { readFileSync } from "node:fs";

export interface RecordingHeader {
  _header: true;
  version: number;
  session_id?: string;
  backend_type?: string;
  started_at?: string;
  cwd?: string;
  redactionApplied?: boolean;
}

export interface RecordingEntry {
  ts: number;
  dir: "in" | "out";
  ch: "cli" | "browser";
  /** The exact original protocol frame string — never re-serialized. */
  raw: string;
  origin?: string;
}

export interface LoadedRecording {
  header: RecordingHeader | null;
  entries: RecordingEntry[];
  /** Convenience: header.backend_type, or "" when the header is absent. */
  backendType: string;
}

function isHeader(v: unknown): v is RecordingHeader {
  return typeof v === "object" && v !== null && (v as { _header?: unknown })._header === true;
}

function isEntry(v: unknown): v is RecordingEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.ts === "number" &&
    (e.dir === "in" || e.dir === "out") &&
    (e.ch === "cli" || e.ch === "browser") &&
    typeof e.raw === "string"
  );
}

/** Parse already-read JSONL text. Split out from {@link loadRecording} so
 *  tests and the runner can share the exact same tolerant parser. */
export function parseRecording(text: string): LoadedRecording {
  let header: RecordingHeader | null = null;
  const entries: RecordingEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Truncated tail or otherwise malformed line — skip, don't throw.
      continue;
    }
    if (isHeader(parsed)) {
      // First header wins; a recording has exactly one.
      if (header === null) header = parsed;
      continue;
    }
    if (isEntry(parsed)) {
      const entry: RecordingEntry = {
        ts: parsed.ts,
        dir: parsed.dir,
        ch: parsed.ch,
        raw: parsed.raw,
        ...(typeof parsed.origin === "string" ? { origin: parsed.origin } : {}),
      };
      entries.push(entry);
    }
  }
  return { header, entries, backendType: header?.backend_type ?? "" };
}

export function loadRecording(path: string): LoadedRecording {
  return parseRecording(readFileSync(path, "utf8"));
}
