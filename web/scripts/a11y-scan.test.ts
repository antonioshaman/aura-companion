/**
 * Rendered-UI a11y scan (PLAN-aura-uiux-agent-enrichment Task 15, spec Story 4).
 *
 * What these tests pin:
 *  - exactly three outcomes, and a scan that could not vouch for the UI (no
 *    browser, server down, blank page, crash partway, timeout) is `skipped` with
 *    a reason. It is never `pass`, even when it found violations before stopping;
 *  - axe "incomplete" is "needs manual check", and a pass never claims "accessible";
 *  - only loopback URLs, secrets stripped from every output, the browser session
 *    closed + force-killed and the temp profile removed on every path;
 *  - for real: with agent-browser removed from PATH the CLI reports "skipped: no
 *    browser" and exits 3; with a real browser (when installed) a fixture page
 *    with planted violations fails with rule id, selector, criterion and state,
 *    and a blank page is skipped.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type RawAxeState,
  type RunResult,
  type ScanDeps,
  type ScanOptions,
  type StateRef,
  EXIT,
  MANUAL_CHECKLIST,
  NOT_A_CLAIM,
  checkUrl,
  criteriaFromTags,
  decide,
  parseArgs,
  pinnedAxeVersion,
  redactOutput,
  renderMarkdown,
  runScan,
  summarizeState,
  writeArtifact,
} from "./a11y-scan.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "a11y-scan.ts");
const FIXTURES = join(here, "__fixtures__", "a11y-scan");
// Vitest runs under node; the script is a bun script. CI and dev boxes have bun on PATH.
const onPath = (bin: string) => (process.env.PATH ?? "").split(delimiter).map((d) => join(d, bin)).find((p) => existsSync(p));
const BUN = onPath("bun") ?? join(process.env.HOME ?? "", ".bun", "bin", "bun");
const REF: StateRef = { url: "http://127.0.0.1:5174/#/x", theme: "light", viewport: "375x812" };

function raw(over: Partial<RawAxeState> = {}): RawAxeState {
  return { axeVersion: "4.11.1", elements: 40, passNodes: 120, violations: [], incomplete: [], ...over };
}

const VIOLATION = {
  id: "button-name", impact: "critical", tags: ["cat.name-role-value", "wcag2a", "wcag412"],
  help: "Buttons must have discernible text", helpUrl: "https://dequeuniversity.com/rules/axe/4.11/button-name",
  nodes: [{ target: ["#close"] }],
};

describe("pure core", () => {
  it("only loopback http(s) URLs can be scanned", () => {
    for (const ok of ["http://127.0.0.1:5174/#/playground", "http://localhost:3457/", "http://[::1]:8080/a"]) {
      expect(checkUrl(ok)).toBeNull();
    }
    expect(checkUrl("https://auraco.space/")).toMatch(/only loopback/);
    expect(checkUrl("http://10.0.0.5:5174/")).toMatch(/only loopback/);
    expect(checkUrl("http://127.0.0.1.evil.com/")).toMatch(/only loopback/);
    expect(checkUrl("file:///etc/passwd")).toMatch(/only http/);
    expect(checkUrl("http://u:p@127.0.0.1/")).toMatch(/credentials/);
    expect(checkUrl("not a url")).toMatch(/not a URL/);
  });

  it("maps axe tags to WCAG criteria and ignores level tags", () => {
    expect(criteriaFromTags(["wcag2a", "wcag412", "wcag21aa", "wcag143", "wcag2411", "best-practice"])).toEqual(["1.4.3", "2.4.11", "4.1.2"]);
  });

  it("a state with zero elements or zero checked nodes is blank", () => {
    expect(summarizeState(REF, raw()).blank).toBe(false);
    expect(summarizeState(REF, raw({ elements: 0 })).blank).toBe(true);
    expect(summarizeState(REF, raw({ passNodes: 0 })).blank).toBe(true);
  });

  it("one violation row per node, with rule id, selector, criterion and state", () => {
    const s = summarizeState(REF, raw({ violations: [{ ...VIOLATION, nodes: [{ target: ["#a"] }, { target: [["#host", "button"]] }] }] }));
    expect(s.violations.map((v) => [v.ruleId, v.selector, v.criteria, v.state.theme])).toEqual([
      ["button-name", "#a", ["4.1.2"], "light"],
      ["button-name", "#host >>> button", ["4.1.2"], "light"],
    ]);
  });

  describe("decide: exactly three outcomes, never pass by default", () => {
    const clean = summarizeState(REF, raw());
    const failing = summarizeState(REF, raw({ violations: [VIOLATION] }));
    it("clean and complete → pass", () => expect(decide([clean, clean], 2, null)).toEqual({ status: "pass", reason: null }));
    it("violations → fail", () => expect(decide([clean, failing], 2, null).status).toBe("fail"));
    it("an abort wins over found violations (crash partway is skipped, not fail or pass)", () => {
      expect(decide([failing], 2, "scan crashed")).toEqual({ status: "skipped", reason: "scan crashed" });
    });
    it("a blank state → skipped", () => {
      expect(decide([clean, summarizeState(REF, raw({ elements: 0, passNodes: 0 }))], 2, null)).toMatchObject({ status: "skipped", reason: expect.stringMatching(/^blank page/) });
    });
    it("fewer states than planned → skipped", () => expect(decide([clean], 2, null).status).toBe("skipped"));
    it("nothing scanned → skipped", () => expect(decide([], 0, null).status).toBe("skipped"));
  });

  it("parseArgs refuses non-loopback URLs and bad flags", () => {
    expect(parseArgs(["--url", "https://example.com/"])).toMatchObject({ error: expect.stringMatching(/only loopback/) });
    expect(parseArgs([])).toMatchObject({ error: expect.stringMatching(/--url/) });
    expect(parseArgs(["--url", "http://127.0.0.1/", "--themes", "sepia"])).toMatchObject({ error: expect.any(String) });
    const ok = parseArgs(["--url", "http://127.0.0.1:1/", "--viewport", "390x844", "--themes=dark", "--browser-args=--no-sandbox"]);
    expect(ok).toMatchObject({ viewport: { width: 390, height: 844 }, themes: ["dark"], browserArgs: "--no-sandbox" });
  });

  it("the axe-core pin must be an exact version", () => {
    expect(pinnedAxeVersion(JSON.stringify({ dependencies: { "axe-core": "4.11.1" } }))).toBe("4.11.1");
    expect(pinnedAxeVersion(JSON.stringify({ dependencies: { "axe-core": "^4.11.1" } }))).toBeNull();
    expect(pinnedAxeVersion(JSON.stringify({}))).toBeNull();
    // The real web/package.json pins it.
    expect(pinnedAxeVersion(readFileSync(join(here, "..", "package.json"), "utf-8"))).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("redacts URL tokens, bearer headers and known secret shapes", () => {
    const out = redactOutput("open http://127.0.0.1:5174/?token=abcdef0123456789abcdef&x=1 Authorization: Bearer abcdefghijklmnop sk-ant-api03-" + "x".repeat(40));
    expect(out).not.toMatch(/abcdef0123456789abcdef|abcdefghijklmnop|x{40}/);
    expect(out).toContain("token=[REDACTED]");
  });
});

describe("renderMarkdown", () => {
  const base = {
    schemaVersion: 1 as const, tool: { name: "axe-core" as const, version: "4.11.1", tags: ["wcag2a"] },
    viewport: "375x812", themes: ["light" as const], urls: [REF.url], states: [], violations: [], needsManualCheck: [],
    notAClaim: NOT_A_CLAIM, manualChecklist: MANUAL_CHECKLIST, startedAt: "", finishedAt: "",
  };
  it("a skipped scan says so up front and never says PASS", () => {
    const md = renderMarkdown({ ...base, status: "skipped", reason: "no browser: agent-browser is not on PATH" });
    expect(md).toMatch(/^# Rendered a11y scan: SKIPPED: no browser/);
    expect(md).toContain("This is not a pass");
    expect(md).not.toMatch(/PASS/);
  });
  it("a pass carries the not-a-claim line and every manual check as not verified", () => {
    const md = renderMarkdown({ ...base, status: "pass", reason: null });
    expect(md).toContain("this is not an accessibility claim");
    expect(md).toContain(NOT_A_CLAIM);
    expect(md.match(/- \[ \] not verified: /g)).toHaveLength(MANUAL_CHECKLIST.length);
  });
  it("incomplete results are listed as needs manual check", () => {
    const md = renderMarkdown({
      ...base, status: "pass", reason: null,
      needsManualCheck: [{ ruleId: "color-contrast", criteria: ["1.4.3"], selector: ".hero", state: REF, help: "contrast" }],
    });
    expect(md).toContain("## Needs manual check (axe incomplete, not a pass)");
    expect(md).toContain("not verified: `color-contrast` on `.hero`");
  });
});

// ─── runScan with injected process/network effects ───────────────────────────

interface FakeLog { calls: string[][]; killed: string[] }

function fakeDeps(script: (args: string[]) => RunResult | Promise<RunResult>, over: Partial<ScanDeps> = {}): { deps: ScanDeps; log: FakeLog } {
  const log: FakeLog = { calls: [], killed: [] };
  const deps: ScanDeps = {
    which: () => "/fake/agent-browser",
    axe: () => ({ path: "/fake/axe.min.js", version: "4.11.1" }),
    probe: async () => null,
    run: async (_cmd, args) => { log.calls.push(args); return script(args); },
    killSession: (s) => { log.killed.push(s); },
    now: () => new Date("2026-10-28T12:00:00Z"),
    ...over,
  };
  return { deps, log };
}

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const evalOk = (r: RawAxeState): RunResult => ok(JSON.stringify({ success: true, data: { result: JSON.stringify(r) }, error: null }));

function opts(over: Partial<ScanOptions> = {}): ScanOptions {
  return { urls: ["http://127.0.0.1:5174/#/a"], themes: ["light", "dark"], viewport: { width: 375, height: 812 }, out: "", timeoutMs: 60_000, settleMs: 0, browserArgs: null, ...over };
}

describe("runScan (injected effects)", () => {
  it("no agent-browser → skipped, and no browser call is made", async () => {
    const { deps, log } = fakeDeps(() => ok(), { which: () => null });
    const a = await runScan(opts(), deps);
    expect([a.status, a.reason]).toEqual(["skipped", "no browser: agent-browser is not on PATH"]);
    expect(log.calls).toEqual([]);
  });

  it("axe-core missing or off-pin → skipped", async () => {
    const { deps } = fakeDeps(() => ok(), { axe: () => ({ error: "installed axe-core 4.10.0 is not the pinned 4.11.1" }) });
    expect(await runScan(opts(), deps)).toMatchObject({ status: "skipped", reason: expect.stringMatching(/not the pinned/) });
  });

  it("server down → skipped with the reason", async () => {
    const { deps } = fakeDeps(() => ok(), { probe: async () => "server down: http://127.0.0.1:5174 is not answering (TypeError)" });
    expect(await runScan(opts(), deps)).toMatchObject({ status: "skipped", reason: expect.stringMatching(/^server down/) });
  });

  it("browser launch failure → skipped, with the sandbox hint on hosts that block it", async () => {
    const { deps, log } = fakeDeps((args) => (args.includes("viewport") ? { code: 1, stdout: "", stderr: "No usable sandbox!", timedOut: false } : ok()));
    const a = await runScan(opts(), deps);
    expect(a).toMatchObject({ status: "skipped", reason: expect.stringMatching(/browser failed to launch.*--no-sandbox/) });
    expect(log.calls.at(-1)).toContain("close");
    expect(log.killed).toHaveLength(1);
  });

  it("launches with the pinned axe as an init script, an empty config, a temp profile and only loopback hosts", async () => {
    const { deps, log } = fakeDeps((args) => (args.includes("eval") ? evalOk(raw()) : ok()));
    const a = await runScan(opts({ browserArgs: "--no-sandbox" }), deps);
    expect(a.status).toBe("pass");
    const first = log.calls[0];
    const flag = (f: string) => first[first.indexOf(f) + 1];
    expect(flag("--init-script")).toBe("/fake/axe.min.js");
    expect(flag("--allowed-domains")).toBe("127.0.0.1");
    expect(flag("--args")).toBe("--no-sandbox");
    expect(flag("--profile")).toMatch(new RegExp(`^${tmpdir()}`));
    expect(existsSync(dirname(flag("--profile")))).toBe(false); // temp dir removed afterwards
    expect(log.calls.filter((c) => c.includes("media")).map((c) => c.at(-1))).toEqual(["light", "dark"]);
  });

  it("a crash partway is skipped, keeps the partial violations, and still cleans up", async () => {
    let evals = 0;
    const { deps, log } = fakeDeps((args) => {
      if (!args.includes("eval")) return ok();
      evals += 1;
      return evals === 1 ? evalOk(raw({ violations: [VIOLATION] })) : { code: 1, stdout: "", stderr: "Target closed", timedOut: false };
    });
    const a = await runScan(opts(), deps);
    expect(a.status).toBe("skipped");
    expect(a.reason).toMatch(/^scan crashed on .* dark/);
    expect(a.violations.map((v) => v.ruleId)).toEqual(["button-name"]);
    expect(renderMarkdown(a)).toContain("Violations found before the scan stopped (partial)");
    expect(log.calls.at(-1)).toContain("close");
    expect(log.killed).toHaveLength(1);
  });

  it("axe not injected into the page → skipped", async () => {
    const { deps } = fakeDeps((args) => (args.includes("eval") ? ok(JSON.stringify({ success: true, data: { result: JSON.stringify({ error: "axe-core was not injected into the page" }) } })) : ok()));
    expect(await runScan(opts(), deps)).toMatchObject({ status: "skipped", reason: expect.stringMatching(/not injected/) });
  });

  it("a blank page → skipped", async () => {
    const { deps } = fakeDeps((args) => (args.includes("eval") ? evalOk(raw({ elements: 0, passNodes: 0 })) : ok()));
    expect(await runScan(opts(), deps)).toMatchObject({ status: "skipped", reason: expect.stringMatching(/^blank page/) });
  });

  it("a timed-out browser call → skipped as timed out", async () => {
    const { deps, log } = fakeDeps((args) => (args.includes("open") ? { code: null, stdout: "", stderr: "", timedOut: true } : ok()));
    const a = await runScan(opts(), deps);
    expect(a).toMatchObject({ status: "skipped", reason: expect.stringMatching(/^timed out/) });
    expect(log.killed).toHaveLength(1);
  });

  it("incomplete results are needs-manual-check and do not turn a pass into a fail", async () => {
    const inc = { id: "color-contrast", tags: ["wcag2aa", "wcag143"], help: "contrast", nodes: [{ target: [".hero"] }] };
    const { deps } = fakeDeps((args) => (args.includes("eval") ? evalOk(raw({ incomplete: [inc] })) : ok()));
    const a = await runScan(opts({ themes: ["light"] }), deps);
    expect(a.status).toBe("pass");
    expect(a.needsManualCheck.map((m) => [m.ruleId, m.criteria])).toEqual([["color-contrast", ["1.4.3"]]]);
  });

  it("the written artifact is redacted", () => {
    const dir = mkdtempSync(join(tmpdir(), "a11y-art-"));
    try {
      const secretUrl = "http://127.0.0.1:5174/?token=supersecretvalue123456";
      const p = writeArtifact(dir, {
        schemaVersion: 1, status: "skipped", reason: `server down: ${secretUrl}`, tool: { name: "axe-core", version: null, tags: [] },
        viewport: "375x812", themes: ["light"], urls: [secretUrl], states: [], violations: [], needsManualCheck: [],
        notAClaim: NOT_A_CLAIM, manualChecklist: MANUAL_CHECKLIST, startedAt: "", finishedAt: "",
      });
      expect(readFileSync(p.json, "utf-8")).not.toContain("supersecretvalue123456");
      expect(readFileSync(p.md, "utf-8")).not.toContain("supersecretvalue123456");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Real processes ──────────────────────────────────────────────────────────

describe("CLI, for real", () => {
  it("with agent-browser removed from PATH it reports skipped: no browser and exits 3", () => {
    // PATH holds only a directory with a bun symlink, so agent-browser cannot be found.
    const bin = mkdtempSync(join(tmpdir(), "a11y-nopath-"));
    const out = mkdtempSync(join(tmpdir(), "a11y-out-"));
    try {
      symlinkSync(BUN, join(bin, "bun"));
      const r = spawnSync(join(bin, "bun"), [SCRIPT, "--url", "http://127.0.0.1:9/", "--out", out], {
        env: { ...process.env, PATH: bin }, encoding: "utf-8", timeout: 60_000,
      });
      expect(r.status).toBe(EXIT.skipped);
      expect(r.stdout).toMatch(/^# Rendered a11y scan: SKIPPED: no browser: agent-browser is not on PATH/);
      expect(r.stdout).not.toMatch(/PASS/);
      const art = JSON.parse(readFileSync(join(out, "a11y-scan.json"), "utf-8"));
      expect([art.status, art.states]).toEqual(["skipped", []]);
    } finally {
      rmSync(bin, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("refuses a non-loopback URL with exit 2", () => {
    const r = spawnSync(BUN, [SCRIPT, "--url", "https://auraco.space/"], { encoding: "utf-8", timeout: 30_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/only loopback/);
  });
});

// The browser is not installed on CI runners; on a box that has agent-browser
// the fixture run is real end to end. (--no-sandbox: some hosts block Chrome's
// user-namespace sandbox; the page is a loopback fixture.)
const agentBrowser = onPath("agent-browser")
  ?? [join(process.env.HOME ?? "", ".npm-global", "bin", "agent-browser")].find((p) => existsSync(p));

describe.skipIf(!agentBrowser)("real browser on a fixture page", () => {
  // The fixture server runs in its own process: the scans below use spawnSync,
  // which blocks this process's event loop, so an in-process server could not answer.
  let server: ChildProcess | undefined;
  let base = "";
  beforeAll(async () => {
    const src = `const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      const name = new URL(req.url).pathname.slice(1);
      if (!/^[a-z]+\\.html$/.test(name)) return new Response("not found", { status: 404 });
      return new Response(Bun.file(${JSON.stringify(FIXTURES)} + "/" + name), { headers: { "content-type": "text/html" } });
    } }); console.log(s.port);`;
    server = spawn(BUN, ["-e", src], { stdio: ["ignore", "pipe", "inherit"] });
    const port = await new Promise<string>((resolve, reject) => {
      server!.stdout!.once("data", (d) => resolve(String(d).trim()));
      server!.once("exit", (c) => reject(new Error(`fixture server exited ${c}`)));
    });
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => { server?.kill("SIGKILL"); });

  function scan(page: string) {
    const out = mkdtempSync(join(tmpdir(), "a11y-real-"));
    const r = spawnSync(BUN, [SCRIPT, "--url", `${base}/${page}`, "--out", out, "--settle-ms", "100", "--browser-args=--no-sandbox"], {
      env: { ...process.env, PATH: `${dirname(agentBrowser!)}${delimiter}${process.env.PATH ?? ""}` }, encoding: "utf-8", timeout: 170_000,
    });
    const art = JSON.parse(readFileSync(join(out, "a11y-scan.json"), "utf-8"));
    rmSync(out, { recursive: true, force: true });
    return { r, art };
  }

  it("planted violations fail with rule id, selector, criterion and state in both themes", () => {
    const { r, art } = scan("planted.html");
    expect(r.status).toBe(EXIT.fail);
    expect(art.tool.version).toBe(pinnedAxeVersion(readFileSync(join(here, "..", "package.json"), "utf-8")));
    const rows = art.violations.map((v: { ruleId: string; selector: string; criteria: string[]; state: StateRef }) => `${v.ruleId}|${v.selector}|${v.criteria.join(",")}|${v.state.theme}`);
    expect(rows).toContain("button-name|#close|4.1.2|light");
    expect(rows).toContain("button-name|#close|4.1.2|dark");
    expect(rows).toContain("color-contrast|#low|1.4.3|dark");
    expect(rows).not.toContain("color-contrast|#low|1.4.3|light");
  }, 180_000);

  it("a blank page is skipped, not passed", () => {
    const { r, art } = scan("blank.html");
    expect(r.status).toBe(EXIT.skipped);
    expect(art.reason).toMatch(/^blank page/);
  }, 180_000);
});
