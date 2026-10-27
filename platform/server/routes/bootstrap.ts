import { and, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/index.js";
import { instances as instancesTable } from "../db/schema.js";
import { hashBootstrapToken } from "../lib/bootstrap-token.js";
import { logEvent } from "../lib/log.js";

/**
 * Instance bootstrap exchange — called by a freshly provisioned instance's
 * cloud-init script (see Provisioner.buildHetznerUserData), NOT by users, so
 * it is deliberately outside the session-auth middleware. The one-time
 * bootstrap token in `Authorization: Bearer` is the only credential.
 *
 * POST /api/instance-bootstrap → 200 text/plain env lines with the instance's
 * long-lived secrets; 401 for unknown / expired / already-used tokens.
 *
 * The token is consumed atomically (UPDATE ... WHERE hash = $1 AND not
 * expired, nulling the hash) so a replay — e.g. by anything that can read
 * the instance metadata service later — gets nothing.
 */
const instanceBootstrap = new Hono();

function envLine(key: string, value: string): string {
  return `${key}=${value.replace(/[\r\n]/g, "")}`;
}

instanceBootstrap.post("/", async (c) => {
  const header = c.req.header("authorization") || "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) {
    logEvent("warn", "bootstrap.rejected", { reason: "missing_token" });
    return c.json({ error: "Missing bootstrap token" }, 401);
  }

  const tokenHash = hashBootstrapToken(match[1]);
  const db = getDb();
  const consumed = await db
    .update(instancesTable)
    .set({ bootstrapTokenHash: null, bootstrapTokenExpiresAt: null })
    .where(
      and(
        eq(instancesTable.bootstrapTokenHash, tokenHash),
        gt(instancesTable.bootstrapTokenExpiresAt, new Date()),
      ),
    )
    .returning({ id: instancesTable.id, authSecret: instancesTable.authSecret });

  const row = consumed[0];
  if (!row) {
    logEvent("warn", "bootstrap.rejected", { reason: "unknown_expired_or_used" });
    return c.json({ error: "Invalid or expired bootstrap token" }, 401);
  }

  logEvent("info", "bootstrap.exchanged", { instanceId: row.id });
  const body = [envLine("COMPANION_AUTH_TOKEN", row.authSecret)].join("\n") + "\n";
  return c.text(body, 200, { "Cache-Control": "no-store" });
});

export { instanceBootstrap };
