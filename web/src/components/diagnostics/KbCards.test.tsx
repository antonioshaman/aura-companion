// @vitest-environment jsdom
/**
 * Tests for the knowledge-base cards (plan Task 15).
 *
 * - Render + axe for the health card, the decision cards and the memory card.
 * - AC4: the KB card reads "3/10 entries · 7/25 sessions · due in ≤12 days".
 * - AC6: while an analysis runs, "Run analysis now" reads "running…", is
 *   aria-disabled (stays focusable), explains why, and a click calls nothing.
 * - Decision cards: Keep / Archive carry the entry id in their accessible
 *   name; Archive calls back with ("got-017", "archive"); "Mark for merge"
 *   opens a picker limited to the duplicate partner and Escape closes it;
 *   a posting card shows "archiving…" and ignores further clicks; a rejected
 *   decision shows its reason as an alert.
 * - AC9: the memory card offers only "Mark as seen" (one button per finding)
 *   and says it is read-only; when the setting is off it points to Settings.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { KbFindingsCard, KbHealthCard, MemoryReportCard } from "./KbCards.js";
import { kbStatus, NOW } from "./fixtures.js";

describe("KbHealthCard", () => {
  it("AC4: shows the accumulation string and passes axe", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<KbHealthCard status={kbStatus()} now={NOW} run={{ tag: "idle" }} onRun={vi.fn()} />);
    expect(screen.getByText("3/10 entries · 7/25 sessions · due in ≤12 days")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("AC6: running → 'running…', aria-disabled with a reason, click does nothing", async () => {
    const onRun = vi.fn();
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <KbHealthCard status={kbStatus({ inFlight: { runId: "r2", startedAt: NOW - 12_000, trigger: "manual", includeMemory: false } })} now={NOW} run={{ tag: "idle" }} onRun={onRun} />,
    );
    const btn = screen.getByRole("button", { name: "running…" });
    expect(btn).toHaveAttribute("aria-disabled", "true");
    expect(btn).toHaveAccessibleDescription(/already running, started \d\d:\d\d \(12s ago, manual\)/);
    btn.focus();
    fireEvent.click(btn);
    expect(onRun).not.toHaveBeenCalled();
    expect(btn).toHaveFocus();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("idle → click starts a KB run; the memory button appears only when enabled", () => {
    const onRun = vi.fn();
    const { rerender } = render(<KbHealthCard status={kbStatus()} now={NOW} run={{ tag: "idle" }} onRun={onRun} />);
    expect(screen.queryByRole("button", { name: "Run memory report" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run analysis now" }));
    expect(onRun).toHaveBeenCalledWith(false);
    rerender(<KbHealthCard status={kbStatus({ memoryReportEnabled: true })} now={NOW} run={{ tag: "idle" }} onRun={onRun} />);
    fireEvent.click(screen.getByRole("button", { name: "Run memory report" }));
    expect(onRun).toHaveBeenLastCalledWith(true);
  });

  it("an unreadable KB is an explicit unavailable state", () => {
    render(<KbHealthCard status={kbStatus({ health: null, progress: null })} now={NOW} run={{ tag: "idle" }} onRun={vi.fn()} />);
    expect(screen.getByText(/Source unavailable: the knowledge base/)).toBeInTheDocument();
  });
});

describe("KbFindingsCard", () => {
  it("renders decision cards, names buttons with the entry id, and passes axe", async () => {
    const { axe } = await import("vitest-axe");
    const onDecide = vi.fn();
    const { container } = render(<KbFindingsCard status={kbStatus()} findingUi={{}} onDecide={onDecide} />);
    expect(screen.getByText("2 of 2 findings need a decision.")).toBeInTheDocument();
    expect(screen.getByText(/109 days ≥ 30/)).toBeInTheDocument();
    expect(screen.getByText(/web\/gone\.ts \(missing\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Archive got-017" }));
    expect(onDecide).toHaveBeenCalledWith("got-017", "archive", undefined);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("merge picker offers only the duplicate partner; Escape closes it; Confirm posts the direction", () => {
    const onDecide = vi.fn();
    render(<KbFindingsCard status={kbStatus()} findingUi={{}} onDecide={onDecide} />);
    expect(screen.queryByRole("button", { name: "Mark for merge got-017" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mark for merge got-040" }));
    const select = screen.getByLabelText("Merge got-040 into");
    expect([...(select as HTMLSelectElement).options].map((o) => o.value)).toEqual(["got-041"]);
    fireEvent.keyDown(select, { key: "Escape" });
    expect(screen.queryByLabelText("Merge got-040 into")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mark for merge got-040" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onDecide).toHaveBeenCalledWith("got-040", "merge", "got-041");
  });

  it("a posting card says 'archiving…' and ignores clicks; a rejected one shows its reason", () => {
    const onDecide = vi.fn();
    const { rerender } = render(<KbFindingsCard status={kbStatus()} findingUi={{ "got-017": { tag: "posting", decision: "archive" } }} onDecide={onDecide} />);
    const btn = screen.getByRole("button", { name: "archiving… got-017" });
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole("button", { name: "Keep got-017" }));
    expect(onDecide).not.toHaveBeenCalled();
    rerender(<KbFindingsCard status={kbStatus()} findingUi={{ "got-017": { tag: "rejected", message: "The report changed — reloading." } }} onDecide={onDecide} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The report changed — reloading.");
  });

  it("a decided finding collapses to a decided row instead of vanishing", () => {
    render(<KbFindingsCard status={kbStatus({ decisions: { "got-017": { decision: "archive", ts: NOW } } })} findingUi={{}} onDecide={vi.fn()} />);
    expect(screen.getByText(/archived → \.agents\/knowledge\/archive\//)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive got-017" })).toBeNull();
  });

  it("no report yet is explained", () => {
    render(<KbFindingsCard status={kbStatus({ report: null })} findingUi={{}} onDecide={vi.fn()} />);
    expect(screen.getByText(/No report yet/)).toBeInTheDocument();
  });
});

describe("MemoryReportCard", () => {
  const withMemory = () => {
    const s = kbStatus({ memoryReportEnabled: true });
    if (s.report?.status === "available") {
      s.report.data.memory = {
        fileCount: 471,
        truncated: false,
        findings: [
          { findingId: "mem:feedback_a.md", file: "feedback_a.md", name: "a", description: "Badge gone", signals: [{ signal: "duplicate", criterion: "same", partnerFile: "feedback_b.md" }] },
          { findingId: "mem:feedback_b.md", file: "feedback_b.md", name: "b", description: "Badge gone", signals: [{ signal: "duplicate", criterion: "same", partnerFile: "feedback_a.md" }] },
        ],
      };
    }
    return s;
  };

  it("AC9: only 'Mark as seen', one per finding, framed read-only, axe-clean", async () => {
    const { axe } = await import("vitest-axe");
    const onSeen = vi.fn();
    const { container } = render(<MemoryReportCard status={withMemory()} findingUi={{}} onSeen={onSeen} />);
    expect(screen.getByRole("heading", { name: /read-only; Aura never writes to memory files/ })).toBeInTheDocument();
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Mark as seen feedback_a.md", "Mark as seen feedback_b.md"]);
    fireEvent.click(screen.getByRole("button", { name: "Mark as seen feedback_a.md" }));
    expect(onSeen).toHaveBeenCalledWith("mem:feedback_a.md");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("when the setting is off it points to Settings and offers no button", () => {
    render(<MemoryReportCard status={kbStatus()} findingUi={{}} onSeen={vi.fn()} />);
    expect(screen.getByText(/The memory report is off/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
