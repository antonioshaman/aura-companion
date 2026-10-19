/**
 * AuraBench prompt-leak check (P5/D1). A task prompt describes the PROBLEM; it
 * must not hand the agent the solution. The deterministic half of the check:
 *
 *   - the PR's "new surface" = code-shaped identifiers (camelCase, PascalCase,
 *     snake_case, UPPER_SNAKE) on added source lines that did not exist
 *     anywhere in the base tree, plus the stems of files the PR created;
 *   - the "required interface" = the part of that surface the hidden tests
 *     reference. An agent cannot pass a test that imports `fooBar` unless the
 *     prompt names `fooBar`, so those names MUST appear in the prompt;
 *   - everything else in the new surface is FORBIDDEN in the prompt — naming
 *     an internal helper, flag or file the fix introduced is a solution hint.
 *
 * Plain English words are never flagged (only code-shaped tokens are), so the
 * semantic half — "does the prose describe the fix?" — stays with the second
 * LLM review pass. Pure: base-tree existence is an injected predicate.
 *
 * Firewall-clean. Never `server/`.
 */

/** camelCase / PascalCase with an inner capital, or anything with `_`. */
const CODE_IDENT_RE = /(?<![\w$])(?:[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*[A-Za-z0-9])(?![\w$])/g;

export function codeIdentifiers(text: string): Set<string> {
  return new Set(text.match(CODE_IDENT_RE) ?? []);
}

/** `web/server/idle-timer.ts` → `idle-timer`. */
export function fileStem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.(test\.)?[cm]?[jt]sx?$/, "");
}

/** Drop comment text: whole `*` / `/*` / `//` lines and trailing `// …`
 *  (a `//` preceded by `:` is a URL, not a comment). A name that only occurs
 *  in a comment or fixture reference is not interface. */
export function stripComments(code: string): string {
  return code
    .split("\n")
    .filter((l) => !/^\s*(?:\/\/|\/\*|\*)/.test(l))
    .map((l) => l.replace(/(?<!:)\/\/.*$/, ""))
    .join("\n");
}

export interface SurfaceInput {
  /** Added lines (`+` side) of the source-file diff base→merge. */
  addedSourceText: string;
  /** Source files that do not exist on base. */
  newSourceFiles: string[];
  /** Full text of the hidden test files at merge. */
  hiddenTestText: string;
  /** True when the identifier already occurs somewhere in the base tree. */
  existsOnBase: (identifier: string) => boolean;
}

export interface InterfaceSurface {
  /** New identifiers/file stems the hidden tests reference — must be named. */
  required: string[];
  /** New identifiers/file stems the tests do NOT reference — must not be named. */
  forbidden: string[];
}

export function computeSurface(input: SurfaceInput): InterfaceSurface {
  const testIdents = codeIdentifiers(stripComments(input.hiddenTestText));
  const required = new Set<string>();
  const forbidden = new Set<string>();
  for (const id of codeIdentifiers(stripComments(input.addedSourceText))) {
    if (input.existsOnBase(id)) continue;
    (testIdents.has(id) ? required : forbidden).add(id);
  }
  for (const file of input.newSourceFiles) {
    const stem = fileStem(file);
    // A new file the tests import is part of the contract (its path must be named).
    const imported = new RegExp(`[/"']${escapeRe(stem)}(?:\\.[cm]?[jt]sx?)?["']`).test(input.hiddenTestText);
    (imported ? required : forbidden).add(stem);
  }
  for (const r of required) forbidden.delete(r);
  return { required: [...required].sort(), forbidden: [...forbidden].sort() };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentions(prompt: string, token: string): boolean {
  return new RegExp(`(?<![\\w$-])${escapeRe(token)}(?![\\w$-])`).test(prompt);
}

export interface LeakReport {
  /** Forbidden new-surface names the prompt mentions (solution hints). */
  leaks: string[];
  /** Required interface names the prompt fails to mention (unpassable task). */
  unnamed: string[];
}

export function checkPrompt(prompt: string, surface: InterfaceSurface): LeakReport {
  return {
    leaks: surface.forbidden.filter((t) => mentions(prompt, t)),
    unnamed: surface.required.filter((t) => !mentions(prompt, t)),
  };
}
