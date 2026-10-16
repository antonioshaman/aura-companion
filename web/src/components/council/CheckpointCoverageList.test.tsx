// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CheckpointCoverageList } from "./CheckpointCoverageList.js";
import type { BrowserCheckpointCoverageGap } from "../../types.js";

// Observer rigor (2026-10-16): a checkpoint with no review (prod grp_1af4cd
// plan-147) or only an unverified empty one (checkpoint 148) must be listed
// explicitly — "без ревью" / "не проверено" — never look like silence or a
// clean pass.
const gaps: BrowserCheckpointCoverageGap[] = [
  { checkpointId: "council-plan-147", phase: "council-plan", sequence: 147, kind: "unreviewed", reason: "degraded" },
  { checkpointId: "council-review-148", phase: "council-review", sequence: 148, kind: "unverified" },
];

describe("CheckpointCoverageList", () => {
  it("renders nothing when every checkpoint is covered", () => {
    const { container } = render(<CheckpointCoverageList gaps={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("labels each gap with its kind, newest first, and explains why", () => {
    render(<CheckpointCoverageList gaps={gaps} />);
    const items = screen.getAllByTestId("checkpoint-coverage-item");
    expect(items.map((i) => i.getAttribute("data-kind"))).toEqual(["unverified", "unreviewed"]);
    expect(items[0]).toHaveTextContent("не проверено");
    expect(items[0]).toHaveTextContent("council-review-148");
    expect(items[1]).toHaveTextContent("без ревью");
    expect(items[1]).toHaveAttribute("data-reason", "degraded");
    expect(items[1].getAttribute("title")).toMatch(/деградировала/);
    expect(screen.getByRole("region", { name: /Чекпоинты без проверенного ревью/ })).toHaveTextContent("1 без ревью · 1 не проверено");
  });

  it("collapses to three rows and expands / collapses on toggle", () => {
    const many: BrowserCheckpointCoverageGap[] = Array.from({ length: 5 }, (_, i) => ({
      checkpointId: `c-${i}`, phase: "council-plan", sequence: i, kind: "unreviewed", reason: "superseded",
    }));
    render(<CheckpointCoverageList gaps={many} />);
    expect(screen.getAllByTestId("checkpoint-coverage-item")).toHaveLength(3);
    const toggle = screen.getByRole("button", { name: /Показать все \(5, ещё 2\)/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getAllByTestId("checkpoint-coverage-item")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Свернуть" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Свернуть" }));
    expect(screen.getAllByTestId("checkpoint-coverage-item")).toHaveLength(3);
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<CheckpointCoverageList gaps={gaps} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
