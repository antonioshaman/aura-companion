// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ComponentProps } from "react";
import { SessionItem } from "./SessionItem.js";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";

function makeSession(overrides: Partial<SessionItemType> = {}): SessionItemType {
  return {
    id: "session-1",
    model: "claude-sonnet-4-6",
    cwd: "/workspace/app",
    gitBranch: "",
    isContainerized: false,
    gitAhead: 0,
    gitBehind: 0,
    linesAdded: 0,
    linesRemoved: 0,
    isConnected: true,
    isReconnecting: false,
    status: "running",
    sdkState: "connected",
    createdAt: Date.now(),
    archived: false,
    permCount: 0,
    backendType: "claude",
    repoRoot: "/workspace/app",
    cronJobId: undefined,
    ...overrides,
  };
}

function buildProps(overrides: Partial<ComponentProps<typeof SessionItem>> = {}): ComponentProps<typeof SessionItem> {
  return {
    session: makeSession(),
    isActive: false,
    isArchived: false,
    sessionName: undefined,
    permCount: 0,
    isRecentlyRenamed: false,
    onSelect: vi.fn(),
    onStartRename: vi.fn(),
    onArchive: vi.fn(),
    onUnarchive: vi.fn(),
    onDelete: vi.fn(),
    onClearRecentlyRenamed: vi.fn(),
    editingSessionId: null,
    editingName: "",
    setEditingName: vi.fn(),
    onConfirmRename: vi.fn(),
    onCancelRename: vi.fn(),
    editInputRef: { current: null },
    ...overrides,
  };
}

