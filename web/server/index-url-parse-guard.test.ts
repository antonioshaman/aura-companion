import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// EC-19 / feedback_static_grep_canary_regex_over_substring: `new URL(req.url)`
// throws `TypeError [ERR_INVALID_URL]` on inputs like `/nice ports,/Trinity.txt.bak`
// (Bun.serve's async fetch handler is a hot path for port scanners on any
// public listener). Left uncaught, the throw leaves the underlying socket in
// CLOSE_WAIT — accumulated over a multi-day process uptime this compounds
// with cgroup memory pressure into the wedge documented in
// feedback_cgroup_memoryhigh_throttle_ui_hang.md.
//
// index.ts is on the coverage-gate exclude list (bootstrap module — not
// unit-testable directly), so we canary the guard at the source level: the
// parse MUST live inside a `try { … } catch { … }` block. Function-anchored
// regex over `\w+` placeholders survives variable renames.

const indexSrc = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "index.ts"), "utf8");
})();

describe("index.ts — request URL parse guard", () => {
  it("wraps `new URL(req.url)` in a try block", () => {
    // Anchor: `try { … new URL(req.url) … }`. Any leading declaration
    // (`let url: URL;` / `let \w+`) is allowed but the parse call MUST
    // sit inside the try body.
    const pattern = /try\s*\{[^}]*new URL\(req\.url\)[^}]*\}/s;
    expect(indexSrc).toMatch(pattern);
  });

  it("returns a 400 Response from the matching catch block", () => {
    // Anchor: `catch { … new Response(…, { status: 400 }) … }` following
    // the try. Bad Request is the correct HTTP semantics for a malformed
    // request-line; the exact body text is not asserted (copy edits ok).
    const pattern = /catch\s*(?:\(\s*\w*\s*\))?\s*\{[^}]*new Response\([^)]*status:\s*400[^)]*\)[^}]*\}/s;
    expect(indexSrc).toMatch(pattern);
  });
});
