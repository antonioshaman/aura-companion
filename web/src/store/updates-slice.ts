import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";
import type { CreationProgressEvent } from "../api.js";

export interface UpdatesSlice {
  dockerUpdateDialogOpen: boolean;
  creationProgress: CreationProgressEvent[] | null;
  creationError: string | null;
  sessionCreating: boolean;
  sessionCreatingBackend: "claude" | "codex" | null;

  setDockerUpdateDialogOpen: (open: boolean) => void;
  addCreationProgress: (step: CreationProgressEvent) => void;
  clearCreation: () => void;
  setSessionCreating: (creating: boolean, backend?: "claude" | "codex") => void;
  setCreationError: (error: string | null) => void;
}

export const createUpdatesSlice: StateCreator<AppState, [], [], UpdatesSlice> = (set) => ({
  dockerUpdateDialogOpen: false,
  creationProgress: null,
  creationError: null,
  sessionCreating: false,
  sessionCreatingBackend: null,

  setDockerUpdateDialogOpen: (open) => set({ dockerUpdateDialogOpen: open }),

  addCreationProgress: (step) => set((state) => {
    const existing = state.creationProgress || [];
    const idx = existing.findIndex((s) => s.step === step.step);
    if (idx >= 0) {
      const updated = [...existing];
      updated[idx] = step;
      return { creationProgress: updated };
    }
    return { creationProgress: [...existing, step] };
  }),
  clearCreation: () => set({ creationProgress: null, creationError: null, sessionCreating: false, sessionCreatingBackend: null }),
  setSessionCreating: (creating, backend) => set({ sessionCreating: creating, sessionCreatingBackend: backend ?? null }),
  setCreationError: (error) => set({ creationError: error }),
});
