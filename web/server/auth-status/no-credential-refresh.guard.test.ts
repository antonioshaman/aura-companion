/**
 * Static guard (LLM auth phase 1, task 15; spec 🚫 "Обновлять (refresh)
 * учётные данные из процесса диагностики или статуса"; plan risk ritchie A-2).
 *
 * The status / doctor modules (`server/auth-status/*`, tests excluded) and
 * everything they import inside `server/` must not reach a token refresh or a
 * credential write:
 *  1. no module in the import closure mentions a refresh entry point
 *     (`getValidAccessToken`, `refreshAccessToken`, an OAuth `grant_type`, the
 *     `/oauth/token` endpoint) in code (comments ignored);
 *  2. no auth-status module imports a file-writing `node:fs` function;
 *  3. the only `writeAtomicJson` call is inside `defaultWriteAtomic` in
 *     `status-core.ts` (the last-check file), and that module names no
 *     credential file (EC-19: brace-counted body, anchored on the name);
 *  4. no auth-status module imports `usage-limits.ts` (the old refresh/writeback home).
 * Reads the sources; nothing is executed.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = __dirname;
const SERVER = resolve(HERE, "..");

const moduleFiles = readdirSync(HERE)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
  .map((n) => join(HERE, n));

/** Code without comments (keeps `https://…` inside strings). */
function code(path: string): string {
  return readFileSync(path, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function importSpecifiers(src: string): { names: string; from: string }[] {
  const out: { names: string; from: string }[] = [];
  const re = /import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m[1]) continue; // type-only imports carry no runtime code
    out.push({ names: m[2], from: m[3] });
  }
  for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push({ names: "*", from: m[1] });
  return out;
}

function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ""));
  for (const cand of [`${base}.ts`, join(base, "index.ts")]) if (existsSync(cand)) return cand;
  return null;
}

/** Runtime import closure of the auth-status modules within `server/`. */
function closure(): string[] {
  const seen = new Set<string>();
  const stack = [...moduleFiles];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { from } of importSpecifiers(code(file))) {
      const next = resolveLocal(file, from);
      if (next && next.startsWith(SERVER)) stack.push(next);
    }
  }
  return [...seen];
}

const REFRESH = /\bgetValidAccessToken\b|\brefreshAccessToken\b|\bgrant_type\b|\/oauth\/token\b/;
const FS_WRITES = /\b(writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|copyFile|copyFileSync|unlink|unlinkSync|rm|rmSync|chmod|chmodSync|chown|chownSync|truncate|truncateSync|createWriteStream|symlink|symlinkSync|link|linkSync)\b/;

/** EC-19: body of `function <name>(…) {…}` by brace counting. */
function functionBody(src: string, name: string): string | null {
  const m = new RegExp(`\\bfunction\\s+${name}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{`).exec(src);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
  }
  return src.slice(start, i - 1);
}

describe("auth-status never reaches a credential refresh or write", () => {
  it("scans a non-trivial closure (sanity)", () => {
    const files = closure().map((f) => relative(SERVER, f));
    expect(files).toEqual(expect.arrayContaining(["auth-status/status-core.ts", "auth-status/doctor-checks.ts", "atomic-write.ts"]));
  });

  it("no module in the import closure mentions a refresh entry point", () => {
    const offenders = closure().filter((f) => REFRESH.test(code(f))).map((f) => relative(SERVER, f));
    expect(offenders).toEqual([]);
  });

  it("no auth-status module imports a file-writing fs function", () => {
    const offenders: string[] = [];
    for (const file of moduleFiles) {
      for (const { names, from } of importSpecifiers(code(file))) {
        if ((from === "node:fs" || from === "fs" || from === "node:fs/promises" || from === "fs/promises") && (names.includes("*") || FS_WRITES.test(names))) {
          offenders.push(`${relative(SERVER, file)}: ${names.replace(/\s+/g, " ")}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("writeAtomicJson is called only by status-core's defaultWriteAtomic, and that module names no credential file", () => {
    const callers = moduleFiles.filter((f) => /\bwriteAtomicJson\s*\(/.test(code(f))).map((f) => relative(HERE, f));
    expect(callers).toEqual(["status-core.ts"]);
    const src = code(join(HERE, "status-core.ts"));
    const body = functionBody(src, "defaultWriteAtomic");
    expect(body).not.toBeNull();
    expect(body!).toMatch(/\bwriteAtomicJson\s*\(/);
    // One call total in the module, and it is the one inside that body.
    expect(src.match(/\bwriteAtomicJson\s*\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/\.credentials\.json|auth\.json/);
  });

  it("no auth-status module imports usage-limits.ts", () => {
    const offenders = moduleFiles.filter((f) => importSpecifiers(code(f)).some(({ from }) => /(^|\/)usage-limits(\.js)?$/.test(from)));
    expect(offenders.map((f) => relative(SERVER, f))).toEqual([]);
  });
});
