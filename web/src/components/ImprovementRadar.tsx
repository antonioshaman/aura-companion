import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api.js";
import type { RadarView } from "../../server/radar/radar-types.js";
import type { ModelFreshness } from "../../server/model-freshness.js";

const control = "rounded-md px-2 py-1.5 text-xs hover:bg-cc-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cc-primary disabled:opacity-50";
const proposalCount = (n: number) => `${n} ${n % 100 >= 11 && n % 100 <= 14 ? "предложений" : n % 10 === 1 ? "предложение" : n % 10 >= 2 && n % 10 <= 4 ? "предложения" : "предложений"}`;
const date = (value: number | string | null) => value ? new Date(value).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "нет данных";
/** A quiet disclosure, not a notification: no animation, toast, or auto-opening. */
export function ImprovementRadar({ backend, onModelsRefreshed }: { backend: "claude" | "codex"; onModelsRefreshed?: () => Promise<void> }) {
  const id = useId();
  const summary = useRef<HTMLElement>(null);
  const statusRevision = useRef(0);
  const mutating = useRef(false);
  const [view, setView] = useState<RadarView | null>(null);
  const [models, setModels] = useState<Record<"claude" | "codex", ModelFreshness> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [modelError, setModelError] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [editing, setEditing] = useState(false);
  const [showImplemented, setShowImplemented] = useState(false);
  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const data = await api.radar();
        if (live) { setView(data); setSourceText(data.config.sources.map(s => `${s.kind}:${s.value}`).join("\n")); }
      } catch { if (live) setError("Радар временно недоступен."); }
    }
    async function loadModels() {
      try { const data = await api.modelFreshness(); if (live) setModels(data); }
      catch { if (live) setModelError("Свежесть каталога не проверена."); }
    }
    void load(); void loadModels();
    return () => { live = false; };
  }, []);
  // Poll only while a run is known to be active; keep results visible meanwhile.
  useEffect(() => {
    if (!view?.running) return;
    let live = true;
    let pending = false;
    const timer = setInterval(() => {
      if (pending || mutating.current) return;
      pending = true;
      const revision = statusRevision.current;
      void api.radar().then(s => { if (live && revision === statusRevision.current) setView(s); })
        .catch(() => { if (live && revision === statusRevision.current) setError("Не удалось обновить статус проверки."); })
        .finally(() => { pending = false; });
    }, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [view?.running]);
  async function act(work: () => Promise<RadarView>, returnFocus = false) {
    statusRevision.current++; mutating.current = true;
    setBusy(true); setError("");
    try {
      setView(await work());
      if (returnFocus) summary.current?.focus();
    } catch (e) { setError(e instanceof Error ? e.message : "Действие не выполнено."); }
    finally { statusRevision.current++; mutating.current = false; setBusy(false); }
  }
  async function refreshModels() {
    setBusy(true); setModelError("");
    try {
      const result = await api.refreshModels();
      const outcome = result[backend];
      if (outcome === "ok") await onModelsRefreshed?.();
      setModels(await api.modelFreshness());
      setModelError(outcome === "unavailable" ? `Не удалось обновить каталог ${backend === "codex" ? "Codex" : "Claude"}. Предыдущий список сохранён.` : outcome === "no-key" ? "Без API-ключа каталог подписки Claude Code здесь не проверяется." : `Каталог ${backend === "codex" ? "Codex" : "Claude"} обновлён.`);
    } catch { setModelError("Обновление не удалось. Предыдущий каталог сохранён."); }
    finally { setBusy(false); }
  }
  const fresh = models?.[backend];
  const labels: Record<ModelFreshness["status"], string> = { fresh: "Каталог моделей получен недавно", stale: "Каталог моделей устарел", missing: "Каталог моделей не получен", malformed: "Каталог моделей повреждён", "no-key": "Каталог подписки Claude Code не проверяется без API-ключа" };
  const candidates = view?.ideas.filter(i => !view.decisions[i.id]) ?? [];
  const implemented = Object.entries(view?.decisions ?? {}).filter(([, decision]) => decision === "implemented").map(([key]) => ({ id: key, title: (view?.decisionIdeas?.[key] ?? view?.ideas.find(i => i.id === key))?.title ?? "Ранее найденная идея", url: view?.decisionIdeas?.[key]?.url }));
  return <div className="mt-3 text-cc-muted text-xs" data-ui="improvement-radar">
    {fresh && fresh.status !== "fresh" && <p className="mb-1 px-2">{labels[fresh.status]}. <a href="#/settings" className="underline underline-offset-2">Диагностика</a></p>}
    <details className="rounded-lg" onToggle={e => { if (!e.currentTarget.open) setEditing(false); }}>
      <summary ref={summary} tabIndex={0} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const details = e.currentTarget.parentElement as HTMLDetailsElement; details.open = !details.open; } }} className="cursor-pointer rounded-md px-2 py-2 hover:bg-cc-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cc-primary">
        Радар улучшений{view ? <> <span className="tabular-nums">· {view.outcome === "never" ? "ещё не проверялось" : proposalCount(view.counts.proposals)} · {view.counts.implemented} уже в Aura</span></> : error ? " · недоступен" : " · загрузка"}
      </summary>
      <section aria-label="Радар улучшений" className="mt-1 rounded-lg border border-cc-border p-3 space-y-3 text-cc-fg">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p>Идеи для Aura. Внедрение — только по вашему решению.</p>
          <button type="button" className={control} disabled={busy || view?.running || !view} onClick={() => { void act(() => api.runRadar()); }}>{busy || view?.running ? "Проверяем…" : "Проверить новинки"}</button>
        </div>
        <p role="status" aria-live="polite" className="text-cc-muted">
          {view?.outcome === "partial" ? "Часть источников недоступна. " : view?.outcome === "error" ? "Проверка не удалась; предыдущие результаты сохранены. " : ""}
          Последняя попытка: {date(view?.lastAttempt ?? null)} · Успех: {date(view?.lastSuccess ?? null)}
        </p>
        {error && <div><p role="alert">{error}</p>{!view && <button type="button" className={control} disabled={busy} onClick={() => { void act(async () => { const data = await api.radar(); setSourceText(data.config.sources.map(s => `${s.kind}:${s.value}`).join("\n")); return data; }); }}>Повторить загрузку</button>}</div>}
        {!!view?.sourceErrors.length && <details><summary className={control}>Недоступные источники ({view.sourceErrors.length})</summary><ul className="pl-4 list-disc">{view.sourceErrors.map((e, i) => <li key={i}>{e}</li>)}</ul></details>}
        <div className="flex gap-2 flex-wrap">
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={view?.config.enabled ?? false} disabled={!view || busy} onChange={e => { if (view) void act(() => api.configureRadar({ ...view.config, enabled: e.target.checked })); }} />Проверять раз в сутки</label>
          <button type="button" className={control} onClick={() => setEditing(!editing)} aria-expanded={editing}>Источники</button>
          <button type="button" className={control} onClick={() => setShowImplemented(!showImplemented)} aria-expanded={showImplemented}>Уже в Aura ({view?.counts.implemented ?? "—"})</button>
        </div>
        {editing && <div className="space-y-2"><label htmlFor={`${id}-sources`} className="block">Источники GitHub: repo:owner/repo или search:topic:mcp-server; official:openai-models / official:anthropic-models</label><textarea id={`${id}-sources`} value={sourceText} onChange={e => setSourceText(e.target.value)} rows={4} className="w-full rounded-md border border-cc-border bg-cc-bg p-2" /><button type="button" disabled={busy || !view} className={control} onClick={() => {
          if (!view) return;
          const sources = sourceText.split("\n").filter(x => x.trim()).map(line => { const i = line.indexOf(":"); return { kind: line.slice(0, i) as "repo" | "search" | "official", value: line.slice(i + 1).trim() }; });
          void act(() => api.configureRadar({ ...view.config, sources }));
        }}>Сохранить источники</button></div>}
        {showImplemented && <div className="space-y-1"><p className="text-cc-muted">Подтверждено кодом Aura или отмечено вами; это не число автоматически внедрённых улучшений.</p><ul className="list-disc pl-4">{view?.capabilities.map(c => <li key={c.id}>{c.title} <span className="text-cc-muted break-all">({c.evidence})</span></li>)}{implemented.map(i => <li key={i.id}>{i.title} {i.url && <a href={i.url} target="_blank" rel="noopener noreferrer" className="underline">Источник (новая вкладка)</a>} <button type="button" className={control} disabled={busy} onClick={() => { void act(() => api.decideRadar(i.id, "restore"), true); }}>Вернуть в предложения</button></li>)}</ul></div>}
        {!candidates.length && view && <p className="text-cc-muted">{view.outcome === "never" ? "Запустите проверку, чтобы найти идеи." : "Новых предложений нет."}</p>}
        <ul className="divide-y divide-cc-border">
          {candidates.slice(0, 10).map(idea => <li key={idea.id} className="py-3 space-y-1 break-words">
            <p className="font-medium">{idea.title}</p><p>{idea.benefit}</p>
            <p className="text-cc-muted">{idea.gap} Сложность: {idea.complexity}.</p>
            <div className="flex items-center gap-2 flex-wrap text-cc-muted">
              <a href={idea.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">Источник (новая вкладка)</a><span>{date(idea.publishedAt)}</span>
              <button type="button" className={control} disabled={busy} onClick={() => { void act(() => api.decideRadar(idea.id, "dismissed"), true); }}>Не предлагать</button>
              <button type="button" className={control} disabled={busy} onClick={() => { void act(() => api.decideRadar(idea.id, "implemented"), true); }}>Уже реализовано</button>
            </div>
          </li>)}
        </ul>
        {candidates.length > 10 && <p className="text-cc-muted">Показаны первые 10 из {candidates.length}. Остальные появятся после разбора списка.</p>}
        {view && Object.values(view.decisions).some(d => d === "dismissed") && <details><summary className={control}>Отклонённые идеи</summary>{Object.entries(view.decisions).filter(([, d]) => d === "dismissed").map(([key]) => <p key={key}>{(view.decisionIdeas?.[key] ?? view.ideas.find(i => i.id === key))?.title ?? "Ранее найденная идея"} {view.decisionIdeas?.[key]?.url && <a href={view.decisionIdeas[key].url} target="_blank" rel="noopener noreferrer" className="underline">Источник (новая вкладка)</a>} <button type="button" disabled={busy} className={control} onClick={() => { void act(() => api.decideRadar(key, "restore"), true); }}>Снова предлагать</button></p>)}</details>}
        <details><summary className={control}>Актуальность моделей</summary><div className="space-y-2 py-2"><p>{fresh ? labels[fresh.status] : "Свежесть не проверена"}. Каталог установки: {date(fresh?.fetchedAt ?? null)}.</p><p>Установленный CLI: {fresh?.installedCliVersion ?? "не определён"}. CLI каталога: {fresh?.catalogClientVersion ?? "нет данных"}.</p><p className="text-cc-muted">При открытии новой сессии каталог проверяется автоматически, не чаще раза в час. Публичный анонс не подтверждает доступ модели аккаунту. Проверка не устанавливает CLI и не меняет выбранную модель.</p><button type="button" disabled={busy} className={control} onClick={() => { void refreshModels(); }}>{backend === "codex" ? "Обновить каталог Codex" : "Проверить каталог Claude"}</button>{modelError && <p role="status">{modelError}</p>}</div></details>
      </section>
    </details>
  </div>;
}
