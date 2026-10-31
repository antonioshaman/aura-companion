// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { HOME_DRAFT, useDraftField, useDraftStore } from "./drafts.js";
beforeEach(() => useDraftStore.getState().reset());
// In-memory ownership: ordinary remount retains data, explicit reset invalidates old setters.
it("retains Home fields and refuses stale completion after explicit reset", () => {
  const storage = vi.spyOn(Storage.prototype, "setItem");
  const a = renderHook(() => useDraftField(HOME_DRAFT, "text"));
  act(() => a.result.current[1]("A"));
  const late = a.result.current[1];
  a.unmount();
  const b = renderHook(() => useDraftField(HOME_DRAFT, "text"));
  expect(b.result.current[0]).toBe("A");
  act(() => useDraftStore.getState().clear(HOME_DRAFT));
  act(() => b.result.current[1]("B"));
  act(() => late("old async completion"));
  expect(b.result.current[0]).toBe("B");
  expect(storage).not.toHaveBeenCalled();
  storage.mockRestore();
});
it("clears only the submitted revision and supports functional attachment updates", () => {
  const hook = renderHook(() => useDraftField("s1", "images"));
  act(() => hook.result.current[1]((images) => [...images, { name: "A", base64: "A", mediaType: "image/png" }]));
  const submitted = useDraftStore.getState().drafts.s1;
  act(() => hook.result.current[1]((images) => [...images, { name: "B", base64: "B", mediaType: "image/png" }]));
  act(() => useDraftStore.getState().clear("s1", submitted));
  expect(hook.result.current[0]).toHaveLength(2);
  act(() => useDraftStore.getState().clear("s1", useDraftStore.getState().drafts.s1));
  expect(hook.result.current[0]).toEqual([]);
});
