#!/usr/bin/env bun
// pack-smoke: install the npm tarball into a clean HOME and prove the UI/UX toolkit
// reaches a real spawn (spec `uiux-agent-enrichment.md` AC2.1, AC2.3, AC2.5; PLAN
// Task 9 — hashimoto R1 "test the artifact, not the repo").
//
//   bun scripts/pack-smoke.ts <aura-companion-x.y.z.tgz>
//
// The tarball is installed once (npm, production deps only). Then the server is
// started FROM THE INSTALLED PACKAGE three times, each with a fresh HOME:
//   plain   — the session's spawn argv carries `--plugin-dir <exposure>`, and the
//             exposure links every shipped skill;
//   seeded  — a user skill with a shipped name is planted in ~/.claude/skills first;
//             it is byte-identical afterwards and absent from the exposure (the
//             user's skill wins);
//   off     — Settings → "UI/UX toolkit" off: the pack is installed but the spawn
//             argv has no `--plugin-dir`.
// The Claude CLI is a stand-in that answers `--help` like a CLI with
// `--plugin-dir` support and records its argv; nothing talks to Anthropic.
// Exit 0 only when all three runs pass. The server is stopped by its own pid.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { readTree, sha256, type SkillManifest } from "../server/skill-manifest.js";

export type RunKind = "plain" | "seeded" | "off";

export interface RunObservation {
  kind: RunKind;
  /** Manifest the installed package carries (null: the package has no skill pack). */
  manifest: SkillManifest | null;
  packInstalled: boolean;
  /** argv of the first Claude spawn (null: no spawn recorded). */
  argv: string[] | null;
  /** Skill names linked in the --plugin-dir exposure (null: no exposure dir). */
  exposed: string[] | null;
  /** The seeded user skill's tree digest before and after the run (seeded only). */
  seeded?: { name: string; before: string; after: string | null };
}

export const SEEDED_SKILL = "taste-skill";

/** The skills a clean install must expose to Claude: shipped, invocable, Claude-compatible. */
export function expectedClaudeSkills(m: SkillManifest): string[] {
  return m.entries.filter((e) => e.ship.status === "ship" && e.kind === "skill" && e.compat.claude).map((e) => e.name).sort();
}

/** Pure verdict for one run; an empty list means the run passed. */
export function judgeRun(o: RunObservation): string[] {
  const errs: string[] = [];
  if (!o.manifest) return ["the installed package has no packs/skills/skills-manifest.json"];
  if (!o.packInstalled) errs.push("boot did not install the pack (~/.companion/skill-pack/current.json missing)");
  if (!o.argv) return [...errs, "no Claude spawn was recorded"];
  const i = o.argv.indexOf("--plugin-dir");
  if (o.kind === "off") {
    if (i >= 0) errs.push(`toolkit is off but the spawn argv has --plugin-dir ${o.argv[i + 1]}`);
    return errs;
  }
  if (i < 0 || !o.argv[i + 1]) return [...errs, "the spawn argv has no --plugin-dir"];
  let want = expectedClaudeSkills(o.manifest);
  if (o.kind === "seeded") want = want.filter((n) => n !== o.seeded?.name);
  const got = [...(o.exposed ?? [])].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) errs.push(`exposure links ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  if (o.kind === "seeded") {
    if (!o.seeded) errs.push("seeded run without a seeded skill");
    else if (o.seeded.after !== o.seeded.before) errs.push(`the user's ${o.seeded.name} changed (before ${o.seeded.before.slice(0, 12)}, after ${String(o.seeded.after).slice(0, 12)})`);
  }
  return errs;
}

// ─── Effect shell ───────────────────────────────────────────────────────────

function treeDigest(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const t = readTree(dir);
  return sha256([...t].map(([p, b]) => `${p}\0${sha256(b)}\n`).join(""));
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (typeof a === "object" && a ? res(a.port) : rej(new Error("no port"))));
    });
  });
}

async function waitFor<T>(fn: () => Promise<T | null> | T | null, ms: number): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v !== null) return v;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

function writeFakeClaude(binDir: string, argvLog: string): string {
  mkdirSync(binDir, { recursive: true });
  const p = join(binDir, "claude");
  writeFileSync(
    p,
    `#!${process.execPath}
const a = process.argv.slice(2);
if (a.includes("--help")) { console.log("  --plugin-dir <paths...>  Load plugins from directories for this session only"); process.exit(0); }
if (a.includes("--version")) { console.log("2.1.283 (Claude Code)"); process.exit(0); }
require("node:fs").appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(a) + "\\n");
`,
  );
  chmodSync(p, 0o755);
  return p;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const done = await waitFor(() => (child.exitCode !== null || child.signalCode !== null ? true : null), 10_000);
  if (!done) child.kill("SIGKILL");
}

