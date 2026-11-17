import { describe, expect, it } from "vitest";
import { parseServeOptions } from "./serve-options.js";

/**
 * hashimoto H-14: `--port` was advertised globally but the server only read
 * PORT; `aura-companion --port 4000` failed as "Unknown command".
 */
describe("parseServeOptions", () => {
  it("maps --port / --host to PORT / HOST", () => {
    expect(parseServeOptions(["--port", "4000", "--host", "127.0.0.1"])).toEqual({ env: { PORT: "4000", HOST: "127.0.0.1" } });
    expect(parseServeOptions([])).toEqual({ env: {} });
  });

  it("refuses a bad port, a missing host and unknown options with a readable message", () => {
    expect(parseServeOptions(["--port", "abc"])).toMatchObject({ error: expect.stringContaining("--port needs a number") });
    expect(parseServeOptions(["--port", "70000"])).toMatchObject({ error: expect.stringContaining("1-65535") });
    expect(parseServeOptions(["--host"])).toMatchObject({ error: expect.stringContaining("--host needs an address") });
    expect(parseServeOptions(["--bogus"])).toEqual({ error: "Unknown option: --bogus" });
  });
});
