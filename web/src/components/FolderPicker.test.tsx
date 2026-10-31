import { useState } from "react";
// @vitest-environment jsdom
/**
 * Tests for FolderPicker component.
 *
 * Validates:
 * - Basic rendering (dialog role, aria attributes, header, close button)
 * - Accessibility (axe scan, aria-modal, aria-labels)
 * - Recent directories display and selection
 * - Directory listing after API resolves
 * - Loading skeleton state
 * - Error state with retry
 * - Breadcrumb navigation
 * - Manual path input mode
 * - Filter/search functionality
 * - Keyboard navigation (Escape to close, Enter to select)
 * - Close button and backdrop click
 * - Select current directory button
 * - Double-close guard (animateClose called twice)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Mock the API module
vi.mock("../api.js", () => ({
  api: {
    listDirs: vi.fn(),
  },
}));

// Mock recent-dirs utility
vi.mock("../utils/recent-dirs.js", () => ({
  getRecentDirs: vi.fn(() => []),
  addRecentDir: vi.fn(),
}));

import { api } from "../api.js";
import { getRecentDirs, addRecentDir } from "../utils/recent-dirs.js";
import { FolderPicker, looksLikeRepoUrl, repoNameFromUrl } from "./FolderPicker.js";

const mockListDirs = api.listDirs as ReturnType<typeof vi.fn>;
const mockGetRecentDirs = getRecentDirs as ReturnType<typeof vi.fn>;
const mockAddRecentDir = addRecentDir as ReturnType<typeof vi.fn>;

const defaultDirs = [
  { name: "src", path: "/home/user/project/src" },
  { name: "tests", path: "/home/user/project/tests" },
  { name: "docs", path: "/home/user/project/docs" },
];

function setup(props: Partial<Parameters<typeof FolderPicker>[0]> = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const result = render(
    <FolderPicker
      initialPath="/home/user/project"
      onSelect={onSelect}
      onClose={onClose}
      {...props}
    />,
  );
  return { onSelect, onClose, ...result };
}

beforeEach(() => {
  // jsdom doesn't implement scrollIntoView
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  mockListDirs.mockResolvedValue({
    path: "/home/user/project",
    dirs: defaultDirs,
    home: "/home/user",
  });
  mockGetRecentDirs.mockReturnValue([]);
});

describe("FolderPicker", () => {
  // ─── Rendering ──────────────────────────────────────────────────────────

  it("renders a dialog with correct ARIA attributes", async () => {
    // Validates the modal has role="dialog", aria-modal, and aria-label
    setup();

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-label", "Select folder");
  });

  it("renders the header with title and close button", async () => {
    // Validates the header shows "Select Folder" and has an accessible close button
    setup();

    expect(screen.getByText("Select Folder")).toBeInTheDocument();
    expect(screen.getByLabelText("Close")).toBeInTheDocument();
  });

  it("passes accessibility scan", async () => {
    // Runs axe accessibility checker to catch WCAG violations
    const { axe } = await import("vitest-axe");
    setup();

    // Wait for directories to load so the DOM is complete
    await waitFor(() => {
      expect(screen.getByText("src")).toBeInTheDocument();
    });

    const dialog = screen.getByRole("dialog");
    const results = await axe(dialog);
    expect(results).toHaveNoViolations();
  });

  // ─── Loading state ──────────────────────────────────────────────────────

  it("shows skeleton loading state while directories load", () => {
    // Validates shimmer skeletons appear before API resolves
    mockListDirs.mockReturnValue(new Promise(() => {})); // never resolves
    setup();

    expect(screen.getByLabelText("Loading directories")).toBeInTheDocument();
    expect(screen.getByLabelText("Loading directories")).toHaveAttribute("aria-busy", "true");
  });

  // ─── Directory listing ──────────────────────────────────────────────────

  it("renders directory list after loading", async () => {
    // Validates directories appear with their names after API resolves
    setup();

    await waitFor(() => {
      expect(screen.getByText("src")).toBeInTheDocument();
      expect(screen.getByText("tests")).toBeInTheDocument();
      expect(screen.getByText("docs")).toBeInTheDocument();
    });
  });

  it("shows empty state when no subdirectories exist", async () => {
    // Validates the "No subdirectories" message when dir list is empty
    mockListDirs.mockResolvedValue({
      path: "/home/user/empty",
      dirs: [],
      home: "/home/user",
    });
    setup();

    await waitFor(() => {
      expect(screen.getByText("No subdirectories")).toBeInTheDocument();
    });
  });

  // ─── Error state ────────────────────────────────────────────────────────

  it("shows error state with retry button when API fails", async () => {
    // Validates error message and retry button appear on API failure
    mockListDirs.mockRejectedValue(new Error("Network error"));
    setup();

    await waitFor(() => {
      expect(screen.getByText("Could not load directory")).toBeInTheDocument();
      expect(screen.getByText("Retry")).toBeInTheDocument();
    });
  });

  it("retries loading when retry button is clicked", async () => {
    // Validates that clicking Retry calls the API again
    mockListDirs.mockRejectedValueOnce(new Error("fail"));
    setup();

    await waitFor(() => {
      expect(screen.getByText("Retry")).toBeInTheDocument();
    });

    mockListDirs.mockResolvedValue({
      path: "/home/user/project",
      dirs: defaultDirs,
      home: "/home/user",
    });

    fireEvent.click(screen.getByText("Retry"));

    await waitFor(() => {
      expect(screen.getByText("src")).toBeInTheDocument();
    });
    // Called twice: initial load + retry
    expect(mockListDirs).toHaveBeenCalledTimes(2);
  });

  // ─── Recent directories ────────────────────────────────────────────────

  it("displays recent directories when available", async () => {
    // Validates recent dirs section renders with correct labels
    mockGetRecentDirs.mockReturnValue(["/home/user/recent-proj", "/tmp/other"]);
    setup();

    expect(screen.getByText("Recent")).toBeInTheDocument();
    expect(screen.getByText("recent-proj")).toBeInTheDocument();
    expect(screen.getByText("other")).toBeInTheDocument();
  });

  it("selects a recent directory on click", async () => {
    // Validates clicking a recent dir calls onSelect and addRecentDir
    mockGetRecentDirs.mockReturnValue(["/home/user/recent-proj"]);
    const { onSelect, onClose } = setup();

    fireEvent.click(screen.getByText("recent-proj"));

    expect(mockAddRecentDir).toHaveBeenCalledWith("/home/user/recent-proj");
    expect(onSelect).toHaveBeenCalledWith("/home/user/recent-proj");
    expect(onClose).toHaveBeenCalled();
  });

  // ─── Breadcrumb navigation ─────────────────────────────────────────────

  it("renders clickable breadcrumb segments", async () => {
    // Validates breadcrumb navigation shows path segments
    setup();

    await waitFor(() => {
      // Breadcrumb for /home/user/project should have a nav with segments
      const nav = screen.getByLabelText("Directory breadcrumb");
      expect(nav).toBeInTheDocument();
      expect(screen.getByText("/")).toBeInTheDocument();
      expect(screen.getByText("home")).toBeInTheDocument();
      expect(screen.getByText("user")).toBeInTheDocument();
      // "project" appears in both breadcrumb and select button — check within nav
      const projectInBreadcrumb = nav.querySelector('[aria-current="location"]');
      expect(projectInBreadcrumb).toBeInTheDocument();
      expect(projectInBreadcrumb?.textContent).toBe("project");
    });
  });

  it("navigates when clicking a breadcrumb segment", async () => {
    // Validates clicking a non-last breadcrumb segment calls loadDirs
    setup();

    await waitFor(() => {
      expect(screen.getByText("home")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("home"));

    expect(mockListDirs).toHaveBeenCalledWith("/home");
  });

  // ─── Filter/search ─────────────────────────────────────────────────────

  it("filters directories by name when typing in filter input", async () => {
    // Validates that typing in the filter input narrows the directory list
    setup();

    await waitFor(() => {
      expect(screen.getByText("src")).toBeInTheDocument();
    });

    const filterInput = screen.getByLabelText("Filter directories");
    fireEvent.change(filterInput, { target: { value: "sr" } });

    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.queryByText("tests")).not.toBeInTheDocument();
    expect(screen.queryByText("docs")).not.toBeInTheDocument();
  });

  it("shows 'No matching directories' with clear button when filter has no results", async () => {
    // Validates filter empty state with a way to clear the filter
    setup();

    await waitFor(() => {
      expect(screen.getByText("src")).toBeInTheDocument();
    });

    const filterInput = screen.getByLabelText("Filter directories");
    fireEvent.change(filterInput, { target: { value: "zzzzz" } });

    expect(screen.getByText("No matching directories")).toBeInTheDocument();
    expect(screen.getByText("Clear filter")).toBeInTheDocument();
  });

  // ─── Navigation into directories ────────────────────────────────────────

  it("navigates into a directory on click", async () => {
    // Validates clicking a directory entry calls loadDirs with that path
    setup();

    await waitFor(() => {
      expect(screen.getByText("src")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Navigate into src"));

    expect(mockListDirs).toHaveBeenCalledWith("/home/user/project/src");
  });

  // ─── Select directory ───────────────────────────────────────────────────

  it("selects a directory via the checkmark button", async () => {
    // Validates the explicit select button calls onSelect with the directory path
    const { onSelect } = setup();

    await waitFor(() => {
      expect(screen.getByText("src")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Select src"));

    expect(mockAddRecentDir).toHaveBeenCalledWith("/home/user/project/src");
    expect(onSelect).toHaveBeenCalledWith("/home/user/project/src");
  });

  it("selects current directory via the primary select button", async () => {
    // Validates the prominent "Select <dirname>" button works
    const { onSelect } = setup();

    await waitFor(() => {
      expect(screen.getByText("src")).toBeInTheDocument();
    });

    // The primary select button has an aria-label "Select project"
    const selectBtn = screen.getByLabelText("Select project");
    fireEvent.click(selectBtn);

    expect(mockAddRecentDir).toHaveBeenCalledWith("/home/user/project");
    expect(onSelect).toHaveBeenCalledWith("/home/user/project");
  });

  // ─── Manual path input ──────────────────────────────────────────────────

  it("switches to manual input mode and selects on Enter", async () => {
    // Validates the pencil icon opens a text input, and Enter selects the typed path
    const { onSelect } = setup();

    await waitFor(() => {
      expect(screen.getByLabelText("Type path manually")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Type path manually"));

    const input = screen.getByLabelText("Type a directory path");
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue("/home/user/project");

    fireEvent.change(input, { target: { value: "/tmp/custom" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockAddRecentDir).toHaveBeenCalledWith("/tmp/custom");
    expect(onSelect).toHaveBeenCalledWith("/tmp/custom");
  });

  it("exits manual input mode on Escape without closing the dialog", async () => {
    // Validates Escape in manual input mode exits the input, not the dialog
    const { onClose } = setup();

    await waitFor(() => {
      expect(screen.getByLabelText("Type path manually")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Type path manually"));
    const input = screen.getByLabelText("Type a directory path");

    fireEvent.keyDown(input, { key: "Escape" });

    // Manual input should be gone, dialog should still be open
    expect(screen.queryByLabelText("Type a directory path")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // onClose should NOT have been called (Escape was consumed by the input)
    expect(onClose).not.toHaveBeenCalled();
  });

  // ─── New folder / clone a repository (manual mode) ──────────────────────
  // A typed folder that doesn't exist is created by the server when the
  // session starts; an optional repo URL is cloned into it. The picker only
  // collects the pair — it never checks the server or clones itself.

  async function openManual() {
    await waitFor(() => {
      expect(screen.getByLabelText("Type path manually")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText("Type path manually"));
  }

  it("passes accessibility scan in manual mode with the repository field", async () => {
    const { axe } = await import("vitest-axe");
    setup();
    await openManual();
    expect(screen.getByLabelText(/Git repository/)).toBeInTheDocument();
    const results = await axe(screen.getByRole("dialog"));
    expect(results).toHaveNoViolations();
  });

  it("tells the user a missing folder will be created", async () => {
    setup();
    await openManual();
    expect(screen.getByText(/doesn.t exist yet is created on the server/)).toBeInTheDocument();
  });

  it("a repo URL fills the path as <current folder>/<repo name> and selects with the repo", async () => {
    const { onSelect } = setup();
    await openManual();
    fireEvent.change(screen.getByLabelText(/Git repository/), {
      target: { value: "https://github.com/antonioshaman/li-voice-agent.git" },
    });
    expect(screen.getByLabelText("Type a directory path")).toHaveValue("/home/user/project/li-voice-agent");
    fireEvent.click(screen.getByRole("button", { name: "Use folder & clone" }));
    expect(onSelect).toHaveBeenCalledWith("/home/user/project/li-voice-agent", {
      repoUrl: "https://github.com/antonioshaman/li-voice-agent.git",
    });
  });

  it("a repo URL pasted into the path field moves to the repo field (the user's natural paste target)", async () => {
    const { onSelect } = setup();
    await openManual();
    const pathInput = screen.getByLabelText("Type a directory path");
    fireEvent.change(pathInput, { target: { value: "git@github.com:o/my-app.git" } });
    expect(pathInput).toHaveValue("/home/user/project/my-app");
    expect(screen.getByLabelText(/Git repository/)).toHaveValue("git@github.com:o/my-app.git");
    fireEvent.keyDown(pathInput, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("/home/user/project/my-app", { repoUrl: "git@github.com:o/my-app.git" });
  });

  it("a hand-edited path is not overwritten by later repo edits", async () => {
    setup();
    await openManual();
    const pathInput = screen.getByLabelText("Type a directory path");
    fireEvent.change(pathInput, { target: { value: "/srv/custom" } });
    fireEvent.change(screen.getByLabelText(/Git repository/), { target: { value: "https://github.com/o/r" } });
    expect(pathInput).toHaveValue("/srv/custom");
  });

  it("without a repo the button reads 'Use folder' and selects the path alone", async () => {
    const { onSelect } = setup();
    await openManual();
    fireEvent.change(screen.getByLabelText("Type a directory path"), { target: { value: "/root/new-proj" } });
    fireEvent.click(screen.getByRole("button", { name: "Use folder" }));
    expect(onSelect).toHaveBeenCalledWith("/root/new-proj");
  });

  it("Back leaves manual mode without selecting", async () => {
    const { onSelect } = setup();
    await openManual();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByLabelText("Type a directory path")).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  // ─── Close behavior ─────────────────────────────────────────────────────

  it("triggers close animation when close button is clicked", async () => {
    // Validates the close button triggers the closing animation
    setup();

    await waitFor(() => {
      expect(screen.getByLabelText("Close")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Close"));

    // The dialog should still be in the DOM (animating out)
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("triggers close animation on backdrop click", async () => {
    // Validates clicking outside the dialog panel triggers close
    const { onClose } = setup();

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    // Click the backdrop (the outer overlay div)
    const backdrop = screen.getByRole("dialog").parentElement!;
    fireEvent.click(backdrop);

    // After animation timeout, onClose should fire
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("does not double-call onClose when animateClose is triggered twice", async () => {
    // Validates the closing guard prevents multiple onClose calls
    const { onClose } = setup();

    await waitFor(() => {
      expect(screen.getByLabelText("Close")).toBeInTheDocument();
    });

    // Trigger close twice rapidly
    fireEvent.click(screen.getByLabelText("Close"));
    fireEvent.click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    // Should only be called once due to the closing guard
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ─── Keyboard navigation ───────────────────────────────────────────────

  it("shows keyboard hint bar with shortcut labels", async () => {
    // Validates keyboard shortcut hints are displayed at the bottom
    setup();

    await waitFor(() => {
      expect(screen.getByText("navigate")).toBeInTheDocument();
      expect(screen.getByText("select")).toBeInTheDocument();
      expect(screen.getByText("parent")).toBeInTheDocument();
      expect(screen.getByText("close")).toBeInTheDocument();
    });
  });

  it("selects a directory when Enter is pressed on a focused item", async () => {
    // Validates Enter key on a focused directory item selects it
    const { onSelect } = setup();

    await waitFor(() => {
      expect(screen.getByText("src")).toBeInTheDocument();
    });

    // Press ArrowDown to focus first item
    fireEvent.keyDown(document, { key: "ArrowDown" });

    // Enter to select on the focused item
    const firstItem = screen.getByLabelText("Navigate into src");
    fireEvent.keyDown(firstItem, { key: "Enter" });

    expect(mockAddRecentDir).toHaveBeenCalledWith("/home/user/project/src");
    expect(onSelect).toHaveBeenCalledWith("/home/user/project/src");
  });

  // ─── Calls API on mount ─────────────────────────────────────────────────

  it("calls api.listDirs with initialPath on mount", () => {
    // Validates the API is called with the provided initial path
    setup({ initialPath: "/custom/path" });
    expect(mockListDirs).toHaveBeenCalledWith("/custom/path");
  });

  it("calls api.listDirs without path when initialPath is empty", () => {
    // Validates empty initialPath results in an undefined path call
    setup({ initialPath: "" });
    expect(mockListDirs).toHaveBeenCalledWith(undefined);
  });
});

describe("repo URL helpers", () => {
  // Decide when a pasted value is a git remote and which folder name a clone gets.
  it.each([
    ["https://github.com/o/r", true],
    ["git@github.com:o/r.git", true],
    ["/root/project", false],
    ["github.com/o/r", false],
  ])("looksLikeRepoUrl(%s) → %s", (value, expected) => {
    expect(looksLikeRepoUrl(value as string)).toBe(expected);
  });

  it.each([
    ["https://github.com/o/li-voice-agent", "li-voice-agent"],
    ["https://github.com/o/li-voice-agent.git", "li-voice-agent"],
    ["https://github.com/o/repo/", "repo"],
    ["git@github.com:o/app.git", "app"],
  ])("repoNameFromUrl(%s) → %s", (url, name) => {
    expect(repoNameFromUrl(url)).toBe(name);
  });
});

// The real opener remains mounted; dialog cleanup must return focus to it.
it.each(["Escape", "Close", "Select", "Backdrop"])("restores opener focus after %s", async (action) => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Choose project</button>{open && <FolderPicker initialPath="/home/user/project" onSelect={() => {}} onClose={() => setOpen(false)} />}</>;
  }
  render(<Harness />);
  const opener = screen.getByRole("button", { name: "Choose project" });
  opener.focus(); fireEvent.click(opener);
  await screen.findByRole("dialog");
  if (action === "Backdrop") fireEvent.click(screen.getByRole("dialog").parentElement!);
  else if (action === "Escape") fireEvent.keyDown(document, { key: "Escape" });
  else if (action === "Close") fireEvent.click(screen.getByRole("button", { name: "Close" }));
  else fireEvent.click(await screen.findByRole("button", { name: /Select.*project/ }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(document.activeElement).toBe(opener);
});
