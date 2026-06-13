// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockSendToSession = vi.fn();
const mockRelaunchSession = vi.fn();

vi.mock("../ws.js", () => ({
  sendToSession: (...args: unknown[]) => mockSendToSession(...args),
}));

vi.mock("../api.js", () => ({
  api: {
    relaunchSession: (...args: unknown[]) => mockRelaunchSession(...args),
  },
}));

interface MockStoreState {
  sdkSessions: { sessionId: string; model?: string; backendType?: string; cwd: string }[];
  cliConnected: Map<string, boolean>;
  cliReconnecting: Map<string, boolean>;
  sessions: Map<string, { model?: string; backend_type?: string }>;
  pendingCodexModelSwitches: Map<string, { requestedModel: string; requestedAt: number }>;
  // PLAN-aura-dynamic-model-list Task 11: ModelSwitcher subscribes to the
  // settings-slice cache. Empty default → fallback to static models (the
  // pre-Task-11 behaviour these tests already assert).
  dynamicBackendModels: { claude?: unknown; codex?: unknown };
  // Council Review 2026-06-04-0823 P2 #13: ModelSwitcher now fires
  // loadBackendModels on mount to honour the slice JSDoc contract. Tests
  // mock as a no-op vi.fn so the mount effect doesn't blow up.
  loadBackendModels: (backend: string) => Promise<void>;
  // P2 #14-ish — also surface anthropicApiKeyConfigured for the no-key
  // footnote subscription added in PLAN Task 14.
  anthropicApiKeyConfigured?: boolean | null;
}

let storeState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  storeState = {
    sdkSessions: [
      { sessionId: "s1", model: DEFAULT_MODEL.value, backendType: "claude", cwd: "/repo" },
    ],
    cliConnected: new Map([["s1", true]]),
    cliReconnecting: new Map(),
    sessions: new Map([["s1", { model: DEFAULT_MODEL.value }]]),
    pendingCodexModelSwitches: new Map(),
    dynamicBackendModels: {},
    loadBackendModels: vi.fn(async () => undefined),
    anthropicApiKeyConfigured: null,
    ...overrides,
  };
}

// Track setSdkSessions / updateSession calls for optimistic update verification
const mockSetSdkSessions = vi.fn();
const mockUpdateSession = vi.fn();
const mockSetPendingClaudeModelSwitch = vi.fn();

vi.mock("../store.js", () => ({
  useStore: Object.assign(
    (selector: (s: MockStoreState) => unknown) => selector(storeState),
    {
      getState: () => ({
        ...storeState,
        setSdkSessions: mockSetSdkSessions,
        updateSession: mockUpdateSession,
        setPendingCodexModelSwitch: vi.fn(),
        clearPendingCodexModelSwitch: vi.fn(),
        setPendingClaudeModelSwitch: mockSetPendingClaudeModelSwitch,
      }),
    },
  ),
}));

import { ModelSwitcher } from "./ModelSwitcher.js";
import { CLAUDE_MODELS } from "../utils/backends.js";

// Resolve model fixtures from CLAUDE_MODELS so a model bump
// (e.g. Opus 4.7 → 4.8) doesn't require touching this test.
const DEFAULT_MODEL = CLAUDE_MODELS[0];

beforeEach(() => {
  vi.clearAllMocks();
  mockRelaunchSession.mockResolvedValue({ ok: true });
  resetStore();
});

