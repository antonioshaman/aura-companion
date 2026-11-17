import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { authHeaders } from "./ctl.js";

/**
 * The management CLI (`aura-companion settings set …`) used the localhost
 * bypass. Credential-changing settings now require the Aura token (council
 * review 2026-11-15, hunt #4), so the CLI sends the user's own token from
 * ~/.companion/auth.json — read only, never generated here. Synthetic tokens.
 */
describe("ctl authHeaders", () => {
  it("prefers COMPANION_AUTH_TOKEN, then the auth file, else no header", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl-auth-"));
    try {
      const file = join(dir, "auth.json");
      expect(authHeaders({}, file)).toEqual({});
      writeFileSync(file, JSON.stringify({ token: "synth-file-token" }));
      expect(authHeaders({}, file)).toEqual({ Authorization: "Bearer synth-file-token" });
      expect(authHeaders({ COMPANION_AUTH_TOKEN: "synth-env-token" }, file)).toEqual({ Authorization: "Bearer synth-env-token" });
      writeFileSync(file, "not json");
      expect(authHeaders({}, file)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
