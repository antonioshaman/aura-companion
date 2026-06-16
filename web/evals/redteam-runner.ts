/**
 * Council Eval Harness red-team runner.
 *
 *   bun run eval:redteam [--dir <responses-dir>] [--markdown]
 *
 * Scores the checked-in {@link REDTEAM_PROBES} against CAPTURED responses on
 * disk — one `<probe_id>.response.txt` per probe in `--dir` (defaults to the
 * synthetic `defended` fixtures). It is a deterministic, zero-LLM matcher: it
 * sends no payload anywhere and makes no network/CLI call. A LIVE red-team run
 * that actually feeds probes to a model is a separate opt-in tool with its own
 * security spec; this runner only judges already-captured text.
 *
 * Exit code is load-bearing so it can gate a deliberate red-team corpus: 0 when
 * every probe with a response defended AND none are missing, 1 on any breach or
 * missing response, 2 on a usage/IO error.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REDTEAM_PROBES } from "./redteam/probes.js";
import {
  renderRedTeamMarkdown,
  renderRedTeamText,
  scoreRedTeam,
} from "./redteam/matcher.js";

const RESPONSE_SUFFIX = ".response.txt";

const DEFAULT_DIR = fileURLToPath(new URL("./redteam/__fixtures__/defended", import.meta.url));

interface Args {
  dir: string;
  markdown: boolean;
}

function parseArgs(argv: string[]): Args {
  let dir = DEFAULT_DIR;
  let markdown = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") dir = argv[++i] ?? dir;
    else if (a === "--markdown") markdown = true;
  }
  return { dir, markdown };
}

/** Load `<probe_id>.response.txt` files from `dir` into a probe_id → text map. */
export function loadResponses(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(RESPONSE_SUFFIX)) continue;
    const probeId = f.slice(0, -RESPONSE_SUFFIX.length);
    out[probeId] = readFileSync(join(dir, f), "utf8");
  }
  return out;
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (!statSync(args.dir).isDirectory()) {
    process.stderr.write(`not a directory: ${args.dir}\n`);
    return 2;
  }
  const responses = loadResponses(args.dir);
  const summary = scoreRedTeam(REDTEAM_PROBES, responses);
  const out = args.markdown ? renderRedTeamMarkdown(summary) : renderRedTeamText(summary);
  process.stdout.write(out + "\n");
  return summary.all_defended ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`eval:redteam error: ${(err as Error).message}\n`);
    process.exit(2);
  }
}
