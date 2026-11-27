import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";

it("opens one replacement socket when a Codex connection emits error and close", async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  let upgrades = 0;
  server.on("upgrade", (_request, socket) => {
    // A reserved opcode makes ws emit error followed by close on the same socket.
    if (++upgrades === 1) socket.write(Buffer.from([0x83, 0]));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const proxy = spawn("node", [
    fileURLToPath(new URL("./codex-ws-proxy.cjs", import.meta.url)),
    `ws://127.0.0.1:${address.port}`,
  ], { stdio: ["pipe", "pipe", "ignore"] });
  const exited = once(proxy, "close");
  const lines = createInterface({ input: proxy.stdout });
  const methods: string[] = [];
  lines.on("line", line => methods.push(JSON.parse(line).method));
  try {
    await expect.poll(() => methods).toContain("companion/wsReconnected");
    // Outwait both old retry timers (200 ms and 400 ms from the same failure).
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(upgrades).toBe(2);
    expect(methods).toEqual(["companion/wsReconnected"]);
  } finally {
    lines.close();
    proxy.kill();
    await exited;
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