describe("SessionItem", () => {
  it("renders the session label and cwd", () => {
    // Validates the primary row content users rely on to identify sessions.
    render(<SessionItem {...buildProps()} />);

    expect(screen.getByText("claude-sonnet-4-6")).toBeInTheDocument();
    expect(screen.getByText("/workspace/app")).toBeInTheDocument();
  });

  it("renders the Docker logo asset when session is containerized", () => {
    // Regression guard for THE-195: keep using the transparent Docker logo asset.
    render(<SessionItem {...buildProps({ session: makeSession({ isContainerized: true }) })} />);

    expect(screen.getByTitle("Docker")).toBeInTheDocument();
    const dockerLogo = screen.getByAltText("Docker logo");
    expect(dockerLogo).toHaveAttribute("src", "/logo-docker.svg");
  });

  it("enters rename flow on double-click", () => {
    // Confirms the interaction contract used by Sidebar for inline rename.
    const onStartRename = vi.fn();
    render(<SessionItem {...buildProps({ onStartRename })} />);

    fireEvent.doubleClick(screen.getByRole("button", { name: /claude-sonnet-4-6/i }));

    expect(onStartRename).toHaveBeenCalledWith("session-1", "claude-sonnet-4-6");
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<SessionItem {...buildProps()} />);

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // --- Status dot rendering ---

  it("shows running status dot when session is running and connected", () => {
    // Ensures the animated success dot appears for actively running sessions.
    const { container } = render(<SessionItem {...buildProps()} />);
    expect(container.querySelector(".bg-cc-success")).toBeTruthy();
  });

  it("shows awaiting status dot when session has pending permissions", () => {
    // Verifies the warning dot appears when permissions need approval.
    const { container } = render(
      <SessionItem {...buildProps({ session: makeSession({ permCount: 2 }), permCount: 2 })} />,
    );
    expect(container.querySelector(".bg-cc-warning")).toBeTruthy();
  });

  it("shows idle status dot when connected but not running", () => {
    // Idle sessions should show a muted dot.
    const { container } = render(
      <SessionItem {...buildProps({ session: makeSession({ status: "idle" }) })} />,
    );
    expect(container.querySelector(".bg-cc-muted\\/40")).toBeTruthy();
  });

  it("shows exited status dot when not connected", () => {
    // Disconnected sessions show an outlined ring instead of a filled dot.
    const { container } = render(
      <SessionItem {...buildProps({ session: makeSession({ isConnected: false }) })} />,
    );
    expect(container.querySelector(".border-cc-muted\\/25")).toBeTruthy();
  });

  // --- Backend badge ---

  it("shows Codex badge for codex backend type", () => {
    // The CX badge distinguishes Codex sessions from Claude Code.
    render(<SessionItem {...buildProps({ session: makeSession({ backendType: "codex" }) })} />);
    expect(screen.getByText("CX")).toBeInTheDocument();
  });

  it("shows CC badge for claude backend type", () => {
    render(<SessionItem {...buildProps()} />);
    expect(screen.getByText("CC")).toBeInTheDocument();
  });

  // --- Cron badge ---

  it("shows scheduled badge when session has a cronJobId", () => {
    render(<SessionItem {...buildProps({ session: makeSession({ cronJobId: "cron-123" }) })} />);
    expect(screen.getByTitle("Scheduled")).toBeInTheDocument();
  });

  // --- Active state styling ---

  it("applies active background class when isActive is true", () => {
    // The active session should have a visually distinct background.
    const { container } = render(<SessionItem {...buildProps({ isActive: true })} />);
    const btn = container.querySelector("button");
    expect(btn?.className).toContain("bg-cc-active");
  });

  // --- F2 shortcut ---

  it("triggers rename on F2 keypress", () => {
    // F2 is a standard shortcut for rename in file managers.
    const onStartRename = vi.fn();
    render(<SessionItem {...buildProps({ onStartRename })} />);

    const btn = screen.getByRole("button", { name: /claude-sonnet-4-6/i });
    fireEvent.keyDown(btn, { key: "F2" });

    expect(onStartRename).toHaveBeenCalledWith("session-1", "claude-sonnet-4-6");
  });

  // --- Editing mode ---

  it("shows input when in editing mode and handles Enter to confirm", () => {
    // Editing mode replaces the label with an input; Enter confirms the rename.
    const onConfirmRename = vi.fn();
    render(
      <SessionItem
        {...buildProps({
          editingSessionId: "session-1",
          editingName: "new name",
          onConfirmRename,
        })}
      />,
    );

    const input = screen.getByDisplayValue("new name");
    expect(input).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirmRename).toHaveBeenCalled();
  });

  it("handles Escape in editing mode to cancel rename", () => {
    // Escape aborts the rename without saving changes.
    const onCancelRename = vi.fn();
    render(
      <SessionItem
        {...buildProps({
          editingSessionId: "session-1",
          editingName: "new name",
          onCancelRename,
        })}
      />,
    );

    const input = screen.getByDisplayValue("new name");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancelRename).toHaveBeenCalled();
  });

  it("calls setEditingName on input change", () => {
    // Verifies two-way binding of the editing input.
    const setEditingName = vi.fn();
    render(
      <SessionItem
        {...buildProps({
          editingSessionId: "session-1",
          editingName: "old",
          setEditingName,
        })}
      />,
    );

    fireEvent.change(screen.getByDisplayValue("old"), { target: { value: "new" } });
    expect(setEditingName).toHaveBeenCalledWith("new");
  });

  // --- Context menu ---

  it("opens and closes context menu via three-dot button", () => {
    // The menu toggle should show/hide the dropdown.
    render(<SessionItem {...buildProps()} />);

    const menuBtn = screen.getByTitle("Session actions");
    fireEvent.click(menuBtn);

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("Archive")).toBeInTheDocument();
  });

  it("shows Restore and Delete for archived sessions", () => {
    // Archived items have a different menu: Restore + Delete instead of Rename + Archive.
    render(<SessionItem {...buildProps({ isArchived: true })} />);

    fireEvent.click(screen.getByTitle("Session actions"));

    expect(screen.getByText("Restore")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
    expect(screen.queryByText("Rename")).not.toBeInTheDocument();
  });

  it("calls onArchive when Archive menu item is clicked", () => {
    // Verifies the archive action wiring in the context menu.
    const onArchive = vi.fn();
    render(<SessionItem {...buildProps({ onArchive })} />);

    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Archive"));

    expect(onArchive).toHaveBeenCalled();
  });

  it("calls onUnarchive when Restore menu item is clicked", () => {
    const onUnarchive = vi.fn();
    render(<SessionItem {...buildProps({ isArchived: true, onUnarchive })} />);

    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Restore"));

    expect(onUnarchive).toHaveBeenCalled();
  });

  it("calls onDelete when Delete menu item is clicked", () => {
    const onDelete = vi.fn();
    render(<SessionItem {...buildProps({ isArchived: true, onDelete })} />);

    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Delete"));

    expect(onDelete).toHaveBeenCalled();
  });

  it("calls onStartRename when Rename menu item is clicked", () => {
    const onStartRename = vi.fn();
    render(<SessionItem {...buildProps({ onStartRename })} />);

    fireEvent.click(screen.getByTitle("Session actions"));
    fireEvent.click(screen.getByText("Rename"));

    expect(onStartRename).toHaveBeenCalledWith("session-1", "claude-sonnet-4-6");
  });

  // --- Keyboard navigation in menu ---

  it("closes menu on Escape key", () => {
    // Per ARIA menu pattern, Escape must dismiss the menu.
    render(<SessionItem {...buildProps()} />);

    fireEvent.click(screen.getByTitle("Session actions"));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes menu on Tab key per ARIA authoring practices", () => {
    // Tab must close the menu and return focus to trigger (Greptile feedback).
    render(<SessionItem {...buildProps()} />);

    fireEvent.click(screen.getByTitle("Session actions"));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    act(() => {
      fireEvent.keyDown(document, { key: "Tab" });
    });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  // --- Label fallback ---

  it("falls back to short ID when no session name or model", () => {
    // When sessionName and model are absent, the 8-char session ID prefix is shown.
    render(
      <SessionItem
        {...buildProps({
          session: makeSession({ id: "abcdef1234567890", model: "" }),
          sessionName: undefined,
        })}
      />,
    );

    expect(screen.getByText("abcdef12")).toBeInTheDocument();
  });

  it("prefers sessionName over model", () => {
    // An explicit session name takes priority over the model name.
    render(<SessionItem {...buildProps({ sessionName: "My Custom Name" })} />);
    expect(screen.getByText("My Custom Name")).toBeInTheDocument();
  });

  // --- Archive hover button ---

  it("shows archive hover button for non-archived sessions", () => {
    // The quick-archive button appears on hover for active sessions.
    render(<SessionItem {...buildProps()} />);
    expect(screen.getByTitle("Archive")).toBeInTheDocument();
  });

  it("hides archive hover button for archived sessions", () => {
    // Archived sessions shouldn't show the archive shortcut button.
    render(<SessionItem {...buildProps({ isArchived: true })} />);
    expect(screen.queryByTitle("Archive")).not.toBeInTheDocument();
  });

  // --- Recently renamed animation ---

  it("applies name-appear animation for recently renamed sessions", () => {
    // The label gets a reveal animation after being renamed.
    const { container } = render(
      <SessionItem {...buildProps({ isRecentlyRenamed: true })} />,
    );

    const label = container.querySelector(".animate-name-appear");
    expect(label).toBeTruthy();
  });

  // --- Archived forces exited status ---

  it("forces exited status when isArchived is true regardless of session state", () => {
    // Archived sessions always show as exited even if technically connected.
    const { container } = render(
      <SessionItem
        {...buildProps({
          isArchived: true,
          session: makeSession({ isConnected: true, status: "running" }),
        })}
      />,
    );
    // Should show exited dot (border only, no fill)
    expect(container.querySelector(".border-cc-muted\\/25")).toBeTruthy();
  });

  // --- Click outside closes menu ---

  it("closes menu when clicking outside", () => {
    // Clicking outside the menu and button should dismiss the dropdown.
    const { container } = render(<SessionItem {...buildProps()} />);

    fireEvent.click(screen.getByTitle("Session actions"));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // Click on the root container (outside menu and button)
    act(() => {
      fireEvent.mouseDown(container);
    });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  // --- onSelect click ---

  it("calls onSelect when session button is clicked", () => {
    // Single click navigates to the session.
    const onSelect = vi.fn();
    render(<SessionItem {...buildProps({ onSelect })} />);

    fireEvent.click(screen.getByRole("button", { name: /claude-sonnet-4-6/i }));

    expect(onSelect).toHaveBeenCalledWith("session-1");
  });

  // --- Archive hover button fires callback ---

  it("calls onArchive when archive hover button is clicked", () => {
    // The quick-archive button in the hover area should fire the callback.
    const onArchive = vi.fn();
    render(<SessionItem {...buildProps({ onArchive })} />);

    fireEvent.click(screen.getByTitle("Archive"));

    expect(onArchive).toHaveBeenCalled();
  });

  // --- Editing input onBlur ---

  it("calls onConfirmRename on input blur", () => {
    // Blurring the rename input should confirm the rename.
    const onConfirmRename = vi.fn();
    render(
      <SessionItem
        {...buildProps({
          editingSessionId: "session-1",
          editingName: "test",
          onConfirmRename,
        })}
      />,
    );

    fireEvent.blur(screen.getByDisplayValue("test"));
    expect(onConfirmRename).toHaveBeenCalled();
  });

  // --- Arrow key navigation in menu ---

  it("navigates menu items with ArrowDown when focus is inside menu", () => {
    // ArrowDown should move focus to the next menu item.
    render(<SessionItem {...buildProps()} />);

    fireEvent.click(screen.getByTitle("Session actions"));
    const menu = screen.getByRole("menu");
    const items = menu.querySelectorAll("[role='menuitem']");

    // Focus the first item
    act(() => {
      (items[0] as HTMLElement).focus();
    });

    act(() => {
      fireEvent.keyDown(document, { key: "ArrowDown" });
    });

    // Focus should move to the second item
    expect(document.activeElement).toBe(items[1]);
  });

  it("navigates menu items with ArrowUp when focus is inside menu", () => {
    // ArrowUp should move focus to the previous menu item.
    render(<SessionItem {...buildProps()} />);

    fireEvent.click(screen.getByTitle("Session actions"));
    const menu = screen.getByRole("menu");
    const items = menu.querySelectorAll("[role='menuitem']");

    // Focus the second item
    act(() => {
      (items[1] as HTMLElement).focus();
    });

    act(() => {
      fireEvent.keyDown(document, { key: "ArrowUp" });
    });

    // Focus should move back to the first item
    expect(document.activeElement).toBe(items[0]);
  });

  // --- Menu toggle closes on second click ---

  it("closes menu on second click of the three-dot button", () => {
    // Clicking the menu button again should toggle the menu closed.
    render(<SessionItem {...buildProps()} />);

    const menuBtn = screen.getByTitle("Session actions");
    fireEvent.click(menuBtn);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.click(menuBtn);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  // --- Compacting status treated as running ---

  it("shows running dot when session status is compacting and connected", () => {
    // Compacting is functionally a running state from the user's perspective.
    const { container } = render(
      <SessionItem {...buildProps({ session: makeSession({ status: "compacting" }) })} />,
    );
    expect(container.querySelector(".bg-cc-success")).toBeTruthy();
  });

  // --- Council pairing chips (May 2026 UX feedback) ---

  it("hides ProviderBadges for homogeneous council pair (claude+claude)", () => {
    // The sidebar row is dense; rendering `CLAUDE + CLAUDE` for a homogeneous
    // pair adds no signal and crowds out the session name. The BackendBadge
    // already shows the orchestrator backend (CC) and the unread STOP counter
    // (when present) discriminates Council pairs from solo sessions. Trusting
    // both signals means the homogeneous-pair chip is pure noise → hide it.
    render(<SessionItem {...buildProps({ councilPairing: "claude+claude" })} />);
    expect(screen.queryByTestId("council-session-badge")).not.toBeInTheDocument();
  });

  it("shows ProviderBadges for asymmetric council pair (claude+codex)", () => {
    // Asymmetric pairings carry information the user reads from chip colours
    // (claude tint vs codex tint). The chip cluster is the ONLY in-sidebar
    // affordance that distinguishes a `claude+codex` pair from `claude+claude`,
    // so it must render — even at the cost of horizontal space.
    render(<SessionItem {...buildProps({ councilPairing: "claude+codex" })} />);
    expect(screen.getByTestId("council-session-badge")).toBeInTheDocument();
  });

  // --- Sidebar chip redundancy full suppression (TASK extends PR #27) ---
  //
  // The BackendBadge to the left of the chip cluster already shows the
  // orchestrator backend (CC / CX). Rendering a pair-half with the SAME
  // provider letters is pure visual duplication. The new helper
  // `pairHalvesAfterBackendCollapse` drops that redundant half so the
  // asymmetric `claude+codex` case renders a SINGLE chip carrying the
  // new-information half.

  it("renders a SINGLE chip (codex only) for claude+codex pair on Claude backend", () => {
    // backend=claude → CC badge already conveys claude → drop the CLAUDE
    // half of the pair → render just the CODEX chip. No "+" separator.
    render(
      <SessionItem
        {...buildProps({
          session: makeSession({ backendType: "claude" }),
          councilPairing: "claude+codex",
        })}
      />,
    );
    const badge = screen.getByTestId("council-session-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent(/codex/i);
    // Anti-assertion: no CLAUDE chip text inside the badge wrapper, and no
    // visible "+" separator (the latter is only present in two-chip
    // ProviderBadges rendering).
    expect(badge).not.toHaveTextContent(/claude/i);
    expect(badge.textContent).not.toContain("+");
  });

  it("renders a SINGLE chip (claude only) for claude+codex pair on Codex backend", () => {
    // Mirror case: backend=codex → CX badge already conveys codex → drop
    // the CODEX half → render just the CLAUDE chip.
    render(
      <SessionItem
        {...buildProps({
          session: makeSession({ backendType: "codex" }),
          councilPairing: "claude+codex",
        })}
      />,
    );
    const badge = screen.getByTestId("council-session-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent(/claude/i);
    expect(badge).not.toHaveTextContent(/codex/i);
    expect(badge.textContent).not.toContain("+");
  });

  it("still hides the chip cluster entirely for homogeneous pair on matching backend (PR #27 regression invariant)", () => {
    // The PR #27 behaviour ("hides ProviderBadges for homogeneous council
    // pair") must stay green — the new helper is a superset, not a
    // replacement. claude+claude on a Claude backend → both halves match
    // the backend → halves.length === 0 → render nothing.
    render(
      <SessionItem
        {...buildProps({
          session: makeSession({ backendType: "claude" }),
          councilPairing: "claude+claude",
        })}
      />,
    );
    expect(screen.queryByTestId("council-session-badge")).not.toBeInTheDocument();
  });

  it("hides the chip cluster for homogeneous codex pair on Codex backend (symmetric to claude+claude case)", () => {
    // Same logic on the Codex side — guards against a partial implementation
    // that only handles the claude+claude path.
    render(
      <SessionItem
        {...buildProps({
          session: makeSession({ backendType: "codex" }),
          councilPairing: "codex+codex",
        })}
      />,
    );
    expect(screen.queryByTestId("council-session-badge")).not.toBeInTheDocument();
  });

  it("renders name on row 1 above the metadata row (chip cluster + cwd)", () => {
    // Structural guard for the two-row layout (UX feedback May 2026). Pre-fix
    // the chip cluster was a direct child of the outer button's flex row,
    // competing horizontally with the name container and truncating names to
    // 1–2 characters. Post-fix the chip cluster lives inside a sibling row of
    // the name (within the inner column), so the name row gets the full inner
    // width. We assert the new placement by checking the chip is NOT a direct
    // child of the outer button — that's the canary against accidentally
    // collapsing the structure back to the old single-row layout.
    const { container } = render(
      <SessionItem
        {...buildProps({
          sessionName: "Very long session name that would otherwise truncate",
          councilPairing: "claude+codex",
        })}
      />,
    );
    const nameSpan = screen.getByText("Very long session name that would otherwise truncate");
    const chipBadge = screen.getByTestId("council-session-badge");
    const outerButton = container.querySelector("button");
    expect(outerButton).toBeTruthy();
    // Both descend from the same outer button — sanity.
    expect(outerButton?.contains(nameSpan)).toBe(true);
    expect(outerButton?.contains(chipBadge)).toBe(true);
    // Chip cluster is NOT a direct child of the button (old layout had it as
    // a sibling of the name column). Direct children should be: accent edge,
    // status dot, column-container — three elements, none of which is the
    // chip cluster.
    const directChildren = Array.from(outerButton!.children);
    expect(directChildren).not.toContain(chipBadge.parentElement);
    expect(directChildren.includes(chipBadge)).toBe(false);
  });

  it("shows the unread STOP counter alongside the chip cluster regardless of pairing symmetry", () => {
    // The red blocker counter is the highest-priority signal — it must stay
    // visible whether or not the homogeneous-chip suppression applies.
    render(
      <SessionItem
        {...buildProps({
          councilPairing: "claude+claude",
          councilUnreadStops: 3,
        })}
      />,
    );
    expect(screen.getByTestId("council-unread-count")).toHaveTextContent("3");
    // And the chip suppression still applies.
    expect(screen.queryByTestId("council-session-badge")).not.toBeInTheDocument();
  });

  // --- Council role decoration (2026-05-15 Item 17) ---
  // ☼ orchestrator / ☽ observer glyph + " · {role}" suffix. The glyph is
  // aria-hidden; the suffix is the accessible text so screen readers don't
  // double-announce. Tests pin both the visible string and the a11y shape.

  it("renders the ☼ glyph and ' · orchestrator' suffix when councilRole is orchestrator", () => {
    render(<SessionItem {...buildProps({ councilRole: "orchestrator" })} />);
    const glyph = screen.getByTestId("council-role-glyph");
    expect(glyph.textContent).toBe("☼");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    const suffix = screen.getByTestId("council-role-suffix");
    expect(suffix.textContent).toBe(" · orchestrator");
  });

  it("renders the ☽ glyph and ' · observer' suffix when councilRole is observer", () => {
    render(<SessionItem {...buildProps({ councilRole: "observer" })} />);
    const glyph = screen.getByTestId("council-role-glyph");
    expect(glyph.textContent).toBe("☽");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    const suffix = screen.getByTestId("council-role-suffix");
    expect(suffix.textContent).toBe(" · observer");
  });

  it("does NOT render the glyph or suffix when councilRole is undefined (solo session)", () => {
    // Solo (non-council) sessions must not show role decoration — the data
    // shape allows undefined and the renderer must guard against it.
    render(<SessionItem {...buildProps()} />);
    expect(screen.queryByTestId("council-role-glyph")).not.toBeInTheDocument();
    expect(screen.queryByTestId("council-role-suffix")).not.toBeInTheDocument();
  });

  it("passes axe a11y checks with the role glyph + suffix rendered (orchestrator)", async () => {
    // The glyph carries no semantic info (aria-hidden); accessible name is
    // the suffix text. axe must not flag the decoration as inaccessible.
    const { axe } = await import("vitest-axe");
    const { container } = render(<SessionItem {...buildProps({ councilRole: "orchestrator" })} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe a11y checks with the role glyph + suffix rendered (observer)", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<SessionItem {...buildProps({ councilRole: "observer" })} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("preserves rename interaction (double-click) when council role is rendered", () => {
    // Interactive behaviour regression: adding decoration around the label
    // span must not break the rename-on-doubleclick contract Sidebar relies on.
    const onStartRename = vi.fn();
    render(<SessionItem {...buildProps({ councilRole: "orchestrator", onStartRename })} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: /claude-sonnet-4-6/i }));
    expect(onStartRename).toHaveBeenCalledWith("session-1", "claude-sonnet-4-6");
  });

  // ─── Continue-in-new-session menu item ───────────────────────────────────

  it("shows 'Continue in new session' menu item when onContinueInNew is provided", () => {
    // The action is additive — present only for active (non-archived)
    // sessions when the parent wires up a handler. Playground / test
    // harnesses that don't wire it must not see a no-op button (which
    // would invite mis-clicks during exploratory UI work).
    const onContinueInNew = vi.fn();
    render(<SessionItem {...buildProps({ onContinueInNew })} />);
    // Open the kebab menu
    fireEvent.click(screen.getByLabelText("Session actions"));
    expect(screen.getByText("Continue in new session")).toBeInTheDocument();
  });

  it("hides 'Continue in new session' when onContinueInNew is omitted (backwards-compat)", () => {
    // Playground / read-only renders pass no handler; the row must NOT
    // render the action at all in that case.
    render(<SessionItem {...buildProps({ onContinueInNew: undefined })} />);
    fireEvent.click(screen.getByLabelText("Session actions"));
    expect(screen.queryByText("Continue in new session")).not.toBeInTheDocument();
  });

  it("hides 'Continue in new session' on archived sessions (recovery only makes sense for live ones)", () => {
    // Archived sessions can't be wedged on a live API — re-spawning from
    // an archived handoff is a different (manual) workflow, so the action
    // is suppressed in the archived menu to avoid implying it's safe.
    const onContinueInNew = vi.fn();
    render(<SessionItem {...buildProps({ isArchived: true, onContinueInNew })} />);
    fireEvent.click(screen.getByLabelText("Session actions"));
    expect(screen.queryByText("Continue in new session")).not.toBeInTheDocument();
  });

  it("invokes onContinueInNew with the session id when the menu item is clicked", () => {
    const onContinueInNew = vi.fn();
    render(<SessionItem {...buildProps({ onContinueInNew })} />);
    fireEvent.click(screen.getByLabelText("Session actions"));
    fireEvent.click(screen.getByText("Continue in new session"));
    expect(onContinueInNew).toHaveBeenCalledTimes(1);
    expect(onContinueInNew.mock.calls[0][1]).toBe("session-1");
  });

  // ─── PLAN T12 (Phase G) — terminal CLI-failure glyph ─────────────────
  //
  // The cliFailedReason prop drives a destructive ✕ glyph next to the
  // status dot, distinct from the exited outline dot. Mutation-resistant:
  // a regression that swaps the destructive token for warning/yellow
  // trips the className assertion; a regression that drops the prop
  // mapping entirely trips the testid presence assertion.

  it("renders the destructive cli-failed glyph when cliFailedReason is set", () => {
    render(<SessionItem {...buildProps({ cliFailedReason: "relaunch_exhausted" })} />);
    const glyph = screen.getByTestId("session-item-cli-failed-glyph");
    expect(glyph).toBeInTheDocument();
    expect(glyph).toHaveAttribute("data-reason", "relaunch_exhausted");
    // Destructive token (cc-error) NOT warning - reverting to cc-warning fails.
    expect(glyph.className).toMatch(/cc-error/);
    expect(glyph.className).not.toMatch(/cc-warning/);
  });

  it("does NOT render the cli-failed glyph when cliFailedReason is absent", () => {
    render(<SessionItem {...buildProps()} />);
    expect(screen.queryByTestId("session-item-cli-failed-glyph")).toBeNull();
  });

  it("tooltip text comes from cliFailedCopy headline (operator hover discovery)", () => {
    render(<SessionItem {...buildProps({ cliFailedReason: "browser_closed_no_reconnect" })} />);
    const glyph = screen.getByTestId("session-item-cli-failed-glyph");
    expect(glyph).toHaveAttribute("title");
    expect(glyph.getAttribute("title")).toMatch(/you/i);
  });

  it("aria-label spells out the failure for screen readers", () => {
    render(<SessionItem {...buildProps({ cliFailedReason: "container_missing" })} />);
    const glyph = screen.getByTestId("session-item-cli-failed-glyph");
    expect(glyph.getAttribute("aria-label")).toMatch(/^Session failed:/);
  });

  it("passes axe scan with the cli-failed glyph rendered", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<SessionItem {...buildProps({ cliFailedReason: "container_stopped" })} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
