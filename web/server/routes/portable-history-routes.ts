import type { Context, Hono } from "hono";
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { COMPANION_HOME } from "../paths.js";
import type { SessionStore } from "../session-store.js";
import type { CliLauncher } from "../cli-launcher.js";
import type { WsBridge } from "../ws-bridge.js";
import type { SessionOrchestrator } from "../session-orchestrator.js";
import { PortableHistoryStore } from "../portable-history-store.js";
import { archiveMarkdown, continuationDraft, createPortableArchive, MAX_ARCHIVE_BYTES, MAX_DEPTH, MAX_DRAFT_BYTES, MAX_MESSAGES, MAX_SESSIONS, MAX_STRING_BYTES, PortableHistoryError, type PortableSource } from "../portable-history.js";
import { redactStructured } from "../secret-redaction.js";

export interface PortableHistoryRoutesDeps {
  sessionStore?: Pick<SessionStore, "loadForPortableExport">;
  launcher: Pick<CliLauncher, "listSessions">;
  bridge: Pick<WsBridge, "getSession" | "setPickupDraft">;
  orchestrator: Pick<SessionOrchestrator, "createSession">;
  archiveStore?: PortableHistoryStore;
}
const limits = { maxArchiveBytes: MAX_ARCHIVE_BYTES, maxSessions: MAX_SESSIONS, maxMessages: MAX_MESSAGES, maxDepth: MAX_DEPTH, maxStringBytes: MAX_STRING_BYTES, maxDraftBytes: MAX_DRAFT_BYTES };

/** Counts actual streamed bytes, independent of missing or forged Content-Length. */
async function body(c: Context): Promise<unknown> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new PortableHistoryError("invalid", "A JSON request body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_ARCHIVE_BYTES) {
        await reader.cancel();
        throw new PortableHistoryError("limit", "Archive exceeds the published 32 MiB limit.");
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new PortableHistoryError("invalid", "Request must contain valid JSON."); }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PortableHistoryError("invalid", "Invalid request fields.");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new PortableHistoryError("invalid", "Unsupported request fields.");
}
function failure(c: Context, error: unknown): Response {
  if (error instanceof PortableHistoryError) return c.json({ error: error.message }, error.code === "limit" ? 413 : error.code === "not_found" ? 404 : 400);
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return c.json({ error: "Archive was not found." }, 404);
  return c.json({ error: "Portable history operation failed. Please retry." }, 500);
}

