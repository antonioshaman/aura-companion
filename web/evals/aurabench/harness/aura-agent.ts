/**
 * Aura variant runner (C–G, P6/D2): drives a session on the ISOLATED bench
 * Companion instance (see `bench-instance.ts`, port 3499 — never prod :3456)
 * through its public REST + browser-WS API, exactly like the UI would:
 *
 *   1. `POST /api/sessions/create` with `cwd` = the cell worktree, the
 *      variant's per-session `layers` (C3), `permissionMode:
 *      bypassPermissions`, and for Council variants `councilMode: "council"`;
 *   2. open `/ws/browser/<id>` for every session of the cell;
 *   3. wait until the primary is connected, send the task prompt as a
 *      `user_message`;
 *   4. feed every message into {@link AuraSessionTracker} until done /
 *      limit / the cell wall clock; auto-allow any permission request (the
 *      bench is unattended — same as bypassPermissions);
 *   5. kill + delete the sessions (the worktree is removed by `runCell`).
 *
 * HTTP and sockets are injected; unit-tested with fakes. Firewall-clean.
 */

import type { AgentContext, AgentRun, AgentRunner } from "./run-cell.js";
import { AuraSessionTracker } from "./aura-session-tracker.js";
import type { AuraVariant } from "./variants.js";

export interface BenchSocket {
  send(data: string): void;
  close(): void;
}

