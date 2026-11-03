import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PortableHistoryStore } from "../portable-history-store.js";
import { createPortableArchive, MAX_ARCHIVE_BYTES } from "../portable-history.js";
import { registerPortableHistoryRoutes, type PortableHistoryRoutesDeps } from "./portable-history-routes.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "portable-routes-")); roots.push(root);
  const store = new PortableHistoryStore(join(root, "archives"));
  const createSession = vi.fn().mockResolvedValue({ ok: true, session: { sessionId: "fresh" } });
  const setPickupDraft = vi.fn();
  const deps: PortableHistoryRoutesDeps = {
    archiveStore: store,
    launcher: { listSessions: () => [] },
    bridge: { getSession: () => undefined, setPickupDraft },
    orchestrator: { createSession },
  };
  const app = new Hono(); registerPortableHistoryRoutes(app, deps);
  const archive = createPortableArchive([{ id: "old", project: "demo", backend: "claude", messageHistory: [{ type: "user_message", content: "Continue the task" }] }]);
  return { root, store, app, archive, createSession, setPickupDraft, deps };
}
const post = (app: Hono, path: string, value: unknown) => app.request(path, { method: "POST", body: JSON.stringify(value), headers: { "Content-Type": "application/json" } });

describe("portable history REST", () => {
  // AC4/6/7/10: the same evidence survives storage and is exposed through distinct full/draft endpoints.
  it("imports, deduplicates, lists, reads and downloads a full history without spawning", async () => {
    const f = fixture();
    const response = await post(f.app, "/portable-history/import", f.archive);
    expect(response.status).toBe(200);
    const { id } = await response.json();
    expect(await (await post(f.app, "/portable-history/import", f.archive)).json()).toEqual({ id, duplicate: true });
    const list = await (await f.app.request("/portable-history")).json();
    expect(list.archives).toHaveLength(1); expect(list.sources).toEqual([]); expect(list.limits.maxArchiveBytes).toBe(MAX_ARCHIVE_BYTES);
    expect(await (await f.app.request(`/portable-history/${id}`)).json()).toEqual(f.archive);
    const draft = await (await f.app.request(`/portable-history/${id}/context?sessionId=old`)).json();
    expect(draft.text).toContain("untrusted historical evidence");
    const markdown = await f.app.request(`/portable-history/${id}/markdown`);
    expect(markdown.headers.get("Content-Disposition")).toContain("attachment");
    expect(markdown.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(markdown.headers.get("Cache-Control")).toBe("no-store");
    expect(await markdown.text()).toContain("Continue the task");
    expect(f.createSession).not.toHaveBeenCalled();
  });
  // AC8/9: spawn configuration is rebuilt, never copied from historical state, with explicit user-selected backend.
  it.each(["claude", "codex"])("creates a fresh %s draft with conservative settings", async backend => {
    const f = fixture(); const { id } = f.store.import(f.archive);
    const response = await post(f.app, `/portable-history/${id}/continue`, { sessionId: "old", backend, cwd: f.root });
    expect(response.status).toBe(200);
    expect(f.createSession).toHaveBeenCalledWith({ cwd: f.root, backend, permissionMode: "default", isolation: "auto" });
    const result = await response.json();
    expect(result.newSessionId).toBe("fresh"); expect(f.setPickupDraft).toHaveBeenCalledWith("fresh", result.draft, backend);
    expect(f.store.get(id)).toEqual(f.archive);
  });
  // AC5/9: rejected imports, invalid workspace/backend and failed preflight leave archive data untouched.
  it("rejects invalid inputs and preserves archived evidence on provider failure", async () => {
    const f = fixture(); const { id } = f.store.import(f.archive);
    expect((await post(f.app, "/portable-history/import", { ...f.archive, version: 999 })).status).toBe(400);
    expect((await f.app.request("/portable-history/not-a-hash")).status).toBe(400);
    expect((await f.app.request(`/portable-history/${"a".repeat(64)}`)).status).toBe(404);
    expect((await post(f.app, `/portable-history/${id}/continue`, { sessionId: "old", backend: "gpu", cwd: f.root })).status).toBe(400);
    expect((await post(f.app, `/portable-history/${id}/continue`, { sessionId: "old", backend: "codex", cwd: join(f.root, "missing") })).status).toBe(400);
    expect(f.createSession).not.toHaveBeenCalled();
    f.createSession.mockResolvedValueOnce({ ok: false, error: "Codex unavailable", status: 503 });
    expect((await post(f.app, `/portable-history/${id}/continue`, { sessionId: "old", backend: "codex", cwd: f.root })).status).toBe(503);
    expect(f.setPickupDraft).not.toHaveBeenCalled(); expect(f.store.list()).toHaveLength(1);
  });
  // AC5: count actual bytes even when a forged Content-Length claims this is tiny.
  it("rejects oversized streamed bodies and malformed JSON", async () => {
    const f = fixture();
    const tooLarge = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_ARCHIVE_BYTES)); controller.enqueue(new Uint8Array([1])); controller.close(); } });
    const request = new Request("http://example.test/portable-history/import", { method: "POST", headers: { "Content-Length": "1" }, body: tooLarge, duplex: "half" } as RequestInit);
    expect((await f.app.request(request)).status).toBe(413);
    expect((await f.app.request("/portable-history/import", { method: "POST", body: "{" })).status).toBe(400);
    expect(f.store.list()).toEqual([]);
  });
  // AC1: root and cleanup rows are readable without launcher state; the root row wins duplicates.
  it("exports archived histories and reports skipped evidence without live sessions", async () => {
    const f = fixture();
    f.deps.sessionStore = { loadForPortableExport: () => ({ skipped: 2, sessions: [
      { id: "saved", state: { cwd: f.root, backend_type: "claude", claude_code_version: "2.test" }, messageHistory: [{ type: "user_message", content: "root" }] },
      { id: "saved", state: { cwd: f.root, backend_type: "claude" }, messageHistory: [{ type: "user_message", content: "stale" }] },
      { id: "archived", state: { cwd: f.root, backend_type: "codex", claude_code_version: "never-copy" }, messageHistory: [{ type: "user_message", content: "archived" }] },
    ] as never }) };
    const list = await (await f.app.request("/portable-history")).json();
    expect(list.skipped).toBe(2); expect(list.sources).toHaveLength(2);
    expect(list.sources[0].cliVersion).toBe("2.test"); expect(list.sources[1]).not.toHaveProperty("cliVersion");
    const archive = await (await post(f.app, "/portable-history/export", {})).json();
    expect(archive.sessions[0].messages[0].content).toBe("root");
    expect(archive.sessions[1].messages[0].content).toBe("archived");
    expect(archive.exclusions.join(" ")).toContain("2 unavailable");
  });
  // AC1/3: source export prefers live text over disk and metadata never exposes runtime fields.
  it("exports current live history without persisting it", async () => {
    const f = fixture();
    f.deps.sessionStore = { loadForPortableExport: () => ({ skipped: 0, sessions: [{ id: "live", state: { cwd: f.root, backend_type: "codex" }, messageHistory: [{ type: "user_message", content: "stale disk text" }] }] as never }) };
    f.deps.launcher.listSessions = () => [{ sessionId: "live", backendType: "codex" }] as never;
    f.deps.bridge.getSession = () => ({ state: { cwd: f.root, model: "test", permissionMode: "bypassPermissions" }, backendType: "codex", messageHistory: [{ type: "user_message", content: "live text" }] }) as never;
    expect((await post(f.app, "/portable-history/export", { sessionIds: ["missing"] })).status).toBe(404);
    const archive = await (await post(f.app, "/portable-history/export", { sessionIds: ["live"] })).json();
    expect(archive.sessions[0]).toMatchObject({ id: "live", backend: "codex", messages: [{ content: "live text" }] });
    expect(JSON.stringify(archive)).not.toContain("bypassPermissions"); expect(f.store.list()).toEqual([]);
  });
});
