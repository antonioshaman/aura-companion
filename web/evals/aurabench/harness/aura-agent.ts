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
 *      `user_message` (plus, for `observerLoop` variants, the checkpoint →
 *      review directive with this pair's concrete ids and the bench URL);
 *   4. feed every message into {@link AuraSessionTracker} until done /
 *      limit / the cell wall clock; auto-allow any permission request (the
 *      bench is unattended — same as bypassPermissions);
 *   5. for Council variants, read the pair's `.council/` files from the
 *      worktree into `isolation.layer_evidence` (did a checkpoint, a review,
 *      an auto-proceed fire actually happen) — a layer is reported as
 *      measured only if it left a trace;
 *   6. archive + delete the sessions ({@link teardownSessions}; the worktree
 *      is removed by `runCell`).
 *
 * HTTP and sockets are injected; unit-tested with fakes. Firewall-clean.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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

/** Session ids from the create response (solo → one; council → primary
 *  first, plus the pair's `sessionGroupId` when the server returned one). */
export function sessionIdsFromCreate(json: unknown): { primary: string; others: string[]; groupId?: string } | null {
  if (!isObj(json)) return null;
  if (isObj(json.primary) && isObj(json.observer)) {
    const p = json.primary.sessionId;
    const o = json.observer.sessionId;
    if (typeof p !== "string" || typeof o !== "string") return null;
    return typeof json.sessionGroupId === "string" ? { primary: p, others: [o], groupId: json.sessionGroupId } : { primary: p, others: [o] };
  }
  return typeof json.sessionId === "string" ? { primary: json.sessionId, others: [] } : null;
}

/** Phase name the directive's checkpoints use (distinct from the skills'). */
export const OBSERVER_LOOP_PHASE = "bench-implement";

/**
 * The minimal observer-loop instruction appended to the task prompt of
 * `observerLoop` variants. Concrete ids + the bench instance URL: the
 * `/council-*` skills hardcode the prod port, and the agent has no other way
 * to learn its session / group id. No council skill is named or needed.
 */
export function observerLoopDirective(o: { baseUrl: string; orchestratorId: string; groupId: string }): string {
  return [
    "",
    "---",
    "A code-review observer is paired with you. Use it:",
    `1. After you change code (and before you finish), POST a checkpoint to ${o.baseUrl}/api/sessions/${o.orchestratorId}/council/checkpoint with Content-Type: application/json and this body:`,
    `   {"schema_version":1,"checkpoint_id":"bench-<n>-<8 random hex>","phase":"${OBSERVER_LOOP_PHASE}","sequence":<n>,"session_group_id":"${o.groupId}","emitted_at":"<UTC now, format of \`date -u +%Y-%m-%dT%H:%M:%SZ\`>","artifact_paths":[<workspace-relative paths of the files you changed, at most 50>]}`,
    "   <n> is 1 for the first checkpoint and grows by 1 for each next one. Expect HTTP 200.",
    `2. Wait for the review: poll .council/reviews/ (every ~10 s, up to 5 minutes) until a file whose name contains ${o.groupId} is created or updated after your POST. It lists findings with severities STOP, WARN, NOTE, INFO.`,
    "3. Fix the STOP and WARN findings you confirm in the code (ignore ones you verified to be wrong), then POST one more checkpoint for the fix; you do not need to wait for its review.",
  ].join("\n");
}

export interface LayerEvidence {
  /** The pair's checkpoint files (the spawn checkpoint included). */
  checkpoints: { file: string; phase: string | null; sequence: number | null }[];
  /** Observer review files of the pair. */
  reviews: number;
  /** A directive/skill checkpoint (not the spawn one) exists AND a review of
   *  the pair was written at or after it. */
  observer_loop_ran: boolean;
  /** `iterationCount` of the pair's auto-proceed trace; null = no trace (never fired). */
  auto_proceed_fires: number | null;
}

/**
 * Read what the Council layers left in the worktree's `.council/` for group
 * `groupId`. Tolerant: a missing directory / unreadable file counts as
 * absent, never throws (evidence, not a gate).
 */
export function readLayerEvidence(worktree: string, groupId: string): LayerEvidence {
  const dir = join(worktree, ".council");
  const list = (sub: string): string[] => {
    try {
      return readdirSync(join(dir, sub)).filter((f) => f.includes(groupId));
    } catch {
      return [];
    }
  };
  const mtime = (p: string): number => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return -1;
    }
  };
  const readJson = (p: string): Obj | null => {
    try {
      const v: unknown = JSON.parse(readFileSync(p, "utf8"));
      return isObj(v) ? v : null;
    } catch {
      return null;
    }
  };
  let workCheckpointAt = Infinity;
  const checkpoints = list("checkpoints")
    .filter((f) => f.endsWith(".json"))
    .map((file) => {
      const p = join(dir, "checkpoints", file);
      const j = readJson(p);
      const phase = typeof j?.phase === "string" ? j.phase : null;
      if (phase !== null && phase !== "spawn") workCheckpointAt = Math.min(workCheckpointAt, mtime(p));
      return { file, phase, sequence: typeof j?.sequence === "number" ? j.sequence : null };
    });
  const reviewFiles = list("reviews");
  const reviewedAfter = reviewFiles.some((f) => mtime(join(dir, "reviews", f)) >= workCheckpointAt);
  const traceFile = list("state").find((f) => f.endsWith("-auto-proceed-trace.json"));
  const trace = traceFile ? readJson(join(dir, "state", traceFile)) : null;
  return {
    checkpoints,
    reviews: reviewFiles.length,
    observer_loop_ran: workCheckpointAt !== Infinity && reviewedAfter,
    auto_proceed_fires: typeof trace?.iterationCount === "number" ? trace.iterationCount : null,
  };
}