/** Register only beneath the installation's existing auth middleware. */
export function registerPortableHistoryRoutes(api: Hono, deps: PortableHistoryRoutesDeps): void {
  let archiveStore = deps.archiveStore;
  const store = () => archiveStore ??= new PortableHistoryStore(join(COMPANION_HOME, "portable-history"));
  function inventory(): { sources: PortableSource[]; skipped: number } {
    const loaded = deps.sessionStore?.loadForPortableExport(MAX_ARCHIVE_BYTES) ?? { sessions: [], skipped: 0 };
    const sources = new Map<string, PortableSource>();
    const add = (id: string, state: { cwd?: string; backend_type?: string; model?: string; claude_code_version?: string }, history: unknown[], backend?: string) => {
      const selectedBackend = backend ?? state.backend_type ?? "claude";
      if (selectedBackend !== "claude" && selectedBackend !== "codex") { loaded.skipped++; return; }
      const cwd = typeof state.cwd === "string" ? state.cwd : undefined;
      sources.set(id, { id, project: cwd ? basename(cwd) || cwd : "Unknown project", backend: selectedBackend, ...(cwd ? { cwd } : {}), ...(typeof state.model === "string" ? { model: state.model } : {}), ...(selectedBackend === "claude" && state.claude_code_version ? { cliVersion: state.claude_code_version } : {}), messageHistory: history });
    };
    // Root rows win over cleanup archives; live bridge history wins over both.
    for (const row of loaded.sessions) if (!sources.has(row.id)) add(row.id, row.state, row.messageHistory);
    for (const row of deps.launcher.listSessions()) {
      const live = deps.bridge.getSession(row.sessionId);
      if (live) add(row.sessionId, live.state, live.messageHistory, live.backendType ?? row.backendType);
    }
    return { sources: [...sources.values()], skipped: loaded.skipped };
  }
  api.use("/portable-history", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  api.use("/portable-history/*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  api.get("/portable-history", c => {
    try {
      const { sources, skipped } = inventory();
      return c.json({ sources: sources.map(({ messageHistory: _history, ...metadata }) => redactStructured(metadata)), archives: store().list(), limits, skipped });
    } catch (error) { return failure(c, error); }
  });
  api.post("/portable-history/export", async c => {
    try {
      const request = record(await body(c)); fields(request, ["sessionIds"]);
      if (request.sessionIds !== undefined && (!Array.isArray(request.sessionIds) || request.sessionIds.length > MAX_SESSIONS || request.sessionIds.some(id => typeof id !== "string"))) throw new PortableHistoryError("invalid", "Select up to 200 session identifiers.");
      const { sources, skipped } = inventory();
      const wanted = request.sessionIds as string[] | undefined;
      if (wanted?.some(id => !sources.some(source => source.id === id))) throw new PortableHistoryError("not_found", "A selected history is no longer available.");
      return c.json(createPortableArchive(wanted ? sources.filter(source => wanted.includes(source.id)) : sources, skipped ? [`${skipped} unavailable or unsafe stored histories were skipped.`] : []));
    } catch (error) { return failure(c, error); }
  });
  api.post("/portable-history/import", async c => {
    try { return c.json(store().import(await body(c))); } catch (error) { return failure(c, error); }
  });
  api.get("/portable-history/:id", c => {
    try { return c.json(store().get(c.req.param("id"))); } catch (error) { return failure(c, error); }
  });
  api.get("/portable-history/:id/context", c => {
    try {
      const sessionId = c.req.query("sessionId");
      if (sessionId === undefined) throw new PortableHistoryError("invalid", "Select a history session.");
      return c.json(continuationDraft(store().get(c.req.param("id")), sessionId));
    } catch (error) { return failure(c, error); }
  });
  api.get("/portable-history/:id/markdown", c => {
    try {
      const markdown = archiveMarkdown(store().get(c.req.param("id")), c.req.query("sessionId"));
      c.header("Content-Disposition", 'attachment; filename="aura-project-history.md"');
      c.header("X-Content-Type-Options", "nosniff");
      return c.body(markdown, 200, { "Content-Type": "text/markdown; charset=utf-8" });
    } catch (error) { return failure(c, error); }
  });
  api.post("/portable-history/:id/continue", async c => {
    try {
      const request = record(await body(c)); fields(request, ["sessionId", "backend", "cwd"]);
      if (typeof request.sessionId !== "string" || (request.backend !== "claude" && request.backend !== "codex") || typeof request.cwd !== "string" || !isAbsolute(request.cwd) || request.cwd.includes("\0")) throw new PortableHistoryError("invalid", "Select Claude or Codex and an existing absolute workspace directory.");
      const draft = continuationDraft(store().get(c.req.param("id")), request.sessionId);
      let cwd: string;
      try { cwd = realpathSync(request.cwd); if (!statSync(cwd).isDirectory()) throw new Error(); }
      catch { throw new PortableHistoryError("invalid", "Workspace directory is unavailable."); }
      const result = await deps.orchestrator.createSession({ cwd, backend: request.backend, permissionMode: "default", isolation: "auto" });
      if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 409 | 422 | 500 | 503);
      const newSessionId = result.session.sessionId;
      deps.bridge.setPickupDraft(newSessionId, draft.text, request.backend);
      return c.json({ newSessionId, draft: draft.text });
    } catch (error) { return failure(c, error); }
  });
}
