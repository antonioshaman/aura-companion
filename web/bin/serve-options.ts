/**
 * Options of the foreground server (`aura-companion [serve] [--port N] [--host H]`).
 * `--port` was listed as a global option but only `install` / `auth` read it:
 * `aura-companion --port 4000` failed as "Unknown command", and `serve
 * --port 4000` silently bound 3456 (council review 2026-11-15, hashimoto H-14).
 * The server reads PORT / HOST from the environment, so the flags set those.
 */
export function parseServeOptions(argv: readonly string[]): { env: { PORT?: string; HOST?: string } } | { error: string } {
  const env: { PORT?: string; HOST?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return { error: `--port needs a number 1-65535, got ${JSON.stringify(argv[i + 1] ?? "")}` };
      env.PORT = String(n);
      i++;
    } else if (a === "--host") {
      const h = argv[i + 1];
      if (!h || h.startsWith("--")) return { error: "--host needs an address, e.g. 127.0.0.1 or 0.0.0.0" };
      env.HOST = h;
      i++;
    } else if (a === "--foreground") {
      // accepted by `start`; harmless here
    } else {
      return { error: `Unknown option: ${a}` };
    }
  }
  return { env };
}