export function auraRunner(d: AuraDeps): AgentRunner {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = d.pollMs ?? 2_000;
  return async (ctx: AgentContext): Promise<AgentRun> => {
    const v = ctx.variant;
    if (v.mode !== "aura") throw new Error(`auraRunner got a ${v.mode} variant`);
    const started = now();
    const isolation: Record<string, unknown> = { ...d.instanceFacts(), layers: v.layers, council: v.councilPairing ?? null, binaries: d.binaries ?? null };
    const confounds = d.confounds(ctx);
    if (v.observerLoop) {
      confounds.push("observer loop is driven by a bench directive appended to the prompt (prod relies on the /council-* skills to checkpoint)");
    }
    if (v.autoProceedOnIdle && v.layers.autoProceed === "on") {
      confounds.push("an unresolved observer STOP holds auto-proceed until a human releases it; the bench never releases");
    }
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
    if (v.councilPairing && !ids.groupId) {
      // Without the group id neither the directive nor the evidence works:
      // the cell would silently measure C under D's name.
      isolation.teardown = await teardownSessions(d, [ids.primary, ...ids.others]);
      return {
        kind: "done",
        status: "agent_error",
        metrics: new AuraSessionTracker("x", [], 0).metrics(),
        isolation,
        confounds,
        error: "council create response carried no sessionGroupId",
      };
    }
    const groupId = ids.groupId;
    const prompt =
      v.observerLoop && groupId
        ? ctx.task.prompt + observerLoopDirective({ baseUrl: d.baseUrl, orchestratorId: ids.primary, groupId })
        : ctx.task.prompt;
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
        JSON.stringify({ type: "user_message", content: prompt, client_msg_id: `aurabench-${started}` }),
      );
      // Snapshot the evidence into `isolation` whenever the cell ends below.
      const withEvidence = () => {
        if (groupId) isolation.layer_evidence = readLayerEvidence(ctx.worktree, groupId);
      };
      const deadline = started + ctx.timeoutMs;
      for (;;) {
        if (tracker.limit) return { kind: "limit", limit: tracker.limit };
        if (tracker.isDone(now())) break;
        if (now() > deadline) {
          withEvidence();
          return { kind: "done", status: "timeout", metrics: tracker.metrics(), isolation, confounds };
        }
        await sleep(pollMs);
      }
      withEvidence();
      const err = tracker.primaryError;
      return err
        ? { kind: "done", status: "agent_error", metrics: tracker.metrics(), isolation, confounds, error: err.slice(0, 500) }
        : { kind: "done", status: "completed", metrics: tracker.metrics(), isolation, confounds };
    } finally {
      for (const s of sockets.values()) s.close();
      isolation.teardown = await teardownSessions(d, all);
    }
  };
}

/**
 * Stop the cell's sessions without a keepalive relaunch into the checkout
 * that `runCell` deletes next (FIX-D2-3). `POST /kill` is NOT an intentional
 * kill server-side: the exit schedules a keepalive relaunch 3 s later, and a
 * council pair's two kills + deletes could outlast it (pilot 1 logged a
 * relaunch per killed session). Archive marks the id — for a council pair
 * BOTH ids, before either kill (EC-2) — intentional and cancels keepalive
 * timers; delete then forgets the session. The list is re-read afterwards:
 * `still_present` must be empty (null = the list could not be read).
 */
export async function teardownSessions(
  d: Pick<AuraDeps, "http">,
  ids: readonly string[],
): Promise<{ archived: string[]; deleted: string[]; still_present: string[] | null }> {
  const archived: string[] = [];
  const deleted: string[] = [];
  for (const id of ids) {
    const r = await d.http("POST", `/api/sessions/${id}/archive`, {}).catch(() => null);
    if (r?.status === 200) archived.push(id);
  }
  for (const id of ids) {
    const r = await d.http("DELETE", `/api/sessions/${id}`).catch(() => null);
    if (r?.status === 200) deleted.push(id);
  }
  const list = await d.http("GET", "/api/sessions").catch(() => null);
  const still_present = Array.isArray(list?.json)
    ? list.json.flatMap((s) => (isObj(s) && typeof s.sessionId === "string" && ids.includes(s.sessionId) ? [s.sessionId] : []))
    : null;
  return { archived, deleted, still_present };
}
