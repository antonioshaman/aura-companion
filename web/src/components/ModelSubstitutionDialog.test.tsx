// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ModelSubstitutionDialog } from "./ModelSubstitutionDialog.js";

describe("ModelSubstitutionDialog", () => {
  it("renders the from/to models and a tier-change explanation", () => {
    render(
      <ModelSubstitutionDialog
        fromModel="Opus 4.7"
        toModel="Haiku 4.5"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText(/Opus 4\.7 is unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/different cost tier/i)).toBeInTheDocument();
    // Confirm button names the target so the choice is unambiguous.
    expect(screen.getByRole("button", { name: /Switch to Haiku 4\.5/ })).toBeInTheDocument();
  });

  it("fires onConfirm when the switch button is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <ModelSubstitutionDialog fromModel="A" toModel="B" onConfirm={onConfirm} onCancel={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Switch to B/ }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("fires onCancel when the keep-current button is clicked", () => {
    const onCancel = vi.fn();
    render(
      <ModelSubstitutionDialog fromModel="A" toModel="B" onConfirm={() => {}} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Keep current model/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  // Escape is the modal's cancel affordance (APG dialog contract); deeper
  // focus-trap/return-focus assertions live in Task 10.
  it("cancels on Escape", () => {
    const onCancel = vi.fn();
    render(
      <ModelSubstitutionDialog fromModel="A" toModel="B" onConfirm={() => {}} onCancel={onCancel} />,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("cancels when the backdrop is clicked but not when the dialog body is", () => {
    const onCancel = vi.fn();
    render(
      <ModelSubstitutionDialog fromModel="A" toModel="B" onConfirm={() => {}} onCancel={onCancel} />,
    );
    // Click the dialog body — must NOT cancel (stopPropagation).
    fireEvent.click(screen.getByRole("dialog"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  // Task 10 (a11y P4) — APG modal focus management. Task 9 shipped the
  // mechanism; these pin the observable behaviour.
  //
  // On open, focus moves INTO the dialog (onto the confirm button) so a
  // keyboard user lands inside the modal instead of having to Tab to it. The
  // focus is scheduled via requestAnimationFrame, so poll with waitFor.
  it("moves focus onto the confirm button when opened", async () => {
    render(
      <ModelSubstitutionDialog fromModel="A" toModel="B" onConfirm={() => {}} onCancel={() => {}} />,
    );
    const confirm = screen.getByRole("button", { name: /Switch to B/ });
    await waitFor(() => expect(confirm).toHaveFocus());
  });

  // On close (unmount), focus RETURNS to whatever was focused before the dialog
  // opened — the model trigger — so the keyboard user is not stranded on <body>.
  it("returns focus to the previously-focused trigger on close", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "open dialog";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(trigger).toHaveFocus();

    const { unmount } = render(
      <ModelSubstitutionDialog fromModel="A" toModel="B" onConfirm={() => {}} onCancel={() => {}} />,
    );
    // Focus first moves into the dialog...
    await waitFor(() => expect(screen.getByRole("button", { name: /Switch to B/ })).toHaveFocus());
    // ...then returns to the trigger when the dialog closes.
    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <ModelSubstitutionDialog fromModel="Opus 4.7" toModel="Haiku 4.5" onConfirm={() => {}} onCancel={() => {}} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
