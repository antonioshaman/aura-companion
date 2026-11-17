/**
 * `aura-companion token` — print the Aura access token and ready-to-open links
 * (council review 2026-11-15, friedman P2-1). Before this, a remote user's
 * first screen (the token login) pointed at places that did not have the
 * token: the server console prints only the file path, the QR code sits
 * behind the login, and `aura-companion generate-token` was not a command.
 *
 * The token lives in the home of the user Aura runs as, so this must run as
 * that user (on a server: over SSH, as the service user).
 */

export interface TokenAddress {
  label: string;
  ip: string;
}

export interface TokenOutputInput {
  token: string;
  port: number;
  addresses: readonly TokenAddress[];
  /** COMPANION_ALLOWED_ORIGIN of this shell (the service may differ); "" when unset. */
  allowedOrigins: string;
  regenerated: boolean;
  authFile: string;
}

export function formatTokenOutput(i: TokenOutputInput): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  ${i.regenerated ? "New" : "Current"} Aura access token: ${i.token}`);
  lines.push(`  Stored at: ${i.authFile}`);
  lines.push("");
  lines.push("  Open Aura with one of these links (the link signs that browser in):");
  const width = Math.max(...i.addresses.map((a) => a.label.length));
  for (const a of i.addresses) {
    lines.push(`    ${a.label.padEnd(width)}  http://${a.ip}:${i.port}/?token=${i.token}`);
  }
  const remote = i.addresses.filter((a) => a.ip !== "localhost");
  if (remote.length > 0) {
    const allowed = new Set(i.allowedOrigins.split(",").map((s) => s.trim()).filter(Boolean));
    const missing = remote.map((a) => `http://${a.ip}:${i.port}`).filter((o) => !allowed.has(o));
    if (missing.length > 0) {
      lines.push("");
      lines.push("  From another machine, the address must be allowed, or chats fail with \"Connection timeout\":");
      lines.push(`    COMPANION_ALLOWED_ORIGIN=${[...allowed, ...missing].join(",")}`);
      lines.push("  Set it for the server (service: systemctl --user edit aura-companion) and restart.");
    }
  }
  lines.push("");
  lines.push("  Keep the token secret: it opens Aura. `aura-companion token --regenerate` replaces it");
  lines.push("  (every browser signed in with the old one must open a new link).");
  lines.push("");
  return lines.join("\n");
}

/** `--regenerate` and `--port <n>` only. */
export function validTokenArgs(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--regenerate") continue;
    if (argv[i] === "--port" && /^\d+$/.test(argv[i + 1] ?? "")) {
      i++;
      continue;
    }
    return false;
  }
  return true;
}

export async function runTokenCommand(argv: readonly string[]): Promise<number> {
  if (!validTokenArgs(argv)) {
    console.error("Usage: aura-companion token [--regenerate] [--port <n>]");
    return 1;
  }
  const { getToken, regenerateToken, getAllAddresses } = await import("../server/auth-manager.js");
  const { cliPort } = await import("./cli-auth.js");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const regenerated = argv.includes("--regenerate");
  const token = regenerated ? regenerateToken() : getToken();
  console.log(formatTokenOutput({
    token,
    port: cliPort(argv),
    addresses: getAllAddresses(),
    allowedOrigins: process.env.COMPANION_ALLOWED_ORIGIN ?? "",
    regenerated,
    authFile: join(homedir(), ".companion", "auth.json"), // auth-manager's DEFAULT_AUTH_FILE
  }));
  return 0;
}
