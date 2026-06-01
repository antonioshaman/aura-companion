// Tests for the auto-stack-detection router (Task 8 of v2-router-plan).
//
// Strategy: each test mints an isolated tmp workspace, writes the marker
// files we want, calls detectStack, and asserts the enum kind AND the
// rendered refusal body where relevant. This is the "test bodies, not
// just names" discipline from quality-a11y.md (REC 2) — the rendered
// refusal IS the user-facing artefact AC-3.1/3.2 govern, so the test
// suite verifies its body, not only the discriminated-union tag.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectStack,
  renderRefusal,
  MARKER_NAMES,
  OVERRIDE_VALUES,
  REFUSAL_HEADLINES,
} from "./detect-stack.js";

const workspaces: string[] = [];

function newWorkspace(): string {
  const w = mkdtempSync(join(tmpdir(), "detect-stack-"));
  workspaces.push(w);
  return w;
}

beforeEach(() => {
  workspaces.length = 0;
});

afterEach(() => {
  for (const w of workspaces) {
    try {
      rmSync(w, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

// --- fixture helpers -------------------------------------------------------

function writeAuraPackageNameOnly(root: string) {
  mkdirSync(join(root, "web"), { recursive: true });
  writeFileSync(
    join(root, "web", "package.json"),
    JSON.stringify({ name: "aura-companion" }),
  );
}
function writeAuraPackageHonoOnly(root: string) {
  mkdirSync(join(root, "web"), { recursive: true });
  writeFileSync(
    join(root, "web", "package.json"),
    JSON.stringify({ name: "something-else", dependencies: { hono: "^4.7" } }),
  );
}
function writeAuraWsBridge(root: string) {
  mkdirSync(join(root, "web", "server"), { recursive: true });
  writeFileSync(join(root, "web", "server", "ws-bridge.ts"), "export {};\n");
}
function writePythonPyproject(root: string) {
  writeFileSync(
    join(root, "pyproject.toml"),
    '[project]\nname = "bot"\ndependencies = ["aiogram>=3.7"]\n',
  );
}
function writePythonRequirements(root: string, content = "aiogram==3.7\n") {
  writeFileSync(join(root, "requirements.txt"), content);
  mkdirSync(join(root, "bot"), { recursive: true });
}

// --- AC-1.x — Aura detection ----------------------------------------------

describe("detectStack — Aura detection (AC-1.x)", () => {
  it("AC-1.1: web/package.json with name=aura-companion → aura", () => {
    const w = newWorkspace();
    writeAuraPackageNameOnly(w);
    expect(detectStack(w).kind).toBe("aura");
  });
  it("AC-1.2: web/package.json with dependencies.hono → aura", () => {
    const w = newWorkspace();
    writeAuraPackageHonoOnly(w);
    expect(detectStack(w).kind).toBe("aura");
  });
  it("AC-1.3: web/server/ws-bridge.ts on disk → aura", () => {
    const w = newWorkspace();
    writeAuraWsBridge(w);
    expect(detectStack(w).kind).toBe("aura");
  });
  it("AC-1.4: aura marker + pyproject.toml → ambiguous (never silent aura)", () => {
    const w = newWorkspace();
    writeAuraPackageNameOnly(w);
    writePythonPyproject(w);
    const r = detectStack(w);
    expect(r.kind).toBe("ambiguous");
    const text = renderRefusal(r);
    expect(text).toContain(REFUSAL_HEADLINES.ambiguous);
    // refusal must name both real filenames present at root
    expect(text).toContain("web/package.json");
    expect(text).toContain("pyproject.toml");
  });
});

// --- AC-2.x — Python detection --------------------------------------------

describe("detectStack — Python detection (AC-2.x)", () => {
  it("AC-2.1: pyproject.toml containing 'aiogram' substring → python", () => {
    const w = newWorkspace();
    writePythonPyproject(w);
    expect(detectStack(w).kind).toBe("python");
  });
  it("AC-2.2: bot/ + requirements.txt with ^aiogram line → python", () => {
    const w = newWorkspace();
    writePythonRequirements(w);
    expect(detectStack(w).kind).toBe("python");
  });
  it("AC-2.3: python marker + no aura marker → python without prompt (no refusal)", () => {
    const w = newWorkspace();
    writePythonPyproject(w);
    const r = detectStack(w);
    expect(r.kind).toBe("python");
    expect(renderRefusal(r)).toBe("");
  });
  it("requirements.txt without ^aiogram alone (no bot/) → not python", () => {
    const w = newWorkspace();
    writeFileSync(join(w, "requirements.txt"), "aiogram==3.7\n");
    // missing bot/ — AC-2.2 needs BOTH
    expect(detectStack(w).kind).toBe("unknown");
  });
});

// --- AC-3.x — Refusal -----------------------------------------------------

describe("detectStack — Refusal (AC-3.x)", () => {
  it("AC-3.1: refusal lists every marker checked + filenames found at root", () => {
    const w = newWorkspace();
    writeFileSync(join(w, "README.md"), "");
    const r = detectStack(w);
    expect(r.kind).toBe("unknown");
    const text = renderRefusal(r);
    // (a) names each marker it checked
    expect(text).toContain("Checked for:");
    for (const name of Object.values(MARKER_NAMES)) {
      expect(text, `refusal missing marker name "${name}"`).toContain(name);
    }
    // (b) names what was found at workspace root (or "(no recognised…)" if empty of markers)
    expect(text).toContain("Found at workspace root:");
    // (c) suggests explicit overrides
    expect(text).toContain("To override, run:");
    expect(text).toContain("/council-plan-aura");
    expect(text).toContain("/council-plan ");
  });
  it("AC-3.2: refusal stays scanable (compact structure)", () => {
    const w = newWorkspace();
    const r = detectStack(w);
    const text = renderRefusal(r);
    // 6 markers + structural lines + override footer = ~16 lines. Hard
    // upper bound 18 keeps AC-3.2's 10-second read budget achievable.
    expect(text.split("\n").length).toBeLessThanOrEqual(18);
  });
  it("AC-3.2: refusal has no first-person, no apology, no hedge", () => {
    const w = newWorkspace();
    writeAuraPackageNameOnly(w);
    writePythonPyproject(w);
    const text = renderRefusal(detectStack(w));
    // forbidden conversational tone per UX REC 5
    expect(text).not.toMatch(/\b(I|sorry|unfortunately|I'm)\b/);
  });
  it("AC-3.3: malformed web/package.json → unknown, never silent fallback", () => {
    const w = newWorkspace();
    mkdirSync(join(w, "web"), { recursive: true });
    writeFileSync(join(w, "web", "package.json"), "{not valid json");
    const r = detectStack(w);
    expect(r.kind).toBe("unknown");
    const pkgChecks = r.checked.filter((c) => c.path === "web/package.json");
    expect(pkgChecks.length).toBeGreaterThan(0);
    for (const c of pkgChecks) {
      expect(c.parsed).toBe(false);
      expect(c.reason).toBe("json_parse");
    }
  });
});

// --- Defensive read discipline (Security × FS) ----------------------------

describe("detectStack — defensive read discipline", () => {
  it("rejects symlinked web/package.json instead of following it", () => {
    const w = newWorkspace();
    mkdirSync(join(w, "web"), { recursive: true });
    const outside = newWorkspace();
    writeFileSync(
      join(outside, "evil.json"),
      JSON.stringify({ name: "aura-companion" }),
    );
    try {
      symlinkSync(join(outside, "evil.json"), join(w, "web", "package.json"));
    } catch {
      // symlink unsupported on this filesystem — skip
      return;
    }
    const r = detectStack(w);
    const pkgChecks = r.checked.filter((c) => c.path === "web/package.json");
    for (const c of pkgChecks) {
      expect(c.parsed).toBe(false);
      expect(c.reason).toBe("symlink");
    }
    expect(r.kind).toBe("unknown");
  });
  it("rejects oversize web/package.json (size cap fails closed)", () => {
    const w = newWorkspace();
    mkdirSync(join(w, "web"), { recursive: true });
    writeFileSync(
      join(w, "web", "package.json"),
      "x".repeat(20 * 1024),
    );
    const r = detectStack(w);
    const pkgChecks = r.checked.filter((c) => c.path === "web/package.json");
    expect(pkgChecks.every((c) => c.reason === "size_exceeded")).toBe(true);
    expect(r.kind).toBe("unknown");
  });
  it("CRLF-tolerant: requirements.txt with CRLF endings still matches", () => {
    const w = newWorkspace();
    writePythonRequirements(w, "aiogram==3.7\r\nrequests\r\n");
    expect(detectStack(w).kind).toBe("python");
  });
  it("BOM-tolerant: pyproject.toml prefixed with U+FEFF still matches", () => {
    const w = newWorkspace();
    writeFileSync(
      join(w, "pyproject.toml"),
      "﻿[project]\ndependencies = [\"aiogram\"]\n",
    );
    expect(detectStack(w).kind).toBe("python");
  });
  it("refusal never echoes raw file content (only filename + parse-status)", () => {
    const w = newWorkspace();
    mkdirSync(join(w, "web"), { recursive: true });
    const secret = "SUPER_SECRET_PASTED_TOKEN_DO_NOT_LEAK";
    writeFileSync(
      join(w, "web", "package.json"),
      JSON.stringify({ name: secret }),
    );
    writePythonPyproject(w); // forces ambiguous → refusal path
    const text = renderRefusal(detectStack(w));
    expect(text).not.toContain(secret);
  });
});

// --- .council-stack-override (plan §4) ------------------------------------

describe("detectStack — .council-stack-override precedence", () => {
  it("override value 'aura' forces aura even when no aura markers present", () => {
    const w = newWorkspace();
    writeFileSync(join(w, ".council-stack-override"), "aura\n");
    const r = detectStack(w);
    expect(r.kind).toBe("aura");
    expect(r.overrideUsed).toBe(true);
    expect(r.overridePath).not.toBeNull();
  });
  it("override value 'python' forces python even when no python markers", () => {
    const w = newWorkspace();
    writeFileSync(join(w, ".council-stack-override"), "python\n");
    expect(detectStack(w).kind).toBe("python");
  });
  it("empty override file → loud refusal (never silent default)", () => {
    const w = newWorkspace();
    writeFileSync(join(w, ".council-stack-override"), "");
    writeAuraPackageNameOnly(w); // would otherwise be aura
    const r = detectStack(w);
    expect(r.kind).toBe("unknown");
    expect(r.overrideMalformed).toBe(true);
    const text = renderRefusal(r);
    expect(text).toContain(REFUSAL_HEADLINES.override_malformed);
    expect(text).toContain(".council-stack-override (malformed)");
  });
  it("unknown override value → loud refusal", () => {
    const w = newWorkspace();
    writeFileSync(join(w, ".council-stack-override"), "both\n");
    const r = detectStack(w);
    expect(r.kind).toBe("unknown");
    expect(r.overrideMalformed).toBe(true);
  });
  it("override never silences the marker enumeration in `checked`", () => {
    const w = newWorkspace();
    writeAuraPackageNameOnly(w);
    writePythonPyproject(w);
    writeFileSync(join(w, ".council-stack-override"), "aura\n");
    const r = detectStack(w);
    expect(r.kind).toBe("aura");
    expect(
      r.checked.some((c) =>
        c.matched.includes(MARKER_NAMES.AURA_PACKAGE_NAME),
      ),
    ).toBe(true);
    expect(
      r.checked.some((c) =>
        c.matched.includes(MARKER_NAMES.PYTHON_PYPROJECT_AIOGRAM),
      ),
    ).toBe(true);
  });
});

// --- Refusal renderer headline discipline ---------------------------------

describe("renderRefusal — copy discipline", () => {
  it("all failure-class headlines avoid first-person + apology", () => {
    for (const headline of Object.values(REFUSAL_HEADLINES)) {
      expect(headline).not.toMatch(/\b(I|we|sorry|unfortunately)\b/i);
    }
  });
  it("override allow-list is exactly {aura, python}", () => {
    // Locks the closed allow-list: any addition is a deliberate API change
    // requiring a test update — guards against silent inflation.
    expect([...OVERRIDE_VALUES].sort()).toEqual(["aura", "python"]);
  });
});

// --- Monorepo depth-1 subdir scan (council-stack-autodetect-monorepo spec) ---
// SPECIFICITY INVARIANT lives in detect-stack.ts:SKIP_SUBDIRS comment block —
// these tests lock the runtime invariant: widened SEARCH SCOPE, NOT widened
// marker semantics. Each positive test asserts a literal canonical marker
// (name="aura-companion", hono dep, ^aiogram line, etc.) — directory naming
// alone is NEVER a signal.

describe("detectStack — monorepo depth-1 subdir scan", () => {
  it("webapp/package.json with name=aura-companion → aura (rapesha_academy-style)", () => {
    const w = newWorkspace();
    mkdirSync(join(w, "webapp"), { recursive: true });
    writeFileSync(
      join(w, "webapp", "package.json"),
      JSON.stringify({ name: "aura-companion" }),
    );
    expect(detectStack(w).kind).toBe("aura");
  });
  it("apps/package.json with dependencies.hono → aura", () => {
    const w = newWorkspace();
    mkdirSync(join(w, "apps"), { recursive: true });
    writeFileSync(
      join(w, "apps", "package.json"),
      JSON.stringify({ name: "something-else", dependencies: { hono: "^4.7" } }),
    );
    expect(detectStack(w).kind).toBe("aura");
  });
  it("companion/server/ws-bridge.ts at depth-2 path → aura", () => {
    const w = newWorkspace();
    mkdirSync(join(w, "companion", "server"), { recursive: true });
    writeFileSync(
      join(w, "companion", "server", "ws-bridge.ts"),
      "export {};\n",
    );
    expect(detectStack(w).kind).toBe("aura");
  });
  it("advisor_bot/requirements.txt with ^aiogram → python (no bot/ co-req needed in subdir)", () => {
    // rapesha_academy real layout. In root mode the bot/ co-requirement still
    // applies, but in subdir mode the subdir itself is project-shaped (owns
    // its own requirements.txt) — bot/ is dropped per spec §5 fine print.
    const w = newWorkspace();
    mkdirSync(join(w, "advisor_bot"), { recursive: true });
    writeFileSync(join(w, "advisor_bot", "requirements.txt"), "aiogram==3.7\n");
    expect(detectStack(w).kind).toBe("python");
  });
  it("apps/pyproject.toml containing 'aiogram' → python", () => {
    const w = newWorkspace();
    mkdirSync(join(w, "apps"), { recursive: true });
    writeFileSync(
      join(w, "apps", "pyproject.toml"),
      '[project]\ndependencies = ["aiogram>=3.7"]\n',
    );
    expect(detectStack(w).kind).toBe("python");
  });
  it("SPECIFICITY: bare subdir named 'bot' without aiogram in any requirements.txt → unknown", () => {
    // The directory name `bot/` is NEVER a stack signal on its own.
    const w = newWorkspace();
    mkdirSync(join(w, "bot"), { recursive: true });
    writeFileSync(join(w, "bot", "requirements.txt"), "requests\nflask\n");
    expect(detectStack(w).kind).toBe("unknown");
  });
  it("SPECIFICITY: subdir package.json with name='something-else' and no hono → unknown", () => {
    // The mere presence of a subdir package.json is NEVER a stack signal.
    const w = newWorkspace();
    mkdirSync(join(w, "webapp"), { recursive: true });
    writeFileSync(
      join(w, "webapp", "package.json"),
      JSON.stringify({ name: "marketing-site", dependencies: { react: "^19" } }),
    );
    expect(detectStack(w).kind).toBe("unknown");
  });
  it("monorepo with BOTH Aura and Python signals in sibling subdirs → ambiguous (never silent)", () => {
    const w = newWorkspace();
    mkdirSync(join(w, "webapp"), { recursive: true });
    writeFileSync(
      join(w, "webapp", "package.json"),
      JSON.stringify({ name: "aura-companion" }),
    );
    mkdirSync(join(w, "bot"), { recursive: true });
    writeFileSync(join(w, "bot", "requirements.txt"), "aiogram==3.7\n");
    const r = detectStack(w);
    expect(r.kind).toBe("ambiguous");
    const text = renderRefusal(r);
    expect(text).toContain(REFUSAL_HEADLINES.ambiguous);
    expect(text).toContain("webapp/package.json");
    expect(text).toContain("bot/requirements.txt");
  });
  it("SKIP_SUBDIRS: aura marker inside node_modules is ignored", () => {
    const w = newWorkspace();
    mkdirSync(join(w, "node_modules", "fake-pkg"), { recursive: true });
    writeFileSync(
      join(w, "node_modules", "package.json"),
      JSON.stringify({ name: "aura-companion" }),
    );
    expect(detectStack(w).kind).toBe("unknown");
  });
  it("SKIP_SUBDIRS: aura marker inside dist/ is ignored", () => {
    const w = newWorkspace();
    mkdirSync(join(w, "dist"), { recursive: true });
    writeFileSync(
      join(w, "dist", "package.json"),
      JSON.stringify({ name: "aura-companion" }),
    );
    expect(detectStack(w).kind).toBe("unknown");
  });
  it("SKIP_SUBDIRS: aura marker inside hidden dir (.local) is ignored", () => {
    const w = newWorkspace();
    mkdirSync(join(w, ".local"), { recursive: true });
    writeFileSync(
      join(w, ".local", "package.json"),
      JSON.stringify({ name: "aura-companion" }),
    );
    expect(detectStack(w).kind).toBe("unknown");
  });
  it("root-mode preserves bot/ co-requirement (existing AC-2.2 backward compat)", () => {
    // requirements.txt at root WITHOUT bot/ at root and no subdir
    // requirements.txt → not python. Lock root-mode contract.
    const w = newWorkspace();
    writeFileSync(join(w, "requirements.txt"), "aiogram==3.7\n");
    expect(detectStack(w).kind).toBe("unknown");
  });
});

// --- .council-stack-override CONFLICT (spec §5 AC-conflict) -----------------

describe("detectStack — override-conflict (ask-first)", () => {
  it("override 'aura' + only python markers found → override_conflict", () => {
    const w = newWorkspace();
    writePythonPyproject(w); // python detected
    writeFileSync(join(w, ".council-stack-override"), "aura\n");
    const r = detectStack(w);
    expect(r.kind).toBe("override_conflict");
    expect(r.overrideConflictAsserted).toBe("aura");
    expect(r.overrideConflictAutoDetected).toBe("python");
  });
  it("override 'python' + only aura markers found → override_conflict", () => {
    const w = newWorkspace();
    writeAuraPackageNameOnly(w); // aura detected
    writeFileSync(join(w, ".council-stack-override"), "python\n");
    const r = detectStack(w);
    expect(r.kind).toBe("override_conflict");
    expect(r.overrideConflictAsserted).toBe("python");
    expect(r.overrideConflictAutoDetected).toBe("aura");
  });
  it("override 'aura' + BOTH aura and python markers → aura (not conflict — override resolves ambiguity)", () => {
    // The conflict gate fires only when ONLY the opposing kind is detected.
    // When both kinds are present, override legitimately resolves ambiguity.
    const w = newWorkspace();
    writeAuraPackageNameOnly(w);
    writePythonPyproject(w);
    writeFileSync(join(w, ".council-stack-override"), "aura\n");
    expect(detectStack(w).kind).toBe("aura");
  });
  it("override 'aura' + matching aura markers → aura (no conflict)", () => {
    const w = newWorkspace();
    writeAuraPackageNameOnly(w);
    writeFileSync(join(w, ".council-stack-override"), "aura\n");
    expect(detectStack(w).kind).toBe("aura");
  });
  it("renderRefusal(override_conflict) emits new headline + asserted/detected lines", () => {
    const w = newWorkspace();
    writePythonPyproject(w);
    writeFileSync(join(w, ".council-stack-override"), "aura\n");
    const text = renderRefusal(detectStack(w));
    expect(text).toContain(REFUSAL_HEADLINES.override_conflict);
    expect(text).toContain(".council-stack-override asserts: aura");
    expect(text).toContain("Auto-detected from markers: python");
    expect(text).toContain("To resolve:");
    expect(text).toContain("correct or delete .council-stack-override");
    // First-person discipline preserved.
    expect(text).not.toMatch(/\b(I|sorry|unfortunately|I'm)\b/);
  });
});
