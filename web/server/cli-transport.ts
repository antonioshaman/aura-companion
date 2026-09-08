/**
 * Transport seam for the Claude Code CLI control channel.
 *
 * The CLI speaks the same NDJSON stream-json protocol regardless of how the
 * bytes travel. Historically Companion only ever carried it over a WebSocket
 * (`--sdk-url ws://localhost:<port>/ws/cli/<sessionId>`), so `ClaudeAdapter`
 * held a `ServerWebSocket` directly.
 *
 * Claude Code >= 2.1.121 rejects `--sdk-url` for any host outside a compiled-in
 * Anthropic allowlist (`api`, `api-staging`, `api-pr-preview`.anthropic.com), so
 * the WebSocket control channel cannot be used with a current CLI at all. The
 * documented transport — `--print --input-format stream-json --output-format
 * stream-json` over the child's own stdin/stdout — carries an identical frame
 * vocabulary (`system.init`, `stream_event`, `assistant`, `user`, `result`) and
 * supports `--resume`, so the protocol layer above is unchanged.
 *
 * This module isolates the two ends of the pipe behind {@link CliTransport} so
 * the adapter's ~1600 lines of translation logic stay transport-agnostic.
 */

import type { ServerWebSocket } from "bun";
import type { SocketData } from "./ws-bridge-types.js";

/**
 * Minimal write-side contract the adapter needs from a CLI control channel.
 *
 * `raw` exists solely for the stale-detach guard: the adapter must be able to
 * ask "is the transport being detached the one I currently hold?" without
 * knowing what kind of transport it is.
 */
export interface CliTransport {
  readonly kind: "ws" | "stdio";
  /** Identity handle for stale-detach comparison. Never dereferenced. */
  readonly raw: unknown;
  /** Write one already-newline-terminated NDJSON frame. */
  send(data: string): void;
  /** True when the channel is established AND writable right now. */
  isOpen(): boolean;
  /** Bytes queued but not yet flushed to the peer (backpressure signal). */
  bufferedAmount(): number;
  /** Close the channel. Idempotent. */
  close(): void;
}

/** WebSocket control channel — the pre-2.1.121 transport. */
export class WebSocketCliTransport implements CliTransport {
  readonly kind = "ws" as const;

  constructor(private readonly ws: ServerWebSocket<SocketData>) {}

  get raw(): unknown {
    return this.ws;
  }

  send(data: string): void {
    this.ws.send(data);
  }

  isOpen(): boolean {
    return this.ws.readyState === 1;
  }

  bufferedAmount(): number {
    return this.ws.getBufferedAmount();
  }

  close(): void {
    this.ws.close();
  }
}

/**
 * Write side of a spawned child's stdin.
 *
 * Bun exposes `Subprocess.stdin` as a `FileSink` when spawned with
 * `stdin: "pipe"`. Typed structurally so tests can pass a plain object.
 */
export interface StdinSink {
  write(chunk: string): void;
  flush?(): void;
  end?(): void;
}

/**
 * stdio control channel — the CLI's own stdin/stdout pipes.
 *
 * Unlike the WebSocket transport this one cannot reconnect: the pipes die with
 * the child. Liveness is therefore owned by the launcher, which calls
 * {@link markClosed} from the process-exit handler. `bufferedAmount()` is
 * always 0 — a pipe write either lands in the kernel buffer or blocks, and Bun
 * gives us no queue depth to report, so the adapter's backpressure gate is a
 * no-op here rather than a lie.
 */
export class StdioCliTransport implements CliTransport {
  readonly kind = "stdio" as const;
  private open = true;

  constructor(
    private readonly sink: StdinSink,
    private readonly sessionId: string,
  ) {}

  get raw(): unknown {
    return this.sink;
  }

  send(data: string): void {
    if (!this.open) {
      throw new Error(`stdio transport for session ${this.sessionId} is closed`);
    }
    this.sink.write(data);
    // FileSink buffers until flushed; the CLI blocks waiting for a complete
    // line, so an unflushed frame is a hang, not a delay.
    this.sink.flush?.();
  }

  isOpen(): boolean {
    return this.open;
  }

  bufferedAmount(): number {
    return 0;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    try {
      // Closing stdin is how the CLI learns the turn stream is over.
      this.sink.end?.();
    } catch {
      // Child may already be gone.
    }
  }

  /**
   * Mark the channel dead without writing to it — used by the launcher's
   * process-exit handler, where `end()` on a dead pipe would throw EPIPE.
   */
  markClosed(): void {
    this.open = false;
  }
}

/**
 * Accumulate stdout chunks and emit only whole lines.
 *
 * WebSocket preserved message boundaries for free, so `parseNDJSON` was always
 * handed complete frames. A pipe has no such guarantee: a chunk can split a
 * JSON object anywhere, and `parseNDJSON` would silently drop the fragment
 * (`JSON.parse` throws, the line is discarded). Buffering the tail is what
 * makes the two transports equivalent to everything upstream.
 */
export function createLineAccumulator(
  onLines: (chunk: string) => void,
): { push(chunk: string): void; flush(): void } {
  let tail = "";
  return {
    push(chunk: string): void {
      const combined = tail + chunk;
      const lastBreak = combined.lastIndexOf("\n");
      if (lastBreak < 0) {
        // No complete line yet — keep accumulating.
        tail = combined;
        return;
      }
      tail = combined.slice(lastBreak + 1);
      const complete = combined.slice(0, lastBreak + 1);
      if (complete.trim()) onLines(complete);
    },
    /** Emit a trailing line that never got its newline (child exited mid-write). */
    flush(): void {
      const rest = tail;
      tail = "";
      if (rest.trim()) onLines(rest);
    },
  };
}

/**
 * Pump a child's stdout into `onLines`, line-buffered, until EOF.
 *
 * Returns a promise that resolves when the stream ends. Errors are surfaced to
 * `onError` rather than thrown — a broken pipe is a normal end-of-session.
 */
export async function pumpStdoutLines(
  stream: ReadableStream<Uint8Array>,
  onLines: (chunk: string) => void,
  onError?: (err: unknown) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  const acc = createLineAccumulator(onLines);
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) acc.push(decoder.decode(value, { stream: true }));
    }
    acc.flush();
  } catch (err) {
    onError?.(err);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released.
    }
  }
}
