import type { IsolationPreview } from "../../api.js";

export type IsolationChoice = "isolate" | "shared";

interface WorktreeIsolationChoiceProps {
  /** Server preview for the selected cwd; null while loading / not a repo. */
  preview: IsolationPreview | null;
  choice: IsolationChoice;
  onChange: (choice: IsolationChoice) => void;
  /**
   * When set, isolation does not apply to this launch (e.g. Council pairs
   * share one workspace by design) — the reason is shown instead of radios.
   */
  disabledReason?: string;
}

/**
 * New Session form: shown only when ANOTHER live session (Claude Code or
 * Codex) already works in the selected git working tree. Default is an
 * isolated worktree; the user can explicitly opt out and share the tree.
 * A lone session in a repo never sees this (behaviour unchanged).
 */
export function WorktreeIsolationChoice({ preview, choice, onChange, disabledReason }: WorktreeIsolationChoiceProps) {
  if (!preview || !preview.isGitRepo || preview.liveSessions.length === 0) return null;

  const count = preview.liveSessions.length;
  const names = preview.liveSessions
    .map((s) => s.name || s.sessionId.slice(0, 8))
    .slice(0, 3)
    .join(", ");
  const repoName = preview.repoRoot?.split("/").filter(Boolean).pop() ?? "repo";
  const targetHint = `${preview.worktreesBaseDir.replace(/\/+$/, "")}/${repoName}/`;

  return (
    <div
      className="mt-2 p-3 rounded-[10px] bg-amber-500/10 border border-amber-500/20 text-xs"
      data-testid="worktree-isolation-choice"
    >
      <fieldset disabled={!!disabledReason} className="min-w-0">
        <legend className="font-medium text-cc-fg">
          {count === 1 ? "Another live session is" : `${count} live sessions are`} already working in this tree
        </legend>
        <p className="mt-0.5 text-cc-muted truncate" title={names}>
          {names}
          {count > 3 ? ` +${count - 3}` : ""}
        </p>

        {preview.repoServiceUnits.length > 0 && (
          <p className="mt-1 text-amber-600 dark:text-amber-400">
            systemd service {preview.repoServiceUnits.join(", ")} runs from this tree — shared edits can reach it on restart.
          </p>
        )}

        {disabledReason ? (
          <p className="mt-2 text-cc-muted">{disabledReason}</p>
        ) : (
          <div className="mt-2 flex flex-col gap-1.5">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="worktree-isolation"
                value="isolate"
                checked={choice === "isolate"}
                onChange={() => onChange("isolate")}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="text-cc-fg font-medium">Isolated worktree (recommended)</span>
                <span className="block text-cc-muted break-all">
                  New branch <span className="font-mono-code">aura/…</span> from the current commit in{" "}
                  <span className="font-mono-code">{targetHint}</span>. Uncommitted changes of the other session are not copied.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="worktree-isolation"
                value="shared"
                checked={choice === "shared"}
                onChange={() => onChange("shared")}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="text-cc-fg font-medium">Work in the same tree</span>
                <span className="block text-cc-muted">
                  Edits, <span className="font-mono-code">git add</span> and branch switches will affect the other session.
                </span>
              </span>
            </label>
          </div>
        )}

        {preview.warnings.map((w) => (
          <p key={w} role="alert" className="mt-2 text-red-500">
            {w}
          </p>
        ))}
      </fieldset>
    </div>
  );
}