export interface AuraDeps {
  /** e.g. `http://127.0.0.1:3499`. */
  baseUrl: string;
  http: (method: "GET" | "POST" | "DELETE", path: string, body?: unknown) => Promise<{ status: number; json: unknown }>;
  openSocket: (url: string, onMessage: (data: string) => void, onClose: () => void) => Promise<BenchSocket>;
  /** Facts about the instance, stored as the cell's isolation evidence. */
  instanceFacts: () => Record<string, unknown>;
  /** Pinned models (same as the naked variants of the provider). Without a
   *  model Companion falls back to ITS default, not the CLI's. */
  models?: { claude?: string; codex?: string };
  /** Absolute CLI paths. Required in practice: the bench instance runs with
   *  its own HOME, so its login-shell PATH misses `~/.local/bin` and would
   *  resolve an older system-wide `claude`. */
  binaries?: { claude?: string; codex?: string };
  /** Confounds that depend on the worktree (e.g. no KB at the base commit). */
  confounds: (ctx: AgentContext) => string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** Max wait for the primary to reach `connected` before sending the prompt. */
  connectTimeoutMs?: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Quiet window before a cell counts as finished (see tracker). */
export function quietWindowMs(v: AuraVariant): number {
  if (v.autoProceedOnIdle) return v.autoProceedOnIdle.idleMs + 120_000;
  return v.councilPairing ? 180_000 : 60_000;
}

export function createBody(
  v: AuraVariant,
  cwd: string,
  model?: string,
  binaries: { claude?: string; codex?: string } = {},
): Obj {
  const body: Obj = {
    cwd,
    ...(model ? { model } : {}),
    // Council pairs are claude+claude, so only the provider's own binary matters.
    ...(binaries.claude && v.provider === "claude" ? { claudeBinary: binaries.claude } : {}),
    ...(binaries.codex && v.provider === "codex" ? { codexBinary: binaries.codex } : {}),
    backend: v.provider,
    permissionMode: "bypassPermissions",
    layers: v.layers,
  };
  if (v.councilPairing) {
    body.councilMode = "council";
    body.councilPairing = v.councilPairing;
  }
  if (v.autoProceedOnIdle && v.layers.autoProceed === "on") body.autoProceedOnIdle = v.autoProceedOnIdle;
  return body;
}

/** Session ids from the create response (solo → one; council → primary first). */
export function sessionIdsFromCreate(json: unknown): { primary: string; others: string[] } | null {
  if (!isObj(json)) return null;
  if (isObj(json.primary) && isObj(json.observer)) {
    const p = json.primary.sessionId;
    const o = json.observer.sessionId;
    return typeof p === "string" && typeof o === "string" ? { primary: p, others: [o] } : null;
  }
  return typeof json.sessionId === "string" ? { primary: json.sessionId, others: [] } : null;
}

export function auraRunner(d: AuraDeps): AgentRunner {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = d.pollMs ?? 2_000;
  return async (ctx: AgentContext): Promise<AgentRun> => {
    const v = ctx.variant;
    if (v.mode !== "aura") throw new Error(`auraRunner got a ${v.mode} variant`);
    const started = now();
    const isolation = { ...d.instanceFacts(), layers: v.layers, council: v.councilPairing ?? null, binaries: d.binaries ?? null };
    const confounds = d.confounds(ctx);
    const created = await d.http("POST", "/api/sessions/create", createBody(v, ctx.worktree, d.models?.[v.provider], d.binaries));
    const ids = created.status === 200 ? sessionIdsFromCreate(created.json) : null;
    if (!ids) {
      return {
        kind: "done",
        status: "agent_error",
        metrics: new AuraSessionTracker("x", [], 0).metrics(),
        isolation,
        confounds,
        error: `session create failed (${created.status}): ${JSON.stringify(created.json).slice(0, 300)}`,
      };
    }
    const all = [ids.primary, ...ids.others];
    const tracker = new AuraSessionTracker(ids.primary, ids.others, quietWindowMs(v));
    const sockets = new Map<string, BenchSocket>();
    const wsBase = d.baseUrl.replace(/^http/, "ws");
    try {
      for (const id of all) {
        const sock = await d.openSocket(
          `${wsBase}/ws/browser/${id}`,
          (data) => {
            let msg: unknown;
            try {
              msg = JSON.parse(data);
            } catch {
              return;
            }
            tracker.onMessage(id, msg, now());
            if (isObj(msg) && msg.type === "permission_request" && isObj(msg.request)) {
              const requestId = msg.request.request_id;
              if (typeof requestId === "string") {
                sockets.get(id)?.send(JSON.stringify({ type: "permission_response", request_id: requestId, behavior: "allow" }));
              }
            }
          },
          () => {},
        );
        sockets.set(id, sock);
      }
      // Wait for the primary CLI to be up before prompting.
      const connectDeadline = now() + (d.connectTimeoutMs ?? 5 * 60_000);
      for (;;) {
        const s = await d.http("GET", `/api/sessions/${ids.primary}`);
        const state = isObj(s.json) ? s.json.state : undefined;
        if (state === "connected") break;
        if (state === "exited" || now() > connectDeadline) {
          return {
            kind: "done",
            status: "agent_error",
            metrics: tracker.metrics(),
            isolation,
            confounds,
            error: `primary session never connected (state=${String(state)})`,
          };
        }
        await sleep(pollMs);
      }
      // Let the Companion init probe settle before the real prompt.
      await sleep(3_000);
      // Mark first: a reply may arrive before `send` returns.
      tracker.promptSent(now());
      sockets.get(ids.primary)!.send(
        JSON.stringify({ type: "user_message", content: ctx.task.prompt, client_msg_id: `aurabench-${started}` }),
      );
      const deadline = started + ctx.timeoutMs;
      for (;;) {
        if (tracker.limit) return { kind: "limit", limit: tracker.limit };
        if (tracker.isDone(now())) break;
        if (now() > deadline) {
          return { kind: "done", status: "timeout", metrics: tracker.metrics(), isolation, confounds };
        }
        await sleep(pollMs);
      }
      const err = tracker.primaryError;
      return err
        ? { kind: "done", status: "agent_error", metrics: tracker.metrics(), isolation, confounds, error: err.slice(0, 500) }
        : { kind: "done", status: "completed", metrics: tracker.metrics(), isolation, confounds };
    } finally {
      for (const s of sockets.values()) s.close();
      for (const id of all) await d.http("POST", `/api/sessions/${id}/kill`).catch(() => undefined);
      for (const id of all) await d.http("DELETE", `/api/sessions/${id}`).catch(() => undefined);
    }
  };
}
