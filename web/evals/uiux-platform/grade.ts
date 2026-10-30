// Deterministic grader for the AC3.3 behavioural eval (PLAN Task 13, willison R5).
// No model judges the output: each marker is a regex over the final answer, so a
// stored transcript re-grades to the same verdict forever (replay).
//
// A platform fixture passes when every marker hits and no anti-marker does. The
// web control passes when none of its anti-markers (the platform APIs) leak in.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Fixture {
  id: string;
  kind: "platform" | "web-control";
  prompt: string;
  markers: Record<string, string>;
  antiMarkers: Record<string, string>;
}

export interface Grade {
  markers: Record<string, boolean>;
  antiMarkers: Record<string, boolean>;
  pass: boolean;
}

export const FIXTURES_FILE = join(import.meta.dirname, "fixtures.json");
export const TRANSCRIPTS_DIR = join(import.meta.dirname, "transcripts");

export function loadFixtures(path = FIXTURES_FILE): Fixture[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { fixtures: Fixture[] }).fixtures;
}

const hit = (pattern: string, text: string) => new RegExp(pattern, "i").test(text);

export function grade(output: string, f: Pick<Fixture, "markers" | "antiMarkers">): Grade {
  const fenced = [...output.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const code = (fenced.length ? fenced.join("\n") : output).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const markers = Object.fromEntries(Object.entries(f.markers).map(([k, p]) => [k, hit(p, k === "dynamic-type" ? code : output)]));
  const antiMarkers = Object.fromEntries(Object.entries(f.antiMarkers).map(([k, p]) => [k, hit(p, output)]));
  const pass = Object.values(markers).every(Boolean) && !Object.values(antiMarkers).some(Boolean);
  return { markers, antiMarkers, pass };
}

export interface Transcript {
  fixture: string;
  settingsIsolation?: "project-local";
  /** SHA-256 of the exact skill/reference content used by this experiment. */
  skillRevision?: string;
  /** Actual provider model from the CLI protocol, rather than a mutable alias. */
  resolvedModel?: string;
  arm: "with" | "without";
  model: string;
  run: number;
  startedAt: string;
  /** Tool calls the session made, in order (shows whether the skill was loaded). */
  tools: string[];
  output: string;
  grade: Grade;
}

/** Pass rate per fixture × arm, plus per-marker hit counts. */
export function summarise(ts: Transcript[]): { fixture: string; arm: string; runs: number; passed: number; markerHits: Record<string, number>; skillLoaded: number }[] {
  const groups = new Map<string, Transcript[]>();
  for (const t of ts) groups.set(`${t.fixture}\0${t.arm}`, [...(groups.get(`${t.fixture}\0${t.arm}`) ?? []), t]);
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, g]) => {
      const [fixture, arm] = k.split("\0");
      const markerHits: Record<string, number> = {};
      for (const t of g) for (const [m, v] of Object.entries({ ...t.grade.markers, ...Object.fromEntries(Object.entries(t.grade.antiMarkers).map(([a, x]) => [`!${a}`, x])) })) markerHits[m] = (markerHits[m] ?? 0) + (v ? 1 : 0);
      return { fixture, arm, runs: g.length, passed: g.filter((t) => t.grade.pass).length, markerHits, skillLoaded: g.filter((t) => t.tools.some((x) => /aura-uiux/.test(x))).length };
    });
}

/** Historical N=10 cohort was verified against the isolated runner in #442.
 * Older probes remain replayable, but cannot be pooled into the report.
 */
export function isolatedTranscripts(ts: Transcript[]): Transcript[] {
  return ts.filter((t) => t.settingsIsolation === "project-local" || t.startedAt === "2026-10-28T17:26:35Z");
}
