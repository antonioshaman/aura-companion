import { useEffect, useRef } from "react";
import { useStore } from "../store.js";
import type { BackendType } from "../types.js";

/**
 * Re-fetch the dynamic model list when the tab regains focus / becomes
 * visible, but only while the last fetch HARD-failed (`rejected`). Covers
 * the case where every automatic retry in the slice was exhausted while the
 * server or upstream was unhealthy: coming back to the tab tries again
 * instead of leaving the dropdown pinned to the static fallback forever.
 */
export function useModelListAutoRefresh(backend: BackendType): void {
  const loadBackendModels = useStore((s) => s.loadBackendModels);
  const status = useStore((s) => s.dynamicBackendModelsStatus?.[backend]);
  // Ref so the listeners see the latest status without re-subscribing.
  const statusRef = useRef(status);
  statusRef.current = status;
  useEffect(() => {
    const maybeReload = () => {
      if (document.visibilityState === "hidden") return;
      if (statusRef.current !== "rejected") return;
      void loadBackendModels(backend);
    };
    window.addEventListener("focus", maybeReload);
    document.addEventListener("visibilitychange", maybeReload);
    return () => {
      window.removeEventListener("focus", maybeReload);
      document.removeEventListener("visibilitychange", maybeReload);
    };
  }, [backend, loadBackendModels]);
}

interface ModelListFallbackHintProps {
  backend: BackendType;
  className?: string;
}

/**
 * Subtle hint shown under a Claude model dropdown when the list it renders
 * is the static fallback because the dynamic fetch failed (key configured,
 * upstream/server unreachable). Offers a manual "Обновить" retry.
 *
 * Silent when: the dynamic list is loaded, the backend is not Claude, or the
 * server said no API key is configured (`unconfigured` — static IS the list).
 * Stays visible (button disabled) while a retry after a failure is in flight
 * so the line doesn't flicker on every automatic backoff attempt.
 */
export function ModelListFallbackHint({ backend, className }: ModelListFallbackHintProps) {
  const dynamicModels = useStore((s) => s.dynamicBackendModels?.[backend]);
  const status = useStore((s) => s.dynamicBackendModelsStatus?.[backend]);
  const loadBackendModels = useStore((s) => s.loadBackendModels);

  // Remember that the current fallback state was caused by a failure, so a
  // follow-up `pending` (retry in flight) keeps the hint instead of hiding it.
  const failedRef = useRef(false);
  if (status === "rejected") failedRef.current = true;
  else if (status !== "pending") failedRef.current = false;

  const onFallbackAfterFailure =
    backend === "claude"
    && dynamicModels === undefined
    && (status === "rejected" || (status === "pending" && failedRef.current));
  if (!onFallbackAfterFailure) return null;

  const retrying = status === "pending";
  return (
    <div
      role="status"
      className={`flex items-center gap-2 text-[11px] text-cc-muted ${className ?? ""}`}
    >
      <span>Список моделей не загрузился — показан базовый.</span>
      <button
        type="button"
        disabled={retrying}
        onClick={() => { void loadBackendModels(backend); }}
        className="shrink-0 underline decoration-dotted decoration-cc-muted/60 hover:text-cc-fg hover:decoration-solid disabled:opacity-60 disabled:cursor-wait cursor-pointer"
      >
        {retrying ? "Обновляю…" : "Обновить"}
      </button>
    </div>
  );
}
