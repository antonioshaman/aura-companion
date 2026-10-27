import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Instance bootstrap exchange: a new instance trades its one-time token (from
 * cloud-init user_data) for its real secrets. These tests pin that the token
 * is looked up by hash, consumed atomically (hash nulled in the same UPDATE),
 * and that unknown/expired/used tokens get nothing.
 */

const returningMock = vi.fn();
const whereMock = vi.fn(() => ({ returning: returningMock }));
const setMock = vi.fn(() => ({ where: whereMock }));
const updateMock = vi.fn(() => ({ set: setMock }));

vi.mock("../db/index.js", () => ({
  getDb: vi.fn(() => ({ update: updateMock })),
}));

const { instanceBootstrap } = await import("./bootstrap");

describe("POST /api/instance-bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("returns the instance's secrets as env lines and consumes the token", async () => {
    returningMock.mockResolvedValue([{ id: "inst-1", authSecret: "real-secret" }]);

    const res = await instanceBootstrap.request("/", {
      method: "POST",
      headers: { Authorization: "Bearer one-time-token" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("COMPANION_AUTH_TOKEN=real-secret\n");
    // Consumption = the same UPDATE nulls the hash + expiry, so a replay finds nothing.
    expect(setMock).toHaveBeenCalledWith({ bootstrapTokenHash: null, bootstrapTokenExpiresAt: null });
    expect(whereMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown, expired or already-used token with 401", async () => {
    returningMock.mockResolvedValue([]);
    const res = await instanceBootstrap.request("/", {
      method: "POST",
      headers: { Authorization: "Bearer used-token" },
    });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("COMPANION_AUTH_TOKEN");
  });

  it("rejects a request without a bearer token and never touches the DB", async () => {
    const res = await instanceBootstrap.request("/", { method: "POST" });
    expect(res.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("strips newlines from secret values so they cannot inject extra env lines", async () => {
    returningMock.mockResolvedValue([{ id: "inst-1", authSecret: "abc\nEVIL=1" }]);
    const res = await instanceBootstrap.request("/", {
      method: "POST",
      headers: { Authorization: "Bearer t" },
    });
    expect(await res.text()).toBe("COMPANION_AUTH_TOKEN=abcEVIL=1\n");
  });
});
