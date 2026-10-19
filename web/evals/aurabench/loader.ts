/**
 * AuraBench corpus loader — the golden-task loader contract (one bad task never
 * aborts the run; each rejection is a per-file exclusion with a reason) applied
 * to {@link parseAuraBenchTask}. Both `start_commit` and
 * `aurabench.merge_commit` must resolve to commits, and ids must be unique.
 *
 * Commit existence is an injected predicate (EC-7 idiom); the default reuses
 * the golden loader's `git cat-file` probe.
 *
 * Firewall-clean: eval schema + node builtins only. Never `server/`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { gitCommitExists, type CommitExists, type GoldenTaskExclusion } from "../tasks/loader.js";
import { parseAuraBenchTask, type AuraBenchTask } from "./task.js";

export interface LoadedAuraBenchTasks {
  tasks: AuraBenchTask[];
  excluded: GoldenTaskExclusion[];
}

export function classifyAuraBenchTaskSource(
  yamlText: string,
  commitExists: CommitExists,
): { ok: true; task: AuraBenchTask } | { ok: false; reason: string } {
  let deserialized: unknown;
  try {
    deserialized = parseYaml(yamlText);
  } catch (err) {
    return { ok: false, reason: `YAML parse error: ${(err as Error).message}` };
  }
  const parsed = parseAuraBenchTask(deserialized);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  for (const sha of [parsed.value.start_commit, parsed.value.aurabench.merge_commit]) {
    if (!commitExists(sha)) return { ok: false, reason: `commit ${sha} does not exist in the repo` };
  }
  return { ok: true, task: parsed.value };
}

export function loadAuraBenchTasks(
  dir: string,
  commitExists: CommitExists = gitCommitExists(dir),
): LoadedAuraBenchTasks {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  const tasks: AuraBenchTask[] = [];
  const excluded: GoldenTaskExclusion[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch (err) {
      excluded.push({ file, reason: `read error: ${(err as Error).message}` });
      continue;
    }
    const result = classifyAuraBenchTaskSource(text, commitExists);
    if (!result.ok) {
      excluded.push({ file, reason: result.reason });
    } else if (seen.has(result.task.id)) {
      excluded.push({ file, reason: `duplicate task id "${result.task.id}"` });
    } else {
      seen.add(result.task.id);
      tasks.push(result.task);
    }
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  return { tasks, excluded };
}
