// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { axe } from "vitest-axe";
import { ImprovementRadar } from "./ImprovementRadar.js";
import { api } from "../api.js";
import type { RadarView } from "../../server/radar/radar-types.js";
vi.mock("../api.js", () => ({ api: { radar: vi.fn(), modelFreshness: vi.fn(), runRadar: vi.fn(), configureRadar: vi.fn(), decideRadar: vi.fn(), refreshModels: vi.fn() } }));
const idea = { id: "a".repeat(24), title: "Оценить интеграцию team/mcp", benefit: "Расширить инструменты сессий.", gap: "Применимость требует проверки.", url: "https://github.com/team/mcp", publishedAt: null, confidence: "candidate" as const, complexity: "Не оценена" };
const view: RadarView = { version: 1, config: { enabled: false, sources: [{ kind: "repo", value: "openai/codex" }] }, ideas: [idea], decisions: {}, lastAttempt: 1000, lastSuccess: 1000, outcome: "success", sourceErrors: [], running: false, capabilities: [{ id: "council", title: "Council Mode", evidence: "web/server/session-group-coordinator.ts" }], counts: { proposals: 1, implemented: 1 } };
beforeEach(() => {
  vi.resetAllMocks(); vi.mocked(api.radar).mockResolvedValue(structuredClone(view));
  const model = { status: "stale" as const, fetchedAt: 1000, installedCliVersion: "codex-cli old", catalogClientVersion: "old", scope: "installation" as const, refresh: "local-only" as const };
  vi.mocked(api.modelFreshness).mockResolvedValue({ claude: model, codex: model });
});
describe("quiet improvement radar", () => {
  // Counts are evidence-backed data, not an announcement or an auto-opened modal.
  it("renders collapsed counts accessibly and opens with the keyboard", async () => {
    const user = userEvent.setup(); const { container } = render(<ImprovementRadar backend="codex" />);
    await screen.findByText(/1 предложение/);
    const summary = container.querySelector("summary")!;
    expect(summary.closest("details")).not.toHaveAttribute("open");
    expect(await axe(container)).toHaveNoViolations();
    summary.focus(); await user.keyboard("{Enter}");
    expect(summary.closest("details")).toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "Проверить новинки" })).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });
  it("dismisses or marks implemented without executing the proposal", async () => {
    const { container } = render(<ImprovementRadar backend="codex" />); await screen.findByText(/1 предложение/);
    fireEvent.click(container.querySelector("summary")!);
    vi.mocked(api.decideRadar).mockResolvedValue({ ...view, decisions: { [idea.id]: "implemented" }, counts: { proposals: 0, implemented: 2 } });
    fireEvent.click(screen.getByRole("button", { name: "Уже реализовано" }));
    await waitFor(() => expect(api.decideRadar).toHaveBeenCalledWith(idea.id, "implemented"));
    expect(await screen.findByText(/0 предложений/)).toHaveTextContent("2 уже в Aura");
    fireEvent.click(screen.getByRole("button", { name: "Уже в Aura (2)" }));
    expect(screen.getByText("Council Mode")).toBeVisible();
    expect(api.runRadar).not.toHaveBeenCalled();
    expect(await axe(container)).toHaveNoViolations();
  });
  it("shows partial/error states and permits an explicit daily opt-in", async () => {
    vi.mocked(api.radar).mockResolvedValue({ ...view, outcome: "partial", sourceErrors: ["GitHub ограничен"] });
    const { container } = render(<ImprovementRadar backend="claude" />); await screen.findByText(/1 предложение/); fireEvent.click(container.querySelector("summary")!);
    expect(screen.getByRole("status")).toHaveTextContent("Часть источников недоступна");
    vi.mocked(api.configureRadar).mockRejectedValue(new Error("Настройки не сохранены"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Проверять раз в сутки" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Настройки не сохранены");
    expect(screen.getByText(idea.title)).toBeVisible(); expect(await axe(container)).toHaveNoViolations();
  });
  it("refreshes model metadata explicitly without starting sessions", async () => {
    const refreshed = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<ImprovementRadar backend="codex" onModelsRefreshed={refreshed} />); await screen.findByText(/1 предложение/); fireEvent.click(container.querySelector("summary")!);
    fireEvent.click(screen.getByText("Актуальность моделей"));
    vi.mocked(api.refreshModels).mockResolvedValue({ claude: "no-key", codex: "local-cache" });
    fireEvent.click(screen.getByRole("button", { name: "Перечитать локальный каталог" }));
    await waitFor(() => expect(api.refreshModels).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Локальный каталог перечитан/)).toBeVisible(); expect(api.runRadar).not.toHaveBeenCalled();
    expect(refreshed).toHaveBeenCalledTimes(1);
  });
});

