/** Shared Linux identity predicates for browser ownership checks. */
import { basename } from "node:path";

export function isAgentBrowserExecutable(executable: string): boolean {
  return /^agent-browser(?:-[a-zA-Z0-9_-]+)?$/.test(basename(executable.replace(/ \(deleted\)$/, "")));
}

export function processStartTicks(stat: string): string | null {
  const ticks = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
  return ticks && /^\d+$/.test(ticks) ? ticks : null;
}
