/**
 * Golden-task directory loader. Reads every `.yaml`/`.yml` file under a tasks
 * directory, deserializes it, validates it against the golden-task schema, and
 * confirms its `start_commit` exists in the repo. The contract that matters:
 * a single bad task NEVER aborts the run — a malformed file, a schema
 * violation, or a missing start_commit produces a per-file exclusion with a
 * human-readable reason, and the remaining good tasks still load.
 *
 * Commit existence is taken as an injected predicate (EC-7 idiom: the pure core
 * never touches the filesystem/git, so it is hermetically testable; the IO
 * wrapper supplies the real `git cat-file` probe). The default probe resolves
 * `<sha>^{commit}` so a SHA that exists only as a tree/blob is still rejected.
 *
 * Firewall-clean: imports only the eval schema + node/bun builtins. Never
 * `server/`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseGoldenTask } from "../schema/parse-golden-task.js";
import type { GoldenTask } from "../schema/golden-task.js";

/** Predicate: does this git SHA resolve to a commit in the repo? */
export type CommitExists = (sha: string) => boolean;

/** One task that could not be loaded, with the precise reason. */
export interface GoldenTaskExclusion {
  /** Filename (basename) of the offending task file. */
  file: string;
  /** Field-level parse reason, YAML error, or missing-commit message. */
  reason: string;
}

export interface LoadedGoldenTasks {
  /** Tasks that parsed AND whose start_commit exists, sorted by id. */
  tasks: GoldenTask[];
  /** Tasks excluded with a reason, sorted by file. */
  excluded: GoldenTaskExclusion[];
}

/**
 * Pure classifier for one task source. Returns the typed task or an exclusion
 * reason. Folds the three rejection classes (bad YAML → schema violation →
 * missing commit) into one ordered pipeline so the FIRST failure is reported.
 */
export function classifyGoldenTaskSource(
  yamlText: string,
  commitExists: CommitExists,
): { ok: true; task: GoldenTask } | { ok: false; reason: string } {
  let deserialized: unknown;
  try {
    deserialized = parseYaml(yamlText);
  } catch (err) {
    return { ok: false, reason: `YAML parse error: ${(err as Error).message}` };
  }
  const parsed = parseGoldenTask(deserialized);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (!commitExists(parsed.value.start_commit)) {
    return {
      ok: false,
      reason: `start_commit ${parsed.value.start_commit} does not exist in the repo`,
    };
  }
  return { ok: true, task: parsed.value };
}

/** Default commit probe: `git cat-file -e <sha>^{commit}` against the repo
 *  containing the tasks dir. Non-zero exit (unknown/ambiguous SHA) → false. */
export function gitCommitExists(repoCwd: string): CommitExists {
  return (sha: string) => {
    try {
      execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
        cwd: repoCwd,
        stdio: ["ignore", "ignore", "ignore"],
      });
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * Load + validate all golden tasks in `dir`. `commitExists` defaults to a real
 * `git cat-file` probe rooted at `dir`; tests inject a pure predicate. Iteration
 * is sorted so `tasks`/`excluded` are order-stable across runs.
 */
export function loadGoldenTasks(
  dir: string,
  commitExists: CommitExists = gitCommitExists(dir),
): LoadedGoldenTasks {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  const tasks: GoldenTask[] = [];
  const excluded: GoldenTaskExclusion[] = [];

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch (err) {
      excluded.push({ file, reason: `read error: ${(err as Error).message}` });
      continue;
    }
    const result = classifyGoldenTaskSource(text, commitExists);
    if (result.ok) tasks.push(result.task);
    else excluded.push({ file, reason: result.reason });
  }

  tasks.sort((a, b) => a.id.localeCompare(b.id));
  return { tasks, excluded };
}