// Editing sources and scheduling are explicit opt-ins, not side effects of opening.
it("saves bounded source configuration and toggles the daily schedule", async () => {
  const { container } = render(<ImprovementRadar backend="codex" />); await screen.findByText(/1 предложение/); fireEvent.click(container.querySelector("summary")!);
  vi.mocked(api.configureRadar).mockResolvedValue({ ...view, config: { ...view.config, enabled: true } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Проверять раз в сутки" }));
  await waitFor(() => expect(api.configureRadar).toHaveBeenCalledWith({ ...view.config, enabled: true }));
  fireEvent.click(screen.getByRole("button", { name: "Источники" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "repo:team/tool\nofficial:openai-models" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить источники" }));
  await waitFor(() => expect(api.configureRadar).toHaveBeenLastCalledWith({ enabled: true, sources: [{ kind: "repo", value: "team/tool" }, { kind: "official", value: "openai-models" }] }));
  expect(await axe(container)).toHaveNoViolations();
});
it("runs a manual scan, retains results after refresh failure, and restores decisions", async () => {
  const { container } = render(<ImprovementRadar backend="codex" />); await screen.findByText(/1 предложение/); fireEvent.click(container.querySelector("summary")!);
  vi.mocked(api.runRadar).mockResolvedValue({ ...view, decisions: { [idea.id]: "dismissed" }, counts: { proposals: 0, implemented: 1 } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить новинки" }));
  await screen.findByText(/0 предложений/); fireEvent.click(screen.getByText("Отклонённые идеи"));
  vi.mocked(api.decideRadar).mockResolvedValue(view);
  fireEvent.click(screen.getByRole("button", { name: "Снова предлагать" }));
  await waitFor(() => expect(api.decideRadar).toHaveBeenCalledWith(idea.id, "restore"));
  fireEvent.click(screen.getByText("Актуальность моделей")); vi.mocked(api.refreshModels).mockRejectedValue(new Error("network"));
  fireEvent.click(screen.getByRole("button", { name: "Перечитать локальный каталог" }));
  expect(await screen.findByText(/Обновление не удалось/)).toBeVisible(); expect(screen.getByText(idea.title)).toBeVisible();
});
it("does not leave a failed initial load looking like infinite loading", async () => {
  vi.mocked(api.radar).mockRejectedValue(new Error("offline")); vi.mocked(api.modelFreshness).mockRejectedValue(new Error("offline"));
  const { container } = render(<ImprovementRadar backend="claude" />); await screen.findByText(/Радар улучшений · недоступен/);
  fireEvent.click(container.querySelector("summary")!); expect(screen.getByRole("alert")).toHaveTextContent("Радар временно недоступен");
  expect(await axe(container)).toHaveNoViolations();
});

// ABR-1: a delayed status GET must not overwrite an acknowledged durable decision.
it("ignores a stale poll response delivered after a successful decision", async()=>{
 let tick!:()=>void;const timer=vi.spyOn(globalThis,"setInterval").mockImplementation(((fn:()=>void)=>{tick=fn;return 1;}) as typeof setInterval);
 let finish!:(s:RadarView)=>void;vi.mocked(api.radar).mockResolvedValueOnce({...view,running:true}).mockImplementationOnce(()=>new Promise(r=>{finish=r;}));
 const {container}=render(<ImprovementRadar backend="codex"/>);await screen.findByText(/1 предложение/);fireEvent.click(container.querySelector("summary")!);
 act(()=>tick());
 vi.mocked(api.decideRadar).mockResolvedValue({...view,running:false,decisions:{[idea.id]:"implemented"},counts:{proposals:0,implemented:2}});
 fireEvent.click(screen.getByRole("button",{name:"Уже реализовано"}));await screen.findByText(/0 предложений/);
 await act(async()=>{finish({...view,running:false});});expect(screen.getByText(/0 предложений/)).toHaveTextContent("2 уже в Aura");timer.mockRestore();
});
// WATSON-1: controls removed after restore return keyboard focus; failure keeps the current control.
it.each(["implemented","dismissed"] as const)("returns focus after restoring %s",async decision=>{
 vi.mocked(api.radar).mockResolvedValue({...view,decisions:{[idea.id]:decision},counts:{proposals:0,implemented:decision==="implemented"?2:1}});
 const {container}=render(<ImprovementRadar backend="codex"/>);await screen.findByText(/0 предложений/);const summary=container.querySelector("summary")!;fireEvent.click(summary);
 fireEvent.click(screen.getByText(decision==="implemented"?"Уже в Aura (2)":"Отклонённые идеи"));
 const button=screen.getByRole("button",{name:decision==="implemented"?"Вернуть в предложения":"Снова предлагать"});button.focus();
 vi.mocked(api.decideRadar).mockResolvedValue(view);fireEvent.click(button);await screen.findByText(/1 предложение/);expect(summary).toHaveFocus();
});
// UX-2: transient initial failure has an in-panel recovery without reloading the entire app.
it("retries a failed initial load and enables the scanner after recovery",async()=>{
 vi.mocked(api.radar).mockRejectedValueOnce(new Error("offline"));const {container}=render(<ImprovementRadar backend="codex"/>);await screen.findByText(/Радар улучшений · недоступен/);fireEvent.click(container.querySelector("summary")!);
 fireEvent.click(screen.getByRole("button",{name:"Повторить загрузку"}));await screen.findByText(/1 предложение/);expect(screen.getByRole("button",{name:"Проверить новинки"})).toBeEnabled();expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

// WILLISON-2: HTTP success can carry an upstream failure or missing local catalog.
it.each(["claude","codex"] as const)("reports semantic refresh failure for %s", async backend=>{
 const reload=vi.fn().mockResolvedValue(undefined);vi.mocked(api.refreshModels).mockResolvedValue({claude:"unavailable",codex:"absent"});
 const {container}=render(<ImprovementRadar backend={backend} onModelsRefreshed={reload}/>);await screen.findByText(/1 предложение/);fireEvent.click(container.querySelector("summary")!);fireEvent.click(screen.getByText("Актуальность моделей"));
 fireEvent.click(screen.getByRole("button",{name:backend==="claude"?"Проверить каталог Claude":"Перечитать локальный каталог"}));
 await screen.findByText(backend==="claude"?/Источник каталога Claude недоступен/:/Локальный каталог Codex отсутствует/);expect(reload).not.toHaveBeenCalled();
});

// FOWLER-1 / UX-1: archived decisions remain recognizable even after scan candidates disappear.
it("shows the archived title and provenance after scan replacement", async()=>{
 vi.mocked(api.radar).mockResolvedValue({...view,ideas:[],decisionIdeas:{[idea.id]:idea},decisions:{[idea.id]:"implemented"},counts:{proposals:0,implemented:2}});
 const {container}=render(<ImprovementRadar backend="codex"/>);await screen.findByText(/0 предложений/);fireEvent.click(container.querySelector("summary")!);fireEvent.click(screen.getByRole("button",{name:"Уже в Aura (2)"}));
 expect(screen.getByText(idea.title)).toBeVisible();expect(screen.getByRole("link",{name:"Источник (новая вкладка)"})).toHaveAttribute("href",idea.url);expect(await axe(container)).toHaveNoViolations();
});
