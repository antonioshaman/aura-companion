import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { COMPANION_HOME } from "./paths.js";

/**
 * A stable, anonymous per-install identifier used solely to deduplicate
 * heartbeats in the global usage counter. It is NOT tied to any user, account,
 * hostname, or path — it is a fresh random token generated once and persisted
 * to disk so the same install counts as one, not N, across restarts.
 *
 * Shape matches the stats Worker's INSTANCE_ID_RE (8–128 chars, [A-Za-z0-9_-]).
 */

const DEFAULT_PATH = join(COMPANION_HOME, "instance-id.json");

interface InstanceIdFile {
  instanceId: string;
  createdAt: number;
}

function generateId(): string {
  // 24 bytes → 32-char base64url token, well within the Worker's bound.
  return randomBytes(24).toString("base64url");
}

/**
 * Read the persisted instance id, generating and writing one on first call.
 * Best-effort: if the file is unreadable/corrupt, a fresh id is minted.
 * If the disk write fails, the in-memory id is still returned (telemetry is
 * non-critical and must never break boot).
 */
export function getOrCreateInstanceId(customPath?: string): string {
  const filePath = customPath || DEFAULT_PATH;
  try {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<InstanceIdFile>;
      if (typeof parsed.instanceId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(parsed.instanceId)) {
        return parsed.instanceId;
      }
    }
  } catch {
    // fall through to regenerate
  }

  const instanceId = generateId();
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ instanceId, createdAt: Date.now() } satisfies InstanceIdFile, null, 2),
      "utf-8",
    );
  } catch {
    // non-fatal — telemetry is opt-in and must not block startup
  }
  return instanceId;
}
