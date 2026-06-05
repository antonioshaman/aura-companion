// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockSendToSession = vi.fn();

vi.mock("../ws.js", () => ({
  sendToSession: (...args: unknown[]) => mockSendToSession(...args),
}));

interface MockStoreState {
  sdkSessions: { sessionId: string; model?: string; backendType?: string; cwd: string }[];
  cliConnected: Map<string, boolean>;
  sessions: Map<string, { model?: string; backend_type?: string }>;
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
    sessions: new Map([["s1", { model: DEFAULT_MODEL.value }]]),
    dynamicBackendModels: {},
    loadBackendModels: vi.fn(async () => undefined),
    anthropicApiKeyConfigured: null,
    ...overrides,
  };
}

// Track setSdkSessions calls for optimistic update verification
const mockSetSdkSessions = vi.fn();

vi.mock("../store.js", () => ({
  useStore: Object.assign(
    (selector: (s: MockStoreState) => unknown) => selector(storeState),
    {
      getState: () => ({
        ...storeState,
        setSdkSessions: mockSetSdkSessions,
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

  it("is hidden when backend is Codex", () => {
    // Codex does not support runtime model switching
    resetStore({
      sdkSessions: [
        { sessionId: "s1", model: "gpt-5.3-codex", backendType: "codex", cwd: "/repo" },
      ],
    });
    const { container } = render(<ModelSwitcher sessionId="s1" />);
    expect(container.innerHTML).toBe("");
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
      // Simulate focus actually landing in the listbox after rAF (jsdom
      // doesn't implement requestAnimationFrame's paint-tick exactly, so
      // call .focus() directly to model the post-rAF state).
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
    // Council Review 2026-06-04-0823 P2 #12 (a11y): footnote previously
    // rendered as a non-option <div> inside the role="listbox" container,
    // causing SR to iterate it as a phantom option. After the fix the
    // footnote is a sibling of the listbox div, so it does NOT appear via
    // within(listbox).queryByRole("link") and DOES appear via the wrapper.
    it("no-key footnote (<a> link) is NOT a descendant of role='listbox'", async () => {
      const { container } = render(<ModelSwitcher sessionId="s1" />);
      resetStore({ anthropicApiKeyConfigured: false });
      render(<ModelSwitcher sessionId="s1" />);
      fireEvent.click(screen.getAllByLabelText("Switch model")[0]!);
      const listbox = screen.getByRole("listbox");
      // The footnote link is in the document...
      expect(
        screen.getByRole("link", { name: /Add an API key in Settings/ }),
      ).toBeInTheDocument();
      // ...but NOT a descendant of the listbox div.
      expect(
        listbox.querySelector('a[href="#/settings"]'),
      ).toBeNull();
      void container;
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
