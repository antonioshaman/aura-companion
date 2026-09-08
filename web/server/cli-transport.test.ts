import { describe, it, expect, vi } from "vitest";
import {
  WebSocketCliTransport,
  StdioCliTransport,
  createLineAccumulator,
  pumpStdoutLines,
  type StdinSink,
} from "./cli-transport.js";

/**
 * The transport seam is what lets ClaudeAdapter's ~1600 lines of protocol
 * translation stay identical across the WebSocket and stdio control channels.
 * These cover the two implementations and the line buffering that makes a pipe
 * behave like a message-framed socket.
 */

function makeSink(): StdinSink & { written: string[]; flushes: number; ended: number } {
  const written: string[] = [];
  return {
    written,
    flushes: 0,
    ended: 0,
    write(chunk: string) { written.push(chunk); },
    flush() { this.flushes++; },
    end() { this.ended++; },
  };
}

describe("WebSocketCliTransport", () => {
  function makeWs(readyState = 1, buffered = 0) {
    return {
      readyState,
      send: vi.fn(),
      close: vi.fn(),
      getBufferedAmount: vi.fn(() => buffered),
    };
  }

  it("delegates send/close and reports open state from readyState", () => {
    const ws = makeWs(1);
    const t = new WebSocketCliTransport(ws as never);

    t.send('{"type":"user"}\n');
    expect(ws.send).toHaveBeenCalledWith('{"type":"user"}\n');
    expect(t.isOpen()).toBe(true);

    t.close();
    expect(ws.close).toHaveBeenCalled();
  });

  it("reports not-open for any readyState other than OPEN(1)", () => {
    // CONNECTING(0) matters: a socket attached but not yet open must not be
    // treated as writable, which is the gate sendUserFrameFromServer relies on.
    for (const state of [0, 2, 3]) {
      expect(new WebSocketCliTransport(makeWs(state) as never).isOpen()).toBe(false);
    }
  });

  it("surfaces the socket's buffered amount as backpressure", () => {
    const t = new WebSocketCliTransport(makeWs(1, 4096) as never);
    expect(t.bufferedAmount()).toBe(4096);
  });

  it("exposes the raw socket for the adapter's stale-detach guard", () => {
    const ws = makeWs();
    expect(new WebSocketCliTransport(ws as never).raw).toBe(ws);
  });
});

describe("StdioCliTransport", () => {
  it("writes AND flushes every frame", () => {
    // An unflushed frame is a hang, not a delay: the CLI blocks reading stdin
    // until it sees a complete line.
    const sink = makeSink();
    const t = new StdioCliTransport(sink, "sess-1");

    t.send('{"type":"user"}\n');

    expect(sink.written).toEqual(['{"type":"user"}\n']);
    expect(sink.flushes).toBe(1);
  });

  it("is open until closed, then refuses to write", () => {
    const sink = makeSink();
    const t = new StdioCliTransport(sink, "sess-1");
    expect(t.isOpen()).toBe(true);

    t.close();

    expect(t.isOpen()).toBe(false);
    expect(sink.ended).toBe(1);
    expect(() => t.send("x\n")).toThrow(/closed/);
  });

  it("close() is idempotent — a second call does not re-end the pipe", () => {
    const sink = makeSink();
    const t = new StdioCliTransport(sink, "sess-1");
    t.close();
    t.close();
    expect(sink.ended).toBe(1);
  });

  it("markClosed() kills the channel without touching a dead pipe", () => {
    // The launcher's exit handler uses this: end() on a dead pipe throws EPIPE.
    const sink = makeSink();
    const t = new StdioCliTransport(sink, "sess-1");

    t.markClosed();

    expect(t.isOpen()).toBe(false);
    expect(sink.ended).toBe(0);
  });

  it("survives a sink whose end() throws", () => {
    const sink = makeSink();
    sink.end = () => { throw new Error("EPIPE"); };
    const t = new StdioCliTransport(sink, "sess-1");
    expect(() => t.close()).not.toThrow();
    expect(t.isOpen()).toBe(false);
  });

  it("reports zero backpressure rather than a fabricated number", () => {
    // A pipe exposes no queue depth, so the adapter's backpressure gate is a
    // no-op here instead of a lie.
    expect(new StdioCliTransport(makeSink(), "s").bufferedAmount()).toBe(0);
  });
});

