import { join } from "node:path";
import { COMPANION_HOME } from "../paths.js";

/**
 * Where the sign-in state lives: the promotion journal and the per-provider
 * epoch files (`~/.companion/llm-auth`), attempts below it. Kept apart from
 * `login-wiring.ts` so the launcher can read the epoch without pulling in the
 * sign-in runtime.
 */
export const LLM_AUTH_STATE_DIR = join(COMPANION_HOME, "llm-auth");
export const LLM_AUTH_ATTEMPTS_DIR = join(LLM_AUTH_STATE_DIR, "attempts");
