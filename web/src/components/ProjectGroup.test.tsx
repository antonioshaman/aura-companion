// @vitest-environment jsdom
//
// Component test for `ProjectGroup`. PR #68 modified this component (widened
// `getCouncilInfo` signature to include `role`; spread `councilRole` to
// SessionItem). CLAUDE.md mandates: "Every new or modified frontend component
// in `web/src/components/` must have an accompanying `.test.tsx` file with at
// minimum: a render test, an axe accessibility scan (`toHaveNoViolations()`),
// and tests for any interactive behavior." This file closes that gap and
// pins the council-role plumbing as a structural invariant — a future
// regression that drops the `councilRole` prop spread (same bug class PR #68
// exists to fix) would trip these tests at the component-scoped layer, faster
// than the wider integration test in `glyph-after-reload.test.tsx`.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { createRef } from "react";

import { ProjectGroup } from "./ProjectGroup.js";
import type { ProjectGroup as ProjectGroupType, SessionItem as SessionItemType } from "../utils/project-grouping.js";

function makeSessionItem(id: string, overrides: Partial<SessionItemType> = {}): SessionItemType {
  return {
    id,
    model: "claude-sonnet-4-6",
    cwd: "/work/repo",
    gitBranch: "",
    isContainerized: false,
    gitAhead: 0,
    gitBehind: 0,
    linesAdded: 0,
    linesRemoved: 0,
    isConnected: true,
    isReconnecting: false,
    status: null,
    sdkState: "connected",
    createdAt: Date.now(),
    archived: false,
    backendType: "claude",
    repoRoot: "",
    permCount: 0,
    ...overrides,
  };
}

function makeGroup(sessions: SessionItemType[]): ProjectGroupType {
  return {
    key: "/work/repo",
    label: "repo",
    sessions,
    runningCount: 0,
    permCount: 0,
    mostRecentActivity: Date.now(),
  };
}

function makeProps(overrides: Partial<Parameters<typeof ProjectGroup>[0]> = {}) {
  const group = makeGroup([makeSessionItem("orch_pg"), makeSessionItem("obs_pg")]);
  const editInputRef = createRef<HTMLInputElement>();
  return {
    group,
    isCollapsed: false,
    onToggleCollapse: vi.fn(),
    currentSessionId: null,
    sessionNames: new Map<string, string>(),
    pendingPermissions: new Map<string, Map<string, unknown>>(),
    recentlyRenamed: new Set<string>(),
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
    editInputRef,
    isFirst: true,
    ...overrides,
  };
}

describe("ProjectGroup", () => {
  // ── Render ────────────────────────────────────────────────────────────────

  it("renders the project label and session count in the collapsible header", () => {
    render(<ProjectGroup {...makeProps()} />);
    expect(screen.getByText("repo")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders one SessionItem per session in the group when expanded", () => {
    render(<ProjectGroup {...makeProps()} />);
    // SessionItem renders the model name as the row label (default fallback);
    // two sessions → two rendered model labels.
    const modelLabels = screen.getAllByText("claude-sonnet-4-6");
    expect(modelLabels).toHaveLength(2);
  });

  it("collapses the session list when `isCollapsed` is true", () => {
    render(<ProjectGroup {...makeProps({ isCollapsed: true })} />);
    // Collapsed preview shows the first 2 session model fallbacks joined by ", "
    expect(screen.getByText(/claude-sonnet-4-6, claude-sonnet-4-6/)).toBeInTheDocument();
    // No SessionItem rows render when collapsed.
    expect(screen.queryAllByTestId("council-role-glyph")).toHaveLength(0);
  });

  // ── Interactive behavior ──────────────────────────────────────────────────

  it("calls onToggleCollapse with the group key when the header is clicked", () => {
    const onToggleCollapse = vi.fn();
    render(<ProjectGroup {...makeProps({ onToggleCollapse })} />);
    const header = screen.getByRole("button", { expanded: true });
    fireEvent.click(header);
    expect(onToggleCollapse).toHaveBeenCalledWith("/work/repo");
  });

  // ── Council role plumbing (PR #68 contract) ───────────────────────────────
  //
  // The PR widened the `getCouncilInfo` callback's return type to include
  // `role` and now spreads `councilRole={council.role}` to SessionItem. These
  // tests pin that contract — if a future refactor drops the `councilRole`
  // spread (same bug class this PR closes), the glyph + suffix branches in
  // SessionItem stop firing and these tests trip immediately.

  it("forwards `role: orchestrator` from getCouncilInfo through to SessionItem (☼ glyph + suffix rendered)", () => {
    const getCouncilInfo = vi.fn((id: string) => {
      if (id === "orch_pg") return { pairing: "claude+codex", unreadStops: 0, role: "orchestrator" as const };
      if (id === "obs_pg") return { pairing: "claude+codex", unreadStops: 0, role: "observer" as const };
      return {};
    });
    render(<ProjectGroup {...makeProps({ getCouncilInfo })} />);
    const glyphs = screen.getAllByTestId("council-role-glyph");
    expect(glyphs).toHaveLength(2);
    const glyphTexts = glyphs.map((el) => el.textContent).sort();
    expect(glyphTexts).toEqual(["☼", "☽"]);
    // Accessible-text channel: the role suffix carries the announce.
    expect(screen.getByText(/· orchestrator/)).toBeInTheDocument();
    expect(screen.getByText(/· observer/)).toBeInTheDocument();
  });

  it("does NOT render the glyph + suffix when getCouncilInfo returns no role (solo-session case)", () => {
    // Regression canary for the original PR #68 bug shape: the callback was
    // typed without `role` and never spread. With no role on the return
    // object, the SessionItem's conditional branches must skip the glyph
    // and suffix entirely.
    const getCouncilInfo = vi.fn(() => ({ pairing: undefined, unreadStops: undefined, role: undefined }));
    render(<ProjectGroup {...makeProps({ getCouncilInfo })} />);
    expect(screen.queryAllByTestId("council-role-glyph")).toHaveLength(0);
    expect(screen.queryAllByTestId("council-role-suffix")).toHaveLength(0);
  });

  it("renders nothing council-related when getCouncilInfo is omitted entirely", () => {
    // Tests the optional-callback path — many consumers (cron sessions,
    // archived sessions, solo sessions) call ProjectGroup without
    // getCouncilInfo. The default `{}` fallback at line 112 must produce
    // an undefined role.
    render(<ProjectGroup {...makeProps()} />);
    expect(screen.queryAllByTestId("council-role-glyph")).toHaveLength(0);
    expect(screen.queryAllByTestId("council-role-suffix")).toHaveLength(0);
  });

  // ── Accessibility ─────────────────────────────────────────────────────────

  it("passes axe accessibility checks in the expanded council-role state", async () => {
    const { axe } = await import("vitest-axe");
    const getCouncilInfo = vi.fn((id: string) => {
      if (id === "orch_pg") return { pairing: "claude+codex", unreadStops: 0, role: "orchestrator" as const };
      if (id === "obs_pg") return { pairing: "claude+codex", unreadStops: 0, role: "observer" as const };
      return {};
    });
    const { container } = render(<ProjectGroup {...makeProps({ getCouncilInfo })} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
