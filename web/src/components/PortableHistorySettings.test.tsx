// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import * as matchers from "vitest-axe/matchers";
import { PortableHistorySettings } from "./PortableHistorySettings.js";
expect.extend(matchers);
const mocks = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn(), context: vi.fn(), continuation: vi.fn(), export: vi.fn(), import: vi.fn(), markdown: vi.fn(), draft: vi.fn(), navigate: vi.fn() }));
vi.mock("../api.js", () => ({ api: { listPortableHistory: mocks.list, getPortableHistory: mocks.detail, getPortableHistoryContext: mocks.context, continuePortableHistory: mocks.continuation, exportPortableHistory: mocks.export, importPortableHistory: mocks.import, getPortableHistoryMarkdown: mocks.markdown } }));
vi.mock("../store.js", () => ({ useStore: { getState: () => ({ setPickupDraft: mocks.draft }) } }));
vi.mock("../utils/routing.js", () => ({ navigateToSession: mocks.navigate }));
const inventory = { sources: [{ id: "s", project: "project", backend: "claude" }], archives: [{ id: "a", projects: ["project"], sessions: 1, exportedAt: "2026-01-01" }], skipped: 1, limits: { maxArchiveBytes: 33554432, maxSessions: 200, maxMessages: 50000, maxDepth: 32, maxStringBytes: 16777216, maxDraftBytes: 24576 } };
const malicious = '<img src="https://bad.test/image"><script>alert(1)</script> ![external](https://bad.test/x)';
const archive = { format: "aura-portable-history", version: 1, exportedAt: "2026-01-01", redactionVersion: 1, exclusions: ["Source files excluded"], sessions: [{ id: "s", project: "project", backend: "claude", messages: [{ role: "assistant", streamStatus: "interrupted", content: malicious }] }] };
beforeEach(() => {
  vi.clearAllMocks(); mocks.list.mockResolvedValue(inventory); mocks.detail.mockResolvedValue(archive); mocks.context.mockResolvedValue({ text: "Review historical evidence", truncated: true, omittedMessages: 2, omittedAttachments: 1 });
  mocks.continuation.mockResolvedValue({ newSessionId: "new", draft: "unsent" });
});
async function open() { await userEvent.click(screen.getByRole("button", { name: "Open portable history" })); await screen.findByText(/1 unavailable histories skipped/); }
async function detail() { await open(); await userEvent.click(screen.getByRole("button", { name: /project · 1 sessions/ })); await screen.findByText("Continuation context — review before sending"); }
// Lazy loading prevents unrelated Settings visits from reading large history inventories.
it("renders accessible initial/empty states and loads only after keyboard activation (AC12)", async () => {
  mocks.list.mockResolvedValue({ ...inventory, sources: [], archives: [] });
  const { container } = render(<PortableHistorySettings />);
  expect(mocks.list).not.toHaveBeenCalled(); expect(await axe(container)).toHaveNoViolations();
  screen.getByRole("button", { name: "Open portable history" }).focus(); await userEvent.keyboard("{Enter}");
  await screen.findByText(/No saved sessions/); expect(screen.getByLabelText("Import archive JSON")).toBeEnabled(); expect(await axe(container)).toHaveNoViolations();
});
it("shows literal evidence and separate bounded context without active HTML/resources (AC7,11)", async () => {
  const { container } = render(<PortableHistorySettings />); await detail();
  await userEvent.click(screen.getByText("Full history — literal text"));
  expect(screen.getByLabelText("Historical messages").textContent).toContain(malicious);
  expect(screen.getByLabelText("Historical messages")).toHaveTextContent("interrupted");
  expect(container.querySelector("img,script,iframe")).toBeNull(); expect(screen.getByLabelText("Continuation context")).toHaveTextContent("Review historical evidence");
  expect(await axe(container)).toHaveNoViolations();
});
it.each(["claude", "codex"])("creates %s with a held draft and explicit folder, with retry preserving history (AC8,9,15)", async backend => {
  render(<PortableHistorySettings />); await detail();
  await userEvent.selectOptions(screen.getByLabelText("Continue with"), backend);
  await userEvent.type(screen.getByLabelText(/Existing workspace folder/), "/workspace");
  mocks.continuation.mockRejectedValueOnce(new Error("Provider unavailable"));
  await userEvent.click(screen.getByRole("button", { name: "Create session with draft" })); await screen.findByRole("alert");
  expect(screen.getByLabelText("Continuation context")).toBeInTheDocument(); expect(mocks.navigate).not.toHaveBeenCalled();
  screen.getByRole("button", { name: "Create session with draft" }).focus(); await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(mocks.draft).toHaveBeenCalledWith("new", "unsent"));
  expect(mocks.continuation).toHaveBeenLastCalledWith("a", "s", backend, "/workspace"); expect(mocks.navigate).toHaveBeenCalledWith("new");
});
it("exports selected sessions and releases download URLs (AC1,15)", async () => {
  const create = vi.fn((_blob: Blob) => "blob:test"); const revoke = vi.fn(); vi.stubGlobal("URL", class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  mocks.export.mockRejectedValueOnce(new Error("Export unavailable")).mockResolvedValueOnce(archive);
  render(<PortableHistorySettings />); await open(); await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(screen.getByRole("button", { name: "Export selected (1)" })); await screen.findByRole("alert");
  expect(screen.getByRole("checkbox")).toBeChecked(); await userEvent.click(screen.getByRole("button", { name: "Export selected (1)" }));
  await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:test"));
  // Machine-readable downloads must remain within the same compact-byte import limit.
  const downloaded = create.mock.calls[0][0] as Blob;
  expect(downloaded.size).toBe(new TextEncoder().encode(JSON.stringify(archive)).byteLength);
  expect(downloaded.size).toBeLessThan(new TextEncoder().encode(JSON.stringify(archive, null, 2)).byteLength);
  expect(mocks.export).toHaveBeenLastCalledWith(["s"]);
  await userEvent.click(screen.getByRole("button", { name: /project · 1 sessions/ }));
  await screen.findByText("Continuation context — review before sending");
  await userEvent.click(screen.getByRole("button", { name: "Download archive JSON" }));
  expect((create.mock.calls[1][0] as Blob).size).toBe(new TextEncoder().encode(JSON.stringify(archive)).byteLength);
  expect(revoke).toHaveBeenCalledTimes(2);
  click.mockRestore(); vi.unstubAllGlobals();
});
it("rejects oversized files before reading and imports a valid duplicate without replacing evidence (AC5,6)", async () => {
  render(<PortableHistorySettings />); await open();
  const oversized = new File([], "large.json", { type: "application/json" }); Object.defineProperty(oversized, "size", { value: 33554433 }); const read = vi.fn(); Object.defineProperty(oversized, "text", { value: read });
  fireEvent.change(screen.getByLabelText("Import archive JSON"), { target: { files: [oversized] } }); await userEvent.click(screen.getByRole("button", { name: "Import archive" }));
  await screen.findByRole("alert"); expect(read).not.toHaveBeenCalled(); expect(mocks.import).not.toHaveBeenCalled();
  const file = new File([], "archive.json", { type: "application/json" }); Object.defineProperty(file, "text", { value: async () => JSON.stringify(archive) });
  mocks.import.mockResolvedValue({ id: "a", duplicate: true }); fireEvent.change(screen.getByLabelText("Import archive JSON"), { target: { files: [file] } });
  await userEvent.click(screen.getByRole("button", { name: "Import archive" })); await screen.findByText(/no duplicate created/); expect(mocks.import).toHaveBeenCalledWith(archive);
});
// Network failures remain recoverable with keyboard navigation, not a remount.
it("retries inventory errors and leaves import reachable", async () => {
  mocks.list.mockRejectedValueOnce(new Error("Storage temporarily unavailable"));
  const { container } = render(<PortableHistorySettings />);
  await userEvent.click(screen.getByRole("button", { name: "Open portable history" }));
  await screen.findByRole("alert"); expect(await axe(container)).toHaveNoViolations();
  screen.getByRole("button", { name: "Open portable history" }).focus(); await userEvent.keyboard("{Enter}");
  await screen.findByLabelText("Import archive JSON");
});
it("downloads Markdown through the authenticated API without navigating to archive links", async () => {
  const create = vi.fn(() => "blob:markdown"); const revoke = vi.fn();
  vi.spyOn(URL, "createObjectURL").mockImplementation(create);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revoke);
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  mocks.markdown.mockResolvedValue("# Literal history");
  render(<PortableHistorySettings />); await detail();
  await userEvent.click(screen.getByRole("button", { name: "Download Markdown / Obsidian" }));
  await waitFor(() => expect(mocks.markdown).toHaveBeenCalledWith("a", "s"));
  expect(revoke).toHaveBeenCalledWith("blob:markdown"); click.mockRestore();
});
