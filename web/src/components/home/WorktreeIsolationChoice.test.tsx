// @vitest-environment jsdom
/**
 * WorktreeIsolationChoice — the New Session opt-out for worktree isolation.
 *
 * Context: parallel agents sharing one working tree broke prod (a sibling's
 * `git add` swept up unfinished work; a sibling switched the branch of a
 * checkout a service runs from). When another LIVE session (Claude Code or
 * Codex) already uses the selected tree, isolation is the default and the
 * user must actively pick "Work in the same tree". A lone session must see
 * nothing (behaviour unchanged).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { WorktreeIsolationChoice } from "./WorktreeIsolationChoice.js";
import type { IsolationPreview } from "../../api.js";

function makePreview(overrides: Partial<IsolationPreview> = {}): IsolationPreview {
  return {
    isGitRepo: true,
    repoRoot: "/srv/my-repo",
    liveSessions: [{ sessionId: "abcdef1234567890", name: "Deploy fix", backendType: "codex" }],
    recommended: "isolate",
    worktreesBaseDir: "/home/u/.companion/worktrees",
    warnings: [],
    repoServiceUnits: [],
    ...overrides,
  };
}

describe("WorktreeIsolationChoice", () => {
  it("renders nothing while loading, for non-repos, and for a lone session", () => {
    // Single-session behaviour must stay unchanged: no extra UI at all.
    const onChange = vi.fn();
    const { container, rerender } = render(
      <WorktreeIsolationChoice preview={null} choice="isolate" onChange={onChange} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(
      <WorktreeIsolationChoice preview={makePreview({ isGitRepo: false })} choice="isolate" onChange={onChange} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(
      <WorktreeIsolationChoice preview={makePreview({ liveSessions: [] })} choice="isolate" onChange={onChange} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the sibling names, target dir and both options with isolate checked", () => {
    render(<WorktreeIsolationChoice preview={makePreview()} choice="isolate" onChange={vi.fn()} />);
    expect(screen.getByText(/another live session is already working in this tree/i)).toBeInTheDocument();
    expect(screen.getByText("Deploy fix")).toBeInTheDocument();
    // The worktree target (base dir + repo name) is shown so the path is not a surprise.
    expect(screen.getByText("/home/u/.companion/worktrees/my-repo/")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /isolated worktree/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /work in the same tree/i })).not.toBeChecked();
  });

  it("falls back to a short session id and summarises more than 3 siblings", () => {
    const liveSessions = [
      { sessionId: "1111111122222222" },
      { sessionId: "b", name: "B" },
      { sessionId: "c", name: "C" },
      { sessionId: "d", name: "D" },
    ];
    render(<WorktreeIsolationChoice preview={makePreview({ liveSessions })} choice="isolate" onChange={vi.fn()} />);
    expect(screen.getByText(/4 live sessions are already working in this tree/i)).toBeInTheDocument();
    expect(screen.getByText(/11111111, B, C \+1/)).toBeInTheDocument();
  });

  it("calls onChange when the user opts out and back in", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <WorktreeIsolationChoice preview={makePreview()} choice="isolate" onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /work in the same tree/i }));
    expect(onChange).toHaveBeenLastCalledWith("shared");
    rerender(<WorktreeIsolationChoice preview={makePreview()} choice="shared" onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: /isolated worktree/i }));
    expect(onChange).toHaveBeenLastCalledWith("isolate");
  });

  it("names systemd units running from the tree and surfaces server warnings as alerts", () => {
    // Safety rail: the user is warned before a worktree is created for a
    // tree a service runs from, or inside a service's directory.
    render(
      <WorktreeIsolationChoice
        preview={makePreview({
          repoServiceUnits: ["aura-companion.service"],
          warnings: ["Worktrees would be created inside /srv, which systemd service x.service runs from."],
        })}
        choice="isolate"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/systemd service aura-companion\.service runs from this tree/i)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/x\.service/);
  });

  it("shows the reason instead of options when isolation does not apply (council pair)", () => {
    render(
      <WorktreeIsolationChoice
        preview={makePreview()}
        choice="isolate"
        onChange={vi.fn()}
        disabledReason="Council pairs share one workspace by design."
      />,
    );
    expect(screen.getByText(/council pairs share one workspace/i)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("passes axe accessibility checks (with warnings rendered)", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <WorktreeIsolationChoice
        preview={makePreview({ repoServiceUnits: ["a.service"], warnings: ["warn"] })}
        choice="isolate"
        onChange={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
