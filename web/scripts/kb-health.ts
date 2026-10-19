#!/usr/bin/env bun
// Knowledge-base lifecycle CLI (spec `aura-meta-diet.md`, Story A2):
//   report / record / prune. The engine itself lives in
//   `web/server/knowledge/kb-store.ts` (the diagnostics analyzer imports it from
//   the server side); this file keeps only argv parsing and output, and
//   re-exports the engine so existing imports keep working.

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  computeHealth,
  DEFAULT_IDLE_THRESHOLD,
  formatHealth,
  loadKb,
  pruneKb,
  readUsageLog,
  recordPrime,
} from "../server/knowledge/kb-store.js";

export * from "../server/knowledge/kb-store.js";

// ─── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `usage: bun scripts/kb-health.ts [report|record|prune] [options]
  report [--json]                   health summary; exit 1 if any line is corrupt
  record [--session <id>] <id>...   /prime: append one usage-log line (stores untouched)
  prune [--dry-run]                 archive entries idle >= threshold sessions
  --kb-dir <path>                   default: <repo>/.agents/knowledge
  --threshold <n>                   idle threshold (default ${DEFAULT_IDLE_THRESHOLD})`;

export function runCli(argv: string[], io: { out: (s: string) => void; err: (s: string) => void }): number {
  let kbDir = resolve(import.meta.dirname, "..", "..", ".agents", "knowledge");
  let threshold = DEFAULT_IDLE_THRESHOLD;
  let json = false;
  let dryRun = false;
  let session: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--kb-dir") kbDir = resolve(argv[++i] ?? "");
    else if (a === "--threshold") {
      threshold = Number(argv[++i]);
      if (!Number.isInteger(threshold) || threshold < 1) {
        io.err("--threshold must be a positive integer");
        return 2;
      }
    } else if (a === "--json") json = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--session") {
      session = argv[++i];
      if (!session) {
        io.err("--session needs a non-empty id");
        return 2;
      }
    }
    else if (a === "--help" || a === "-h") {
      io.out(USAGE);
      return 0;
    } else if (a.startsWith("--")) {
      io.err(`unknown option ${a}\n${USAGE}`);
      return 2;
    } else positional.push(a);
  }
  const cmd = positional.shift() ?? "report";
  if (!existsSync(kbDir)) {
    io.err(`KB dir not found: ${kbDir}`);
    return 2;
  }

  if (cmd === "report") {
    const h = computeHealth(loadKb(kbDir), readUsageLog(kbDir), threshold);
    io.out(json ? JSON.stringify(h, null, 2) : formatHealth(h));
    return h.errors.length > 0 ? 1 : 0;
  }
  if (cmd === "record") {
    const r = recordPrime(kbDir, positional, { session });
    io.out(`recorded prime session ${r.session}: ${r.surfaced.length} entries surfaced`);
    if (r.unknown.length > 0) {
      io.err(`unknown KB ids (not recorded): ${r.unknown.join(", ")}`);
      return 1;
    }
    return 0;
  }
  if (cmd === "prune") {
    const r = pruneKb(kbDir, { threshold, dryRun });
    const verb = r.dryRun ? "would archive" : "archived";
    io.out(`${verb} ${r.archived.length} entries${r.archived.length ? ":" : ""}`);
    for (const a of r.archived) io.out(`  ${a.file} ${a.id} — ${a.reason}`);
    return 0;
  }
  io.err(`unknown command ${cmd}\n${USAGE}`);
  return 2;
}

if (import.meta.main) {
  process.exit(
    runCli(process.argv.slice(2), {
      out: (s) => console.log(s),
      err: (s) => console.error(s),
    }),
  );
}
