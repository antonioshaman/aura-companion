import { useCallback, type Dispatch, type SetStateAction } from "react";
import { create } from "zustand";
import type { ImageAttachment } from "../utils/image.js";

export const HOME_DRAFT = "$home";
export interface Draft { text: string; images: ImageAttachment[]; cwd: string }
const EMPTY_IMAGES: ImageAttachment[] = [];
const EMPTY: Draft = { text: "", images: EMPTY_IMAGES, cwd: "" };
interface DraftState {
  drafts: Record<string, Draft>;
  epochs: Record<string, number>;
  clear: (key: string, expected?: Draft) => void;
  reset: () => void;
}
/** Transient only: source text and attachments never enter localStorage. */
export const useDraftStore = create<DraftState>((set) => ({
  drafts: {}, epochs: {},
  clear: (key, expected) => set((s) => {
    if (expected && s.drafts[key] !== expected) return s;
    const drafts = { ...s.drafts }; delete drafts[key];
    return { drafts, epochs: { ...s.epochs, [key]: (s.epochs[key] ?? 0) + 1 } };
  }),
  reset: () => set((s) => ({ drafts: {}, epochs: Object.fromEntries(Array.from(new Set([...Object.keys(s.drafts), ...Object.keys(s.epochs)])).map((key) => [key, (s.epochs[key] ?? 0) + 1])) })),
}));

/** Setters keep React's functional-update contract and are bound to their owner. */
export function useDraftField<K extends keyof Draft>(key: string, field: K, initial: Draft[K] = EMPTY[field]): [Draft[K], Dispatch<SetStateAction<Draft[K]>>] {
  const value = useDraftStore((s) => s.drafts[key]?.[field] ?? initial);
  const epoch = useDraftStore((s) => s.epochs[key] ?? 0);
  const update = useCallback<Dispatch<SetStateAction<Draft[K]>>>((next) => {
    useDraftStore.setState((s) => {
      // A delayed image read/default load from before explicit reset owns no new draft.
      if ((s.epochs[key] ?? 0) !== epoch) return s;
      const prior = s.drafts[key] ?? { ...EMPTY, [field]: initial };
      const previous = prior[field];
      const value = typeof next === "function" ? (next as (v: Draft[K]) => Draft[K])(previous) : next;
      return { drafts: { ...s.drafts, [key]: { ...prior, [field]: value } } };
    });
  }, [key, field, epoch, initial]);
  return [value, update];
}
