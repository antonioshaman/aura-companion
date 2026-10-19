import { verifyToken } from "./middleware/managed-auth.js";
import { isDirectLocalRequest } from "./auth-manager.js";

export interface WsAuthResult {
  ok: boolean;
  status: number;
  body?: string;
}

function getCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1];
}

/**
 * Authenticate browser/terminal WebSocket upgrade requests in managed mode.
 * Accepts token in query param or companion_token cookie (query takes precedence).
 */
export async function authenticateManagedWebSocket(req: Request): Promise<WsAuthResult> {
  const secret = process.env.COMPANION_AUTH_SECRET?.trim();
  if (!secret) {
    return { ok: false, status: 500, body: "Server misconfigured" };
  }

  const url = new URL(req.url);
  const queryToken = url.searchParams.get("token");
  const cookieToken = getCookie(req.headers.get("cookie"), "companion_token");
  const token = queryToken || cookieToken;

  if (!token) {
    return { ok: false, status: 401, body: "Unauthorized" };
  }

  const valid = await verifyToken(token, secret);
  if (!valid) {
    return { ok: false, status: 401, body: "Unauthorized" };
  }

  return { ok: true, status: 200 };
}


/**
 * Gate for the legacy `/ws/cli/:id` upgrade (the `--sdk-url` callback a
 * Claude CLI dials on the WS transport). The socket carries no token, so it
 * must come straight from this machine: loopback source and no reverse-proxy
 * headers. On the default stdio transport no CLI ever dials back, and
 * accepting a socket would swap a live stdio session's control channel for an
 * attacker's — so the endpoint is closed outright.
 */
export function checkCliSocketUpgrade(input: {
  address: string | null | undefined;
  headers: Headers;
  transportMode: "stdio" | "ws";
}): WsAuthResult {
  if (input.transportMode !== "ws") {
    return { ok: false, status: 404, body: "Not Found" };
  }
  if (!isDirectLocalRequest(input.address, input.headers)) {
    return { ok: false, status: 403, body: "Forbidden" };
  }
  return { ok: true, status: 200 };
}