describe("ModelSwitcher", () => {
  it("renders current model icon and label", () => {
    render(<ModelSwitcher sessionId="s1" />);
    // Default model label (driven by CLAUDE_MODELS[0])
    expect(screen.getByText(DEFAULT_MODEL.label)).toBeInTheDocument();
    expect(screen.getByLabelText("Switch model")).toBeInTheDocument();
  });

  it("opens dropdown on click and shows all Claude models", () => {
    render(<ModelSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Switch model"));

    // All three Claude models should appear as options
    expect(screen.getByRole("option", { name: /Opus/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Sonnet/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Haiku/ })).toBeInTheDocument();
  });

  it("marks the current model as selected", () => {
    render(<ModelSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Switch model"));

    const opusOption = screen.getByRole("option", { name: /Opus/ });
    expect(opusOption).toHaveAttribute("aria-selected", "true");

    const sonnetOption = screen.getByRole("option", { name: /Sonnet/ });
    expect(sonnetOption).toHaveAttribute("aria-selected", "false");
  });

  it("sends set_model via WebSocket on selection", () => {
    render(<ModelSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Switch model"));
    fireEvent.click(screen.getByRole("option", { name: /Sonnet/ }));

    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "set_model",
      model: "claude-sonnet-4-6",
    });
  });

  it("optimistically updates the store after selection", () => {
    render(<ModelSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Switch model"));
    fireEvent.click(screen.getByRole("option", { name: /Sonnet/ }));

    expect(mockSetSdkSessions).toHaveBeenCalledOnce();
    const updatedSessions = mockSetSdkSessions.mock.calls[0][0];
    expect(updatedSessions[0].model).toBe("claude-sonnet-4-6");
  });

  // Regression: the trigger label reads `runtimeSession?.model` first, so an
  // optimistic write to ONLY sdkSession (the prior behaviour) stayed invisible
  // until the next session_init/update — i.e. the selection appeared unchanged
  // until the user sent a message. The fix also updates the runtime session.
  it("optimistically updates the runtime session model so the label changes immediately", () => {
    render(<ModelSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Switch model"));
    fireEvent.click(screen.getByRole("option", { name: /Sonnet/ }));

    expect(mockUpdateSession).toHaveBeenCalledWith("s1", { model: "claude-sonnet-4-6" });
  });

  // The pending-switch record is what lets ws.ts revert the optimistic label if
  // the CLI later 404s the model (subscription can't use a model the dropdown,
  // sourced from the API-key /v1/models list, still offers). It must capture the
  // PREVIOUS model so the revert + re-issued set_model land on a known-good slug.
  it("records the pending Claude model switch with the previous model for revert", () => {
    render(<ModelSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Switch model"));
    fireEvent.click(screen.getByRole("option", { name: /Sonnet/ }));

    expect(mockSetPendingClaudeModelSwitch).toHaveBeenCalledWith(
      "s1",
      "claude-sonnet-4-6",
      DEFAULT_MODEL.value,
    );
  });

  it("does not send when selecting the already-active model", () => {
    render(<ModelSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Switch model"));
    fireEvent.click(screen.getByRole("option", { name: /Opus/ }));

    // Same model — no WS message, no store update
    expect(mockSendToSession).not.toHaveBeenCalled();
    expect(mockSetSdkSessions).not.toHaveBeenCalled();
  });

  it("closes dropdown on Escape key (APG listbox keyboard model)", () => {
    // PLAN-aura-dynamic-model-list Task 12 / a11y R1: Escape now lives on
    // the listbox's own keyDown handler (APG-conformant). The dropdown
    // listbox autofocuses on open, so a key press lands there naturally.
    render(<ModelSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Switch model"));
    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeInTheDocument();

    fireEvent.keyDown(listbox, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes dropdown on click outside", () => {
    render(<ModelSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Switch model"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    // Click outside the component
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("renders for Codex and relaunches the same session with the selected model", async () => {
    resetStore({
      sdkSessions: [
        { sessionId: "s1", model: "gpt-5.3-codex", backendType: "codex", cwd: "/repo" },
      ],
      sessions: new Map([["s1", { model: "gpt-5.3-codex", backend_type: "codex" }]]),
      dynamicBackendModels: {
        codex: [
          { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", icon: "" },
          { value: "gpt-5.2-codex", label: "GPT-5.2 Codex", icon: "" },
        ],
      },
    });
    render(<ModelSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Switch model"));
    fireEvent.click(screen.getByRole("option", { name: /GPT-5\.2 Codex/i }));

    await waitFor(() => {
      expect(mockRelaunchSession).toHaveBeenCalledWith("s1", { model: "gpt-5.2-codex" });
    });
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("is hidden when CLI is not connected", () => {
    // Can't switch model without a live CLI connection
    resetStore({ cliConnected: new Map([["s1", false]]) });
    const { container } = render(<ModelSwitcher sessionId="s1" />);
    expect(container.innerHTML).toBe("");
  });

  it("is hidden when session has no model set", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", backendType: "claude", cwd: "/repo" }],
      sessions: new Map([["s1", {}]]),
    });
    const { container } = render(<ModelSwitcher sessionId="s1" />);
    expect(container.innerHTML).toBe("");
  });

  it("shows raw model string for unrecognized models", () => {
    // Custom/unknown model — should still render with a fallback
    resetStore({
      sdkSessions: [
        { sessionId: "s1", model: "claude-custom-model", backendType: "claude", cwd: "/repo" },
      ],
      sessions: new Map([["s1", { model: "claude-custom-model" }]]),
    });
    render(<ModelSwitcher sessionId="s1" />);
    expect(screen.getByText("claude-custom-model")).toBeInTheDocument();
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    render(<ModelSwitcher sessionId="s1" />);
    const results = await axe(document.body);
    expect(results).toHaveNoViolations();
  });

  it("passes axe checks with dropdown open", async () => {
    // Scope axe to the component container to avoid the "region" landmark rule
    // which fires because the component renders outside a <main>/<header> in isolation.
    const { axe } = await import("vitest-axe");
    const { container } = render(<ModelSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Switch model"));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // ── PLAN-aura-dynamic-model-list Task 15 — dynamic-list path ────────────

  describe("with dynamic models from settings-slice (Tasks 11, 13, 14)", () => {
    const dynamicClaude = [
      { value: "claude-opus-4-8", label: "Opus 4.8", icon: "" },
      { value: "claude-opus-4-7", label: "Opus 4.7", icon: "" },
      { value: "claude-sonnet-4-6", label: "Sonnet 4.6", icon: "" },
      { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5", icon: "" },
    ];

    it("renders the dynamic list from the slice when present (replaces static)", () => {
      resetStore({ dynamicBackendModels: { claude: dynamicClaude } });
      render(<ModelSwitcher sessionId="s1" />);
      fireEvent.click(screen.getByLabelText("Switch model"));
      // All 4 dynamic models render
      expect(screen.getByRole("option", { name: /Opus 4\.8/ })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: /Opus 4\.7/ })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: /Sonnet 4\.6/ })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: /Haiku 4\.5/ })).toBeInTheDocument();
    });

    it("marks the newest model per tier with a 'Latest' badge (Friedman R1)", () => {
      // Use a current model that is NOT in `dynamicClaude` so no rendered
      // option gets `aria-selected=true` — the Latest badge is gated on
      // `!isSelected`, so a selected option would suppress its tier's
      // badge and confound the per-tier-count assertion. PR #93 surfaced
      // this coupling: when `CLAUDE_MODELS[0]` happened to equal
      // `dynamicClaude[0]`, the first opus got selected → only 2 badges
      // rendered instead of 3. Pinning currentModel to a legacy slug
      // makes the assertion independent of the static fallback's [0].
      resetStore({
        dynamicBackendModels: { claude: dynamicClaude },
        sdkSessions: [
          {
            sessionId: "s1",
            model: "claude-opus-4-5-20251101",
            backendType: "claude",
            cwd: "/repo",
          },
        ],
        sessions: new Map([["s1", { model: "claude-opus-4-5-20251101" }]]),
      });
      render(<ModelSwitcher sessionId="s1" />);
      fireEvent.click(screen.getByLabelText("Switch model"));
      // Exactly 3 "Latest" badges (one per tier: opus, sonnet, haiku).
      // Opus 4.7 must NOT carry the badge (4.8 is newer in tier).
      const badges = screen.getAllByText("Latest");
      expect(badges).toHaveLength(3);
    });

    it("passes axe checks with dynamic list rendered (Task 15 a11y mandate)", async () => {
      resetStore({ dynamicBackendModels: { claude: dynamicClaude } });
      const { axe } = await import("vitest-axe");
      const { container } = render(<ModelSwitcher sessionId="s1" />);
      fireEvent.click(screen.getByLabelText("Switch model"));
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it("does NOT render the no-key footnote when dynamic list is present", () => {
      resetStore({ dynamicBackendModels: { claude: dynamicClaude } });
      render(<ModelSwitcher sessionId="s1" />);
      fireEvent.click(screen.getByLabelText("Switch model"));
      expect(screen.queryByText(/Add an API key in Settings/)).not.toBeInTheDocument();
    });
  });

  // ── PLAN Task 14 — discoverability no-key footnote ──────────────────────

  describe("no-key footnote (Friedman R3)", () => {
    it("renders the Settings hint when fallback list is shown AND no key configured", () => {
      // Static list + anthropicApiKeyConfigured: false → footnote visible.
      resetStore({ anthropicApiKeyConfigured: false } as Partial<MockStoreState>);
      render(<ModelSwitcher sessionId="s1" />);
      fireEvent.click(screen.getByLabelText("Switch model"));
      expect(screen.getByText(/Add an API key in Settings/)).toBeInTheDocument();
    });

    it("does NOT render the hint when anthropicApiKeyConfigured is null (unhydrated)", () => {
      // Avoid flashing the hint before the slice has hydrated from /api/settings.
      resetStore({ anthropicApiKeyConfigured: null } as Partial<MockStoreState>);
      render(<ModelSwitcher sessionId="s1" />);
      fireEvent.click(screen.getByLabelText("Switch model"));
      expect(screen.queryByText(/Add an API key in Settings/)).not.toBeInTheDocument();
    });

    it("does NOT render the hint when key IS configured (silent fallback on upstream error)", () => {
      // Per scope: key set but fetch failed → silent fallback. Footnote
      // would confuse — the user opted in already.
      resetStore({ anthropicApiKeyConfigured: true } as Partial<MockStoreState>);
      render(<ModelSwitcher sessionId="s1" />);
      fireEvent.click(screen.getByLabelText("Switch model"));
      expect(screen.queryByText(/Add an API key in Settings/)).not.toBeInTheDocument();
    });
  });

  // ── PLAN Task 12 — APG listbox keyboard model ───────────────────────────

  describe("APG listbox keyboard model (a11y R1)", () => {
    const longClaude = [
      { value: "claude-opus-4-8", label: "Opus 4.8", icon: "" },
      { value: "claude-opus-4-7", label: "Opus 4.7", icon: "" },
      { value: "claude-sonnet-4-6", label: "Sonnet 4.6", icon: "" },
      { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5", icon: "" },
    ];

    it("opens with aria-activedescendant on the currently-selected option", () => {
      resetStore({ dynamicBackendModels: { claude: longClaude } });
      render(<ModelSwitcher sessionId="s1" />);
      fireEvent.click(screen.getByLabelText("Switch model"));
      const listbox = screen.getByRole("listbox");
      // currentModel === CLAUDE_MODELS[0].value (claude-opus-4-7) which is
      // index 1 in `longClaude`.
      const expectedSelectedIndex = longClaude.findIndex(
        (m) => m.value === DEFAULT_MODEL.value,
      );
      const activeId = listbox.getAttribute("aria-activedescendant");
      expect(activeId).toContain(`-option-${expectedSelectedIndex >= 0 ? expectedSelectedIndex : 0}`);
    });

    it("ArrowDown advances aria-activedescendant within bounds", () => {
      resetStore({ dynamicBackendModels: { claude: longClaude } });
      render(<ModelSwitcher sessionId="s1" />);
      fireEvent.click(screen.getByLabelText("Switch model"));
      const listbox = screen.getByRole("listbox");
      const initial = listbox.getAttribute("aria-activedescendant");
      fireEvent.keyDown(listbox, { key: "ArrowDown" });
      const afterDown = listbox.getAttribute("aria-activedescendant");
      expect(afterDown).not.toBe(initial);
    });

    it("Home jumps to the first option", () => {
      resetStore({ dynamicBackendModels: { claude: longClaude } });
      render(<ModelSwitcher sessionId="s1" />);
      fireEvent.click(screen.getByLabelText("Switch model"));
      const listbox = screen.getByRole("listbox");
      fireEvent.keyDown(listbox, { key: "End" });
      fireEvent.keyDown(listbox, { key: "Home" });
      const activeId = listbox.getAttribute("aria-activedescendant");
      expect(activeId).toMatch(/-option-0$/);
    });

    it("End jumps to the last option", () => {
      resetStore({ dynamicBackendModels: { claude: longClaude } });
      render(<ModelSwitcher sessionId="s1" />);
      fireEvent.click(screen.getByLabelText("Switch model"));
      const listbox = screen.getByRole("listbox");
      fireEvent.keyDown(listbox, { key: "End" });
      const activeId = listbox.getAttribute("aria-activedescendant");
      expect(activeId).toMatch(new RegExp(`-option-${longClaude.length - 1}$`));
    });

    it("Enter on a different option commits the selection (sends set_model)", () => {
      resetStore({ dynamicBackendModels: { claude: longClaude } });
      render(<ModelSwitcher sessionId="s1" />);
      fireEvent.click(screen.getByLabelText("Switch model"));
      const listbox = screen.getByRole("listbox");
      fireEvent.keyDown(listbox, { key: "End" }); // jump to last (Haiku)
      fireEvent.keyDown(listbox, { key: "Enter" });
      expect(mockSendToSession).toHaveBeenCalledWith("s1", {
        type: "set_model",
        model: "claude-haiku-4-5-20251001",
      });
    });

    // PR #91 burndown Task 12 (Council Review 2026-06-04-1826 P3 #13):
    // when the dynamic list shrinks mid-open (e.g., Settings save with
    // dropdown still open), `activeIndex` may point past the new list's
    // bounds. The clamping effect must bring it back so the keydown
    // handler doesn't read `models[activeIndex] === undefined`.
    it("clamps activeIndex when the dynamic list shrinks while the dropdown is open", () => {
      const longList = [
        { value: "claude-opus-4-8", label: "Opus 4.8", icon: "" },
        { value: "claude-opus-4-7", label: "Opus 4.7", icon: "" },
        { value: "claude-sonnet-4-6", label: "Sonnet 4.6", icon: "" },
        { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5", icon: "" },
      ];
      resetStore({ dynamicBackendModels: { claude: longList } });
      const { rerender } = render(<ModelSwitcher sessionId="s1" />);
      fireEvent.click(screen.getByLabelText("Switch model"));
      const listbox = screen.getByRole("listbox");
      fireEvent.keyDown(listbox, { key: "End" }); // index 3 (Haiku, last)
      expect(listbox.getAttribute("aria-activedescendant")).toMatch(/-option-3$/);

      // Simulate Settings-save mid-open: dynamic list shrinks to 2 items
      // (e.g., Anthropic removed Haiku + Sonnet from /v1/models).
      resetStore({
        dynamicBackendModels: {
          claude: [
            { value: "claude-opus-4-8", label: "Opus 4.8", icon: "" },
            { value: "claude-opus-4-7", label: "Opus 4.7", icon: "" },
          ],
        },
      });
      rerender(<ModelSwitcher sessionId="s1" />);

      // Mutation-resistance (EC-42): without the clamp effect,
      // activeIndex stays at 3 and Enter would crash on
      // `models[3]!.value`. With the clamp, it falls to max=1.
      const listboxAfter = screen.getByRole("listbox");
      expect(listboxAfter.getAttribute("aria-activedescendant")).toMatch(/-option-1$/);
    });
  });

  // ── PLAN Task 12 — verify-by-absence (a11y R4) ──────────────────────────

  describe("verify-by-absence: no aria-live on the listbox root (a11y R4)", () => {
    // Future-contributor canary: a refactor that wraps the listbox in
    // `aria-live="polite"` to announce "new models" would announce the
    // whole list every cache refresh. Verified by absence — keeps the
    // floor.
    it("listbox container does NOT carry aria-live or role='status'", () => {
      render(<ModelSwitcher sessionId="s1" />);
      fireEvent.click(screen.getByLabelText("Switch model"));
      const listbox = screen.getByRole("listbox");
      expect(listbox).not.toHaveAttribute("aria-live");
      expect(listbox.getAttribute("role")).toBe("listbox");
      expect(listbox.getAttribute("role")).not.toBe("status");
      expect(listbox.getAttribute("role")).not.toBe("log");
    });
  });

  // ── PLAN Task 12 — truncated long label remains announceable (a11y R2) ──

  describe("long-label accessibility (a11y R2)", () => {
    it("option carries title attribute equal to its full label", () => {
      const long = [
        {
          value: "claude-opus-4-8-20260415",
          label: "Claude Opus 4.8 (2026-04-15 snapshot — extended-context)",
          icon: "",
        },
      ];
      resetStore({ dynamicBackendModels: { claude: long } });
      render(<ModelSwitcher sessionId="s1" />);
      fireEvent.click(screen.getByLabelText("Switch model"));
      const option = screen.getByRole("option", { name: /extended-context/ });
      expect(option).toHaveAttribute("title", long[0].label);
    });
  });

  // ── Council Review 2026-06-04-0823 burndown — focus contract pins ────────

  describe("focus contract on dismissal (Council P1 #2, P1 #3 — EC-39)", () => {
    // PR #91 burndown Task 6 (Council Review 2026-06-04-1826 P1 #1):
    // verify the OPEN-EDGE rAF-autofocus contract directly. The prior
    // burndown shipped only the click-outside restoration test, leaving
    // the open-edge contract unpinned. EC-42 mutation-resistance: stub
    // `window.requestAnimationFrame` to flush its callback synchronously
    // AND assert the spy was called — reverting ModelSwitcher.tsx:179
    // from `requestAnimationFrame` to `queueMicrotask` makes the spy
    // assertion go RED regardless of focus side-effects.
    it("opening dropdown calls requestAnimationFrame AND focus lands on listbox", () => {
      const rafSpy = vi
        .spyOn(window, "requestAnimationFrame")
        .mockImplementation((cb) => {
          cb(0);
          return 0;
        });
      try {
        render(<ModelSwitcher sessionId="s1" />);
        const trigger = screen.getByLabelText("Switch model");
        fireEvent.click(trigger);

        // Mutation: switch back to queueMicrotask → 0 rAF calls → RED.
        expect(rafSpy).toHaveBeenCalled();

        // Producer-realistic: after synchronous rAF flush, focus is on
        // the listbox div (autofocus contract). Mutation: drop the
        // `listboxRef.current?.focus()` line → focus stays on trigger.
        const listbox = screen.getByRole("listbox");
        expect(listbox).toHaveFocus();
      } finally {
        rafSpy.mockRestore();
      }
    });

    // Council Review 2026-06-04-0823 P1 #2: click-outside dismissal must
    // restore focus to the trigger, mirroring the Escape path. Asymmetric
    // contracts ship undetected; this test pins the symmetric behaviour
    // so a future refactor that drops the restoration goes red.
    it("click-outside restores focus to the trigger when focus was inside the listbox", async () => {
      render(
        <>
          <ModelSwitcher sessionId="s1" />
          <button data-testid="elsewhere">elsewhere</button>
        </>,
      );
      const trigger = screen.getByLabelText("Switch model");
      fireEvent.click(trigger);
      const listbox = screen.getByRole("listbox");
      // This test pins click-outside FOCUS RESTORATION (back to trigger),
      // NOT the open-edge autofocus contract — that's covered by the
      // `requestAnimationFrame` test above. We pre-position focus on the
      // listbox to simulate the post-open state regardless of how the
      // production code achieved it (rAF, microtask, etc.).
      listbox.focus();
      // Click outside the dropdown.
      fireEvent.mouseDown(screen.getByTestId("elsewhere"));
      await waitFor(() => {
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      });
      await waitFor(() => {
        expect(trigger).toHaveFocus();
      });
    });

    it("click-outside does NOT yank focus when focus was outside the listbox (pointer click on another control)", async () => {
      render(
        <>
          <ModelSwitcher sessionId="s1" />
          <button data-testid="elsewhere">elsewhere</button>
        </>,
      );
      const trigger = screen.getByLabelText("Switch model");
      fireEvent.click(trigger);
      // Don't move focus into the listbox — keep it elsewhere (simulates
      // pointer-only interaction where the user never tabbed in).
      const elsewhere = screen.getByTestId("elsewhere");
      elsewhere.focus();
      fireEvent.mouseDown(elsewhere);
      await waitFor(() => {
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      });
      // Focus stays where the user clicked, NOT yanked back to the trigger.
      expect(elsewhere).toHaveFocus();
    });

    it("Escape still restores focus to the trigger (regression pin for the symmetric Escape path)", () => {
      render(<ModelSwitcher sessionId="s1" />);
      const trigger = screen.getByLabelText("Switch model");
      fireEvent.click(trigger);
      const listbox = screen.getByRole("listbox");
      fireEvent.keyDown(listbox, { key: "Escape" });
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
  });

  describe("mount lifecycle (Council P2 #13 — slice JSDoc contract)", () => {
    // Council Review 2026-06-04-0823 P2 #13: ModelSwitcher MUST call
    // loadBackendModels on mount so the slice JSDoc "concurrent caller"
    // contract is honoured for paths that bypass HomePage (e.g.,
    // Continue-in-new-session, server-restart-restored sessions).
    it("fires loadBackendModels for the current backend on mount", async () => {
      render(<ModelSwitcher sessionId="s1" />);
      await waitFor(() => {
        expect(storeState.loadBackendModels).toHaveBeenCalledWith("claude");
      });
    });
  });

  describe("no-key footnote is structurally OUTSIDE the listbox role (Council P2 #12)", () => {
    // PR #91 burndown Task 7 (Council Review 2026-06-04-1826 P1 #3):
    // single render, scope ALL queries through `within(container)` so
    // both the listbox AND the link resolve from the ONE component
    // instance. Prior shape rendered twice (default+override) and let
    // `screen.getByRole` pick whichever instance — assertion passed
    // regardless of fix. EC-42 mutation-resistance: moving the footnote
    // back INSIDE the listbox div makes `listbox.contains(link)` return
    // true → assertion goes RED.
    it("no-key footnote (<a> link) is NOT a descendant of role='listbox'", () => {
      // Configure no-key state BEFORE the single render — footnote
      // visibility is gated on `anthropicApiKeyConfigured === false`.
      resetStore({ anthropicApiKeyConfigured: false });
      const { container } = render(<ModelSwitcher sessionId="s1" />);

      // Open this exact instance.
      fireEvent.click(within(container).getByLabelText("Switch model"));

      // Scoped queries — both resolve from THIS component's DOM.
      const listbox = within(container).getByRole("listbox");
      const link = within(container).getByRole("link", {
        name: /Add an API key in Settings/,
      });

      // Both nodes present in the same wrapper, but the link must be a
      // SIBLING of the listbox (not a descendant). DOM-level identity
      // check — mutation-resistant.
      expect(listbox.contains(link)).toBe(false);
      // Belt and braces: link IS a descendant of the outer wrapper.
      expect(container.contains(link)).toBe(true);
    });

    it("footnote is a clickable link to #/settings that closes the dropdown on activation", () => {
      resetStore({ anthropicApiKeyConfigured: false });
      render(<ModelSwitcher sessionId="s1" />);
      fireEvent.click(screen.getByLabelText("Switch model"));
      const link = screen.getByRole("link", { name: /Add an API key in Settings/ });
      expect(link).toHaveAttribute("href", "#/settings");
      fireEvent.click(link);
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
  });
});
