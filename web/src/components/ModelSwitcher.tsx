import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useStore } from "../store.js";
import { sendToSession } from "../ws.js";
import { getModelsForBackend } from "../utils/backends.js";
import type { ModelOption } from "../utils/backends.js";

interface ModelSwitcherProps {
  sessionId: string;
}

/**
 * Tier extraction by substring match on the model value. Used to mark
 * the newest entry per tier with a "Latest" badge (Friedman R1).
 */
function tierOf(value: string): "opus" | "sonnet" | "haiku" | "unknown" {
  if (value.includes("opus")) return "opus";
  if (value.includes("sonnet")) return "sonnet";
  if (value.includes("haiku")) return "haiku";
  return "unknown";
}

export function ModelSwitcher({ sessionId }: ModelSwitcherProps) {
  const [open, setOpen] = useState(false);
  // APG listbox keyboard model — `activeIndex` tracks the roving
  // `aria-activedescendant` while the dropdown is open (Task 12 / a11y R1).
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  // Stable id prefix for option elements (one listbox per ModelSwitcher
  // instance — many may render across the tree).
  const idPrefix = useId();

  const sdkSession = useStore((s) =>
    s.sdkSessions.find((sdk) => sdk.sessionId === sessionId) || null,
  );
  // Runtime session state from WebSocket (has model from CLI init message)
  const runtimeSession = useStore((s) => s.sessions.get(sessionId));
  const cliConnected = useStore((s) => s.cliConnected.get(sessionId) ?? false);

  const backendType = sdkSession?.backendType ?? runtimeSession?.backend_type ?? "claude";
  // Prefer runtime model (from CLI init) over sdkSession model (from launch config)
  const currentModel = runtimeSession?.model ?? sdkSession?.model ?? "";

  // PLAN-aura-dynamic-model-list Task 11: subscribe to settings-slice for
  // the dynamic per-backend model list. `undefined` (idle / failed / no
  // key) falls back transparently to the static `getModelsForBackend` —
  // existing zero-config UX is unchanged. The session's CURRENT model
  // (`currentModel` above) still flows from CLI's `system.init` frame, NOT
  // from this list (Fowler R2: current-active and available-choices are
  // different nouns — do not collapse).
  const dynamicModels = useStore((s) => s.dynamicBackendModels[backendType]);
  const models = dynamicModels ?? getModelsForBackend(backendType);

  // Council Review 2026-06-04-0823 P2 #13 (React/Web UI): the slice JSDoc
  // names ModelSwitcher as one of the concurrent mount callers of
  // `loadBackendModels`, but the prior implementation never fired it.
  // Today this happens to work because every path to a ModelSwitcher goes
  // through HomePage first (HomePage mounts → fetches → slice populated).
  // But "Continue in new session" (commit 3412955) bypasses HomePage, and
  // a server-restart-restored session also re-mounts ModelSwitcher without
  // an intervening HomePage mount. Fire it idempotently here so every
  // path to ModelSwitcher honours the slice's documented contract. The
  // slice action's inflight-token guard + server-side single-flight cache
  // make the cost zero when other callers already populated the slice.
  const loadBackendModels = useStore((s) => s.loadBackendModels);
  useEffect(() => {
    void loadBackendModels(backendType);
  }, [backendType, loadBackendModels]);

  // Friedman R3: per-key-status. Distinguish "no key configured" (show
  // footnote nudging Settings) from "key set but fetch failed" (silent —
  // user already opted in; noise would violate scope).
  const anthropicConfigured = useStore((s) => s.anthropicApiKeyConfigured);
  const showNoKeyHint =
    dynamicModels === undefined &&
    anthropicConfigured === false &&
    backendType === "claude";

  // Friedman R1 — mark the newest model in each tier with a "Latest"
  // badge. Server-side sort is opus > sonnet > haiku then created_at desc,
  // so the FIRST entry of each tier IS the latest. Only badge dynamic
  // lists; the static fallback's 3 fixed entries don't carry recency.
  const latestPerTier = useMemo(() => {
    if (dynamicModels === undefined) return new Set<string>();
    const set = new Set<string>();
    const seenTiers = new Set<string>();
    for (const m of models) {
      const tier = tierOf(m.value);
      if (tier !== "unknown" && !seenTiers.has(tier)) {
        set.add(m.value);
        seenTiers.add(tier);
      }
    }
    return set;
  }, [dynamicModels, models]);

  // Find the matching model option, or build a fallback for custom models
  const currentOption: ModelOption | null =
    models.find((m) => m.value === currentModel) ||
    (currentModel ? { value: currentModel, label: currentModel, icon: "?" } : null);

  const handleSelect = useCallback(
    (model: string) => {
      setOpen(false);
      if (model === currentModel) return;

      // Send set_model to CLI via WebSocket
      sendToSession(sessionId, { type: "set_model", model });

      // Optimistic update: update sdkSession.model in Zustand store
      const { sdkSessions, setSdkSessions } = useStore.getState();
      setSdkSessions(
        sdkSessions.map((sdk) =>
          sdk.sessionId === sessionId ? { ...sdk, model } : sdk,
        ),
      );
    },
    [sessionId, currentModel],
  );

  // Close on click outside
  //
  // Council Review 2026-06-04-0823 P1 #2 (a11y, EC-39): the prior shape
  // closed the dropdown without restoring focus to the trigger, asymmetric
  // with the Escape handler that DOES restore. Mirror `CouncilToggle.tsx`'s
  // precedent: rAF-defer the focus call AND gate it on the previous focused
  // element being inside the listbox so a pointer-click on another
  // focusable element doesn't yank focus from where the user clicked.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        const focusWasInsideListbox =
          listboxRef.current?.contains(document.activeElement) ?? false;
        setOpen(false);
        if (focusWasInsideListbox) {
          requestAnimationFrame(() => triggerRef.current?.focus());
        }
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // PLAN Task 12 / a11y R1: APG single-select listbox keyboard model.
  // On open: position activeIndex on the currently-selected model, focus
  // the listbox. Arrow Up/Down move the roving descendant; Home/End jump
  // to bounds; Enter/Space commits; Escape closes + returns focus to
  // trigger. Click also commits (handleSelect above).
  //
  // Council Review 2026-06-04-0823 P1 #3 (a11y): two corrections from
  // the prior shape —
  // (a) `queueMicrotask(focus)` was non-deterministic under React 19
  //     StrictMode (double-invoke → cleanup-then-stale-ref → silently
  //     swallowed focus) AND not test-verified. Switch to
  //     `requestAnimationFrame` to defer past React's commit phase, in
  //     line with the codebase precedent at `CouncilToggle.tsx`.
  // (b) Removed `models` from the dep array — the prior dep made this
  //     effect re-fire AND reset activeIndex on every dynamic-list
  //     refresh while the dropdown was open, snapping the keyboard
  //     cursor away from where the user was navigating (Friedman P2 #5
  //     bounded by the activeIndex reset; clamping to bounds is now the
  //     responsibility of the keydown handler, which is already
  //     defended by `Math.min(...)` / `Math.max(...)`).
  // Open-transition tracker `wasOpenRef` ensures the focus/reset fires
  // ONLY on the false→true edge of `open`, not on every render while open.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    // Init active index to selected (fallback to 0 if not found).
    const selected = models.findIndex((m) => m.value === currentModel);
    setActiveIndex(selected >= 0 ? selected : 0);
    requestAnimationFrame(() => {
      listboxRef.current?.focus();
    });
  }, [open, models, currentModel]);

  // Scroll the active option into view on each activeIndex change
  // (a11y R3 + WCAG 2.4.11 Focus Not Obscured). `block: "nearest"`
  // prevents the page-jump trap when the listbox is in a scroll container.
  useEffect(() => {
    if (!open) return;
    const el = document.getElementById(`${idPrefix}-option-${activeIndex}`);
    // Optional-chain the method itself — JSDOM-based test environments
    // don't implement `scrollIntoView`. Production browsers always do.
    el?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex, idPrefix]);

  const handleListboxKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (models.length === 0) return;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, models.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          break;
        case "Home":
          e.preventDefault();
          setActiveIndex(0);
          break;
        case "End":
          e.preventDefault();
          setActiveIndex(models.length - 1);
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          handleSelect(models[activeIndex]!.value);
          break;
        case "Escape":
          e.preventDefault();
          setOpen(false);
          triggerRef.current?.focus();
          break;
      }
    },
    [models, activeIndex, handleSelect],
  );

  // Hide for Codex (set_model not supported) or when CLI disconnected
  if (backendType === "codex" || !cliConnected || !currentOption) {
    return null;
  }

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        onClick={() => setOpen((prev) => !prev)}
        className={`flex items-center gap-1 h-8 px-2 rounded-md text-[12px] font-medium transition-colors cursor-pointer ${
          open
            ? "text-cc-fg bg-cc-active"
            : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
        }`}
        title={`Current model: ${currentOption.label}`}
        aria-label="Switch model"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        {currentOption.icon && <span className="text-[13px] leading-none">{currentOption.icon}</span>}
        <span className="max-w-[14rem] truncate">{currentOption.label}</span>
        <svg viewBox="0 0 12 12" fill="currentColor" className="w-2.5 h-2.5 opacity-50">
          <path d="M6 8L1.5 3.5h9L6 8z" />
        </svg>
      </button>

      {open && (
        // Council Review 2026-06-04-0823 P2 #12 (Friedman × a11y): the
        // no-key footnote previously lived INSIDE the role="listbox" div
        // — screen readers iterated it as a phantom option. Restructure:
        // wrapper holds the listbox + sibling footnote so the footnote is
        // outside the listbox's option iteration. Wrapper handles the
        // overlay positioning + clip; listbox owns its own focus ring.
        <div className="absolute right-0 bottom-full mb-1 z-50 min-w-[180px] max-w-[280px] rounded-lg border border-cc-separator bg-cc-bg shadow-lg overflow-hidden">
        <div
          ref={listboxRef}
          tabIndex={0}
          // PLAN Task 13 / Saarinen R1: dropdown width clamp inherited from wrapper.
          // PLAN Task 12 / a11y R3: max-h + overflow-y for grown lists.
          className="max-h-[24rem] overflow-y-auto focus:outline-none focus:ring-1 focus:ring-cc-primary/40"
          role="listbox"
          aria-label="Select model"
          aria-activedescendant={`${idPrefix}-option-${activeIndex}`}
          onKeyDown={handleListboxKeyDown}
        >
          {models.map((model, index) => {
            const isSelected = model.value === currentModel;
            const isActive = index === activeIndex;
            const isLatest = latestPerTier.has(model.value);
            return (
              <div
                key={model.value}
                id={`${idPrefix}-option-${index}`}
                onClick={() => handleSelect(model.value)}
                title={model.label}
                className={`w-full flex items-center gap-2 px-3 min-h-[44px] text-[13px] transition-colors cursor-pointer ${
                  isSelected
                    ? "text-cc-fg bg-cc-active font-medium"
                    : isActive
                      ? "text-cc-fg bg-cc-hover"
                      : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                }`}
                role="option"
                aria-selected={isSelected}
              >
                {model.icon && (
                  <span className="text-[14px] leading-none w-5 text-center shrink-0">
                    {model.icon}
                  </span>
                )}
                <span className="flex-1 text-left truncate">{model.label}</span>
                {isLatest && !isSelected && (
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-cc-muted px-1.5 py-0.5 rounded border border-cc-separator">
                    Latest
                  </span>
                )}
                {isSelected && (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-primary shrink-0">
                    <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                  </svg>
                )}
              </div>
            );
          })}
        </div>
        {/* PLAN Task 14 / Friedman R3 — discoverability footnote when
           the rendered list IS the static fallback AND the user has no
           API key. Connects the gated capability ("more models") to the
           unlocking action (Settings → key). Silent when key is set
           but upstream failed (scope decision).

           Council Review 2026-06-04-0823 P2 #12 (Friedman): rendered as
           an actual link to `#/settings` so the path is one-click from
           the dropdown. `onClick` closes the dropdown so the navigation
           is clean. Sits as a SIBLING of the listbox div (not a child) so
           SR doesn't iterate it as a phantom option. */}
        {showNoKeyHint && (
          <a
            href="#/settings"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 border-t border-cc-separator text-[11px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors"
          >
            Add an API key in Settings to see more models.
          </a>
        )}
        </div>
      )}
    </div>
  );
}
