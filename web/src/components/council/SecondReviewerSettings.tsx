/**
 * SecondReviewerSettings — choose the Council "second opinion" reviewer (W15).
 *
 * A Council pair's observer reviews each checkpoint on one model. Different
 * models catch different real bugs, so a pair can add a second, one-shot,
 * read-only reviewer on another backend/model. Its findings appear in the
 * observer panel with a model badge; a STOP from either reviewer raises the
 * banner, and a checkpoint counts as clean only when both came back clean.
 *
 * Controlled component, used for the global default (Settings page). Works for
 * Claude Code and Codex observers alike: "Auto" picks the opposite backend
 * (Codex observer → Claude Sonnet; Claude observer → Codex default model).
 */

import { useEffect, useId, useState } from "react";
import type {
  SecondReviewerConfig,
  SecondReviewerSetting,
  SecondReviewScope,
} from "../../../server/second-reviewer-config.js";

export type { SecondReviewerConfig, SecondReviewerSetting, SecondReviewScope };

type Choice = "off" | "auto" | "claude" | "codex";

function choiceOf(reviewer: SecondReviewerSetting): Choice {
  if (reviewer === "off" || reviewer === "auto") return reviewer;
  return reviewer.backend;
}

function modelOf(reviewer: SecondReviewerSetting): string {
  return typeof reviewer === "object" ? reviewer.model ?? "" : "";
}

/** Pure: the setting a (choice, model text) pair stands for. Empty model = the CLI's default. */
export function secondReviewerFromChoice(choice: Choice, model: string): SecondReviewerSetting {
  if (choice === "off" || choice === "auto") return choice;
  const trimmed = model.trim();
  return trimmed ? { backend: choice, model: trimmed } : { backend: choice };
}

const CHOICES: ReadonlyArray<{ value: Choice; label: string }> = [
  { value: "off", label: "Off" },
  { value: "auto", label: "Auto — the other backend (Codex observer → Claude Sonnet, Claude observer → Codex)" },
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
];

export interface SecondReviewerSettingsProps {
  value: SecondReviewerConfig;
  onChange: (next: SecondReviewerConfig) => void;
  disabled?: boolean;
}

export function SecondReviewerSettings({ value, onChange, disabled = false }: SecondReviewerSettingsProps) {
  const baseId = useId();
  const choice = choiceOf(value.reviewer);
  // The model field commits on blur / Enter, not per keystroke.
  const [modelDraft, setModelDraft] = useState(modelOf(value.reviewer));
  useEffect(() => {
    setModelDraft(modelOf(value.reviewer));
  }, [value.reviewer]);

  const commitModel = () => {
    if (choice !== "claude" && choice !== "codex") return;
    if (modelDraft.trim() === modelOf(value.reviewer)) return;
    onChange({ ...value, reviewer: secondReviewerFromChoice(choice, modelDraft) });
  };

  return (
    <div className="space-y-2" data-testid="second-reviewer-settings">
      <label htmlFor={`${baseId}-choice`} className="block text-sm text-cc-fg">
        Council second opinion
      </label>
      <p id={`${baseId}-help`} className="text-xs text-cc-muted px-1">
        A second, read-only reviewer on another model checks each Council checkpoint next to the observer.
        Its findings show with a model badge; a STOP from either raises the banner, and a checkpoint counts
        as clean only when both are clean. Costs one extra headless run per reviewed checkpoint.
      </p>
      <select
        id={`${baseId}-choice`}
        aria-describedby={`${baseId}-help`}
        disabled={disabled}
        value={choice}
        onChange={(e) => {
          const next = e.target.value as Choice;
          onChange({ ...value, reviewer: secondReviewerFromChoice(next, next === choice ? modelDraft : "") });
        }}
        className="w-full px-3 py-2.5 min-h-[44px] rounded-lg text-sm bg-cc-hover text-cc-fg border border-cc-border disabled:opacity-50"
      >
        {CHOICES.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>

      {(choice === "claude" || choice === "codex") && (
        <div>
          <label htmlFor={`${baseId}-model`} className="block text-xs font-medium text-cc-fg mb-1.5">
            Model (empty = the CLI default)
          </label>
          <input
            id={`${baseId}-model`}
            type="text"
            value={modelDraft}
            disabled={disabled}
            placeholder={choice === "claude" ? "sonnet" : "gpt-6.1-sol"}
            onChange={(e) => setModelDraft(e.target.value)}
            onBlur={commitModel}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitModel();
            }}
            className="w-full px-3 py-2.5 min-h-[44px] rounded-lg text-sm bg-cc-hover text-cc-fg border border-cc-border font-mono-code disabled:opacity-50"
          />
        </div>
      )}

      {choice !== "off" && (
        <fieldset disabled={disabled} className="space-y-1">
          <legend className="text-xs font-medium text-cc-fg mb-1">Which checkpoints</legend>
          {(
            [
              { v: "review-implement", label: "Review and implement phases only (recommended)" },
              { v: "all", label: "Every checkpoint, including plans" },
            ] as ReadonlyArray<{ v: SecondReviewScope; label: string }>
          ).map((opt) => (
            <label key={opt.v} className="flex items-center gap-2 px-3 py-2 min-h-[44px] rounded-lg text-sm bg-cc-hover text-cc-fg cursor-pointer">
              <input
                type="radio"
                name={`${baseId}-scope`}
                value={opt.v}
                checked={value.scope === opt.v}
                onChange={() => onChange({ ...value, scope: opt.v })}
                className="accent-cc-primary"
              />
              {opt.label}
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}