describe("createLineAccumulator", () => {
  it("emits only complete lines and buffers the partial tail", () => {
    const out: string[] = [];
    const acc = createLineAccumulator((c) => out.push(c));

    acc.push('{"a":1}\n{"b":');
    expect(out).toEqual(['{"a":1}\n']);

    acc.push('2}\n');
    expect(out).toEqual(['{"a":1}\n', '{"b":2}\n']);
  });

  it("emits nothing while no newline has arrived", () => {
    const out: string[] = [];
    const acc = createLineAccumulator((c) => out.push(c));
    acc.push('{"partial"');
    acc.push(":true");
    expect(out).toEqual([]);
  });

  it("reassembles a frame split across many chunks", () => {
    const out: string[] = [];
    const acc = createLineAccumulator((c) => out.push(c));
    for (const ch of '{"type":"system"}\n') acc.push(ch);
    expect(out.join("")).toBe('{"type":"system"}\n');
  });

  it("flush() releases a trailing line that never got its newline", () => {
    // The child exited mid-write; the last frame is still worth delivering.
    const out: string[] = [];
    const acc = createLineAccumulator((c) => out.push(c));
    acc.push('{"tail":1}');
    expect(out).toEqual([]);
    acc.flush();
    expect(out).toEqual(['{"tail":1}']);
  });

  it("flush() is a no-op when the tail is empty or whitespace", () => {
    const out: string[] = [];
    const acc = createLineAccumulator((c) => out.push(c));
    acc.push("\n  \n");
    acc.flush();
    acc.flush();
    expect(out).toEqual([]);
  });
});

describe("pumpStdoutLines", () => {
  function streamOf(chunks: string[], failWith?: Error): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(c) {
        for (const s of chunks) c.enqueue(enc.encode(s));
        if (failWith) c.error(failWith);
        else c.close();
      },
    });
  }

  it("pumps whole lines to the sink and resolves at EOF", async () => {
    const out: string[] = [];
    await pumpStdoutLines(streamOf(['{"a":1}\n{"b":', '2}\n']), (c) => out.push(c));
    expect(out.join("")).toBe('{"a":1}\n{"b":2}\n');
  });

  it("flushes an unterminated trailing line at EOF", async () => {
    const out: string[] = [];
    await pumpStdoutLines(streamOf(['{"a":1}']), (c) => out.push(c));
    expect(out).toEqual(['{"a":1}']);
  });

  it("routes a stream error to onError instead of rejecting", async () => {
    // A broken pipe is a normal end-of-session, not an unhandled rejection.
    const errs: unknown[] = [];
    await expect(
      pumpStdoutLines(streamOf(['{"a":1}\n'], new Error("EPIPE")), () => {}, (e) => errs.push(e)),
    ).resolves.toBeUndefined();
    expect(errs).toHaveLength(1);
  });

  it("does not throw when a stream error arrives with no onError handler", async () => {
    await expect(
      pumpStdoutLines(streamOf([], new Error("boom")), () => {}),
    ).resolves.toBeUndefined();
  });

  it("decodes a multi-byte character split across chunk boundaries", async () => {
    // TextDecoder({stream:true}) must hold the partial code point; otherwise a
    // Cyrillic/emoji frame corrupts into replacement characters.
    const enc = new TextEncoder();
    const bytes = enc.encode('{"t":"привет"}\n');
    const cut = 9;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, cut));
        c.enqueue(bytes.slice(cut));
        c.close();
      },
    });
    const out: string[] = [];
    await pumpStdoutLines(stream, (c) => out.push(c));
    expect(out.join("")).toBe('{"t":"привет"}\n');
  });
});
