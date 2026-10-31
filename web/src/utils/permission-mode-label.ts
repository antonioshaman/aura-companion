/** Display only: never converts these labels back into wire permission values. */
export function permissionModeLabel(backend: "claude" | "codex", mode: string | undefined): { label: string; description: string } {
  if (!mode) return { label: "Loading mode", description: "Waiting for the CLI to report its mode." };
  if (!["default", "acceptEdits", "bypassPermissions", "plan"].includes(mode)) return { label: "Mode unavailable", description: "The CLI reported an unrecognized mode." };
  if (backend === "codex") return {
    label: mode === "plan" ? "Plan" : "Auto",
    description: "Codex uses automatic approvals and full file access. Plan changes collaboration, not the sandbox.",
  };
  switch (mode) {
    case "default": return { label: "Ask permissions", description: "Claude asks before restricted tools." };
    case "acceptEdits": return { label: "Auto edits", description: "Claude automatically approves file edits; other tools may ask." };
    case "bypassPermissions": return { label: "Agent", description: "Claude runs tools without approval prompts." };
    default: return { label: "Plan", description: "Claude planning mode; execution follows the CLI permission policy." };
  }
}