async function runOnce(kind: RunKind, pkgDir: string, work: string): Promise<{ obs: RunObservation; log: string }> {
  const run = mkdtempSync(join(work, `${kind}-`));
  const home = join(run, "home");
  const project = join(run, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const argvLog = join(run, "claude-argv.jsonl");
  const fakeClaude = writeFakeClaude(join(run, "bin"), argvLog);

  let seeded: RunObservation["seeded"];
  if (kind === "seeded") {
    const dir = join(home, ".claude", "skills", SEEDED_SKILL);
    mkdirSync(join(dir, "references"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${SEEDED_SKILL}\ndescription: the user's own taste skill\n---\nMine.\n`);
    writeFileSync(join(dir, "references", "notes.md"), "user notes\n");
    seeded = { name: SEEDED_SKILL, before: treeDigest(dir)!, after: null };
  }

  const port = await freePort();
  const token = "pack-smoke-token-0123456789abcdef";
  const logPath = join(run, "server.log");
  const out = openSync(logPath, "a");
  const env: Record<string, string> = {
    HOME: home,
    PATH: [dirname(fakeClaude), dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    TMPDIR: join(run, "tmp"),
    PORT: String(port),
    COMPANION_AUTH_TOKEN: token,
    NODE_ENV: "production",
    LANG: "C.UTF-8",
  };
  mkdirSync(env.TMPDIR, { recursive: true });
  const server = spawn(process.execPath, [join(pkgDir, "bin", "cli.ts"), "serve"], { env, cwd: run, stdio: ["ignore", out, out] });
  const base = `http://127.0.0.1:${port}/api`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    const up = await waitFor(async () => ((await fetch(`${base}/sessions`, { headers })).ok ? true : null), 60_000);
    if (!up) {
      const tail = readFileSync(logPath, "utf8").split("\n").slice(-15).join("\n    ");
      throw new Error(`server did not answer on :${port}; last log lines:\n    ${tail}`);
    }
    if (kind === "off") {
      const r = await fetch(`${base}/settings`, { method: "PUT", headers, body: JSON.stringify({ uiuxToolkit: false }) });
      if (!r.ok) throw new Error(`PUT /settings → ${r.status} ${await r.text()}`);
    }
    const r = await fetch(`${base}/sessions/create`, {
      method: "POST", headers, body: JSON.stringify({ backendType: "claude", cwd: project, claudeBinary: fakeClaude }),
    });
    if (!r.ok) throw new Error(`POST /sessions/create → ${r.status} ${await r.text()}`);
    const argv = await waitFor(() => (existsSync(argvLog) ? (JSON.parse(readFileSync(argvLog, "utf8").split("\n")[0]) as string[]) : null), 30_000);

    const pack = join(home, ".companion", "skill-pack");
    const i = argv ? argv.indexOf("--plugin-dir") : -1;
    const expo = i >= 0 && argv ? join(argv[i + 1], "skills") : null;
    const manifestPath = join(pkgDir, "packs", "skills", "skills-manifest.json");
    if (seeded) seeded.after = treeDigest(join(home, ".claude", "skills", SEEDED_SKILL));
    const obs: RunObservation = {
      kind,
      manifest: existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")) as SkillManifest) : null,
      packInstalled: existsSync(join(pack, "current.json")),
      argv,
      exposed: expo && existsSync(expo) ? readdirSync(expo) : null,
      ...(seeded ? { seeded } : {}),
    };
    return { obs, log: logPath };
  } finally {
    await stop(server);
  }
}

async function main(tarball: string): Promise<number> {
  const work = mkdtempSync(join(tmpdir(), "aura-pack-smoke-"));
  const prefix = join(work, "install");
  mkdirSync(prefix, { recursive: true });
  writeFileSync(join(prefix, "package.json"), "{\"private\":true}\n");
  console.log(`pack-smoke: installing ${tarball} into ${prefix}`);
  const inst = spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--cache", join(work, "npm-cache"), resolve(tarball)], {
    cwd: prefix, stdio: "inherit", env: { ...process.env, HOME: join(work, "install-home") },
  });
  if (inst.status !== 0) {
    console.error("pack-smoke: npm install failed");
    return 1;
  }
  const pkgDir = join(prefix, "node_modules", "aura-companion");
  let failed = 0;
  for (const kind of ["plain", "seeded", "off"] as RunKind[]) {
    try {
      const { obs, log } = await runOnce(kind, pkgDir, work);
      const errs = judgeRun(obs);
      if (errs.length) {
        failed++;
        console.error(`✗ ${kind}\n  - ${errs.join("\n  - ")}\n  server log: ${log}`);
      } else console.log(`✓ ${kind}${obs.exposed ? ` (exposed: ${obs.exposed.length} skills)` : " (no --plugin-dir)"}`);
    } catch (err) {
      failed++;
      console.error(`✗ ${kind}: ${(err as Error).message}`);
    }
  }
  console.log(failed ? `pack-smoke FAILED (${failed}/3); work dir kept: ${work}` : "pack-smoke OK (3/3)");
  return failed ? 1 : 0;
}

if (import.meta.main) {
  const tarball = process.argv[2];
  if (!tarball) {
    console.error("usage: bun scripts/pack-smoke.ts <aura-companion-x.y.z.tgz>");
    process.exit(2);
  }
  process.exit(await main(tarball));
}
