import { useEffect, useRef, useState } from "react";
import { api, type PortableHistoryInventory } from "../api.js";
import { MAX_ARCHIVE_BYTES, type PortableArchive, type ContinuationDraft } from "../../server/portable-history-types.js";
import { useStore } from "../store.js";
import { navigateToSession } from "../utils/routing.js";

const button = "min-h-[44px] px-3 py-2 rounded-lg bg-cc-hover text-cc-fg hover:bg-cc-active disabled:opacity-50 cursor-pointer text-sm";
const input = "w-full min-h-[44px] rounded-lg border border-cc-border bg-cc-bg text-cc-fg px-3 text-sm";
function download(value: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  URL.revokeObjectURL(url);
}

/** Archives are inert evidence; no chat renderer or permission actions are reused. */
export function PortableHistorySettings() {
  const [inventory, setInventory] = useState<PortableHistoryInventory | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [archiveId, setArchiveId] = useState("");
  const [archive, setArchive] = useState<PortableArchive | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [context, setContext] = useState<ContinuationDraft | null>(null);
  const [backend, setBackend] = useState<"claude" | "codex">("codex");
  const [cwd, setCwd] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(0);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setPending(true); setError(""); setStatus("");
    try { await action(); }
    catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : "Operation failed. Please retry."); }
    finally { inFlight.current = false; if (mounted.current) setPending(false); }
  }
  async function load() { const result = await api.listPortableHistory(); if (mounted.current) setInventory(result); }
  async function loadSession(id: string, data: PortableArchive, next: string) {
    const token = ++generation.current;
    const result = next ? await api.getPortableHistoryContext(id, next) : null;
    if (mounted.current && token === generation.current) {
      setArchiveId(id); setArchive(data); setSessionId(next); setContext(result); setPage(0);
    }
  }
  const session = archive?.sessions.find(row => row.id === sessionId);
  const groups = new Map<string, PortableHistoryInventory["sources"]>();
  for (const row of inventory?.sources ?? []) {
    const key = row.cwd ?? row.project;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return <div className="space-y-4 text-sm text-cc-fg">
    <p className="text-cc-muted">Keep available project history independently of your provider account. Transfer reviewed context between Claude and Codex. Local agents are a future feature.</p>
    <p className="text-cc-muted">Known secrets are masked; review arbitrary text and binary attachments manually. Source files and external attachments are not included. Historical commands and permissions are never restored.</p>
    {error && <p role="alert" className="text-cc-error">{error} Use the same action to retry; your history is preserved.</p>}
    <p role="status">{pending ? "Working…" : status}</p>
    <button type="button" className={button} disabled={pending} onClick={() => void run(load)}>{inventory ? "Refresh history" : "Open portable history"}</button>
    {inventory && <>
      <p className="text-cc-muted">Limits: {Math.floor(inventory.limits.maxArchiveBytes / 1024 / 1024)} MiB per archive, {inventory.limits.maxSessions} sessions, {inventory.limits.maxMessages.toLocaleString()} messages, nesting {inventory.limits.maxDepth}, {Math.floor(inventory.limits.maxStringBytes / 1024 / 1024)} MiB per string, {Math.floor(inventory.limits.maxDraftBytes / 1024)} KiB continuation. {inventory.skipped} unavailable histories skipped.</p>
      <fieldset className="space-y-2"><legend className="font-medium">Available sessions</legend>
        {!inventory.sources.length && <p>No saved sessions. Import an archive below to read your work.</p>}
        {[...groups].map(([project, rows]) => <div key={project} className="space-y-1"><p className="text-cc-muted break-all">{project}</p>{rows.map(row => <label key={row.id} className="flex items-center gap-2 min-h-[44px] break-all"><input type="checkbox" checked={selected.includes(row.id)} disabled={pending || (!selected.includes(row.id) && selected.length >= inventory.limits.maxSessions)} onChange={e => setSelected(current => e.target.checked ? [...current, row.id] : current.filter(id => id !== row.id))} />{row.project} · {row.backend} · {row.id}</label>)}</div>)}
      </fieldset>
      <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={pending || !inventory.sources.length} onClick={() => setSelected(inventory.sources.slice(0, inventory.limits.maxSessions).map(row => row.id))}>Select up to {inventory.limits.maxSessions}</button>
        <button type="button" className={button} disabled={pending || !selected.length} onClick={() => void run(async () => { const result = await api.exportPortableHistory(selected); download(JSON.stringify(result), "aura-project-history.json", "application/json"); setStatus("Archive downloaded. Review it before sharing."); })}>Export selected ({selected.length})</button></div>
      <div className="space-y-2"><label className="block" htmlFor="portable-import">Import archive JSON</label><input id="portable-import" type="file" accept=".json,application/json" disabled={pending} onChange={e => setFile(e.target.files?.[0] ?? null)} className="block max-w-full" />
        <button type="button" className={button} disabled={pending || !file} onClick={() => void run(async () => {
          if (!file) return;
          if (file.size > Math.min(MAX_ARCHIVE_BYTES, inventory.limits.maxArchiveBytes)) throw new Error("Archive exceeds the 32 MiB limit.");
          let raw: unknown; try { raw = JSON.parse(await file.text()); } catch { throw new Error("Choose a valid JSON archive."); }
          const result = await api.importPortableHistory(raw); await load();
          const data = await api.getPortableHistory(result.id); await loadSession(result.id, data, data.sessions[0]?.id ?? "");
          setStatus(result.duplicate ? "Archive already connected; no duplicate created." : "Archive imported and saved on this installation.");
        })}>Import archive</button></div>
      <fieldset className="space-y-2"><legend className="font-medium">Connected archives</legend>
        {!inventory.archives.length && <p>No archives connected yet.</p>}
        {inventory.archives.map(row => <button type="button" key={row.id} className={`${button} block w-full text-left break-all`} disabled={pending} onClick={() => void run(async () => { const data = await api.getPortableHistory(row.id); await loadSession(row.id, data, data.sessions[0]?.id ?? ""); })}>{row.projects.join(", ")} · {row.sessions} sessions · {row.exportedAt}</button>)}
      </fieldset>
      {archive && <div className="space-y-3 border-t border-cc-border pt-4">
        <label className="block" htmlFor="portable-session">History session</label><select id="portable-session" className={input} value={sessionId} disabled={pending} onChange={e => { const next = e.target.value; void run(() => loadSession(archiveId, archive, next)); }}>{archive.sessions.map(row => <option key={row.id} value={row.id}>{row.project} · {row.backend} · {row.id}</option>)}</select>
        <p className="text-cc-muted">Exported {archive.exportedAt}; redaction policy {archive.redactionVersion}.</p>
        <ul className="list-disc pl-5 text-cc-muted">{archive.exclusions.map((line, i) => <li key={i} className="break-words">{line}</li>)}</ul>
        {session && <><p className="break-all">Origin: {session.backend}; model {session.model ?? "unknown"}; CLI {session.cliVersion ?? "unknown"}; historical folder {session.cwd ?? "unknown"}. {session.messages.length} messages.</p>
          <details><summary className="cursor-pointer min-h-[44px] py-3">Full history — literal text</summary>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words bg-cc-hover p-3 rounded-lg text-xs" aria-label="Historical messages">{session.messages.slice(page * 25, (page + 1) * 25).map(message => `${message.role} | ${message.timestamp ?? "timestamp unknown"} | stream ${message.streamStatus ?? "unknown"}\n${typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2)}`).join("\n\n")}</pre>
            <div className="flex flex-wrap items-center gap-2"><button type="button" className={button} disabled={!page} onClick={() => setPage(p => p - 1)}>Previous messages</button><span>Page {page + 1} of {Math.max(1, Math.ceil(session.messages.length / 25))}</span><button type="button" className={button} disabled={(page + 1) * 25 >= session.messages.length} onClick={() => setPage(p => p + 1)}>Next messages</button></div>
          </details></>}
        <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={pending} onClick={() => download(JSON.stringify(archive), "aura-project-history.json", "application/json")}>Download archive JSON</button><button type="button" className={button} disabled={pending || !sessionId} onClick={() => void run(async () => download(await api.getPortableHistoryMarkdown(archiveId, sessionId), "aura-project-history.md", "text/markdown"))}>Download Markdown / Obsidian</button></div>
        {context && <><h3 className="font-medium">Continuation context — review before sending</h3><p className="text-cc-muted">{context.truncated ? "Context shortened. " : ""}{context.omittedMessages} messages and {context.omittedAttachments} attachments omitted. The full archive remains available.</p><pre aria-label="Continuation context" className="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-cc-hover p-3 rounded-lg text-xs">{context.text}</pre></>}
        <label className="block" htmlFor="portable-backend">Continue with</label><select id="portable-backend" className={input} value={backend} disabled={pending} onChange={e => setBackend(e.target.value as "claude" | "codex")}><option value="claude">Claude</option><option value="codex">Codex</option></select>
        <label className="block" htmlFor="portable-cwd">Existing workspace folder (absolute path)</label><input id="portable-cwd" className={input} value={cwd} disabled={pending} placeholder="/path/to/project" onChange={e => setCwd(e.target.value)} />
        <p className="text-cc-muted">Connect your source files separately. A new session opens with an unsent draft; sending requires your action.</p>
        <button type="button" className={button} disabled={pending || !sessionId || !cwd.startsWith("/") || cwd.includes("\0")} onClick={() => void run(async () => {
          const result = await api.continuePortableHistory(archiveId, sessionId, backend, cwd);
          useStore.getState().setPickupDraft(result.newSessionId, result.draft);
          navigateToSession(result.newSessionId);
        })}>Create session with draft</button>
      </div>}
    </>}
  </div>;
}
