/**
 * Recover observer review documents from raw protocol recordings (P3/B3).
 *
 * The label queue must be fed from what observers ACTUALLY emitted in prod,
 * and `~/.companion/recordings/` is the only durable, cross-workspace record of
 * that (review files live in each project's `.council/reviews/` and are
 * overwritten per checkpoint). A review reaches the wire in one of three shapes:
 *
 *   1. Claude legacy — the observer `Write`s `.council/reviews/<x>.md`; the
 *      full JSON is in the `tool_use.input.content` of an `assistant` frame.
 *   2. Codex legacy — a `fileChange` item whose change `kind.type === "add"`;
 *      for an add, `diff` is the whole new file.
 *   3. B1 host envelope — the observer replies with a bare findings array as
 *      its final message (Claude `result.result`, Codex `agentMessage.text`);
 *      the checkpoint coordinates come from the preceding wake manifest, the
 *      same way the host builds the envelope.
 *
 * Anything else that touches a review file (Claude `Edit`, Codex `update`
 * patches, shell redirects) carries no complete document and is COUNTED in
 * `unrecoverable`, never guessed at.
 *
 * Firewall-clean: knows only the on-disk JSONL + frame shapes, never `server/`.
 */

import type { LoadedRecording } from "./read-recording.js";

export interface RecoveredReview {
  /** Where it came from, for the sheet: `<recording>#<shape>@<ts>`. */
  name: string;
  /** Review JSON text, verbatim for legacy shapes so finding ids match the
   *  on-disk extractor; host-shaped envelope for B1 replies. */
  text: string;
  /** Frame timestamp (ms) — the latest write of one review key wins. */
  ts: number;
}

export interface RecoveryResult {
  reviews: RecoveredReview[];
  /** Review-file writes seen whose full content is not in the frame. */
  unrecoverable: number;
}

interface WakeContext {
  session_group_id: string;
  checkpoint_id: string;
  phase: string;
}

const REVIEW_PATH = /(^|\/)\.council\/reviews\/[^/]+\.md$/;
const WAKE_JSON = /```json\s*\n(\{[\s\S]*?"observer_wake_payload_version"[\s\S]*?\})\s*\n```/;

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Wake manifest embedded in a checkpoint prompt, or null. */
export function parseWakeText(text: string): WakeContext | null {
  const m = WAKE_JSON.exec(text);
  if (!m) return null;
  try {
    const w = obj(JSON.parse(m[1]!));
    if (!w || str(w.checkpoint_id) === "" || str(w.session_group_id) === "") return null;
    return { session_group_id: str(w.session_group_id), checkpoint_id: str(w.checkpoint_id), phase: str(w.phase) };
  } catch {
    return null;
  }
}

/**
 * A B1 reply: a JSON array of findings, optionally inside one code fence.
 * Returns null for anything else (prose, a legacy envelope in chat is handled
 * by the caller as a plain review document).
 */
export function parseFindingsReply(text: string): unknown[] | null {
  let t = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(t);
  if (fence) t = fence[1]!.trim();
  if (!t.startsWith("[")) return null;
  try {
    const v: unknown = JSON.parse(t);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function textsOf(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((c) => {
    const o = obj(c);
    return o && o.type === "text" && typeof o.text === "string" ? [o.text] : [];
  });
}

export function recoverObserverReviews(rec: LoadedRecording, label: string): RecoveryResult {
  const reviews: RecoveredReview[] = [];
  let unrecoverable = 0;
  let wake: WakeContext | null = null;
  let model = "";
  const provider = rec.backendType;

  const pushReply = (text: string, ts: number, shape: string): void => {
    const findings = parseFindingsReply(text);
    if (findings === null || wake === null) return;
    const envelope = {
      ...wake,
      observer_provider: provider,
      observer_model: model,
      reviewed_at: new Date(ts).toISOString(),
      findings,
    };
    reviews.push({ name: `${label}#${shape}@${ts}`, text: JSON.stringify(envelope), ts });
  };

  for (const e of rec.entries) {
    // Only the CLI channel: browser-out frames mirror the same content and
    // would double every review.
    if (e.ch !== "cli") continue;
    let f: Record<string, unknown> | null;
    try {
      f = obj(JSON.parse(e.raw));
    } catch {
      continue;
    }
    if (!f) continue;

    if (e.dir === "out") {
      // Wakes: Claude `user` frame / Codex `turn/start` input.
      const texts =
        f.type === "user"
          ? textsOf(obj(f.message)?.content)
          : f.method === "turn/start"
            ? textsOf(obj(f.params)?.input)
            : [];
      for (const t of texts) wake = parseWakeText(t) ?? wake;
      continue;
    }

    if (f.type === "assistant") {
      const msg = obj(f.message);
      if (typeof msg?.model === "string") model = msg.model;
      for (const c of Array.isArray(msg?.content) ? msg.content : []) {
        const tu = obj(c);
        if (!tu || tu.type !== "tool_use") continue;
        const input = obj(tu.input);
        const path = str(input?.file_path);
        if (!REVIEW_PATH.test(path)) continue;
        if (tu.name === "Write" && typeof input?.content === "string") {
          reviews.push({ name: `${label}#write@${e.ts}`, text: input.content, ts: e.ts });
        } else {
          unrecoverable++;
        }
      }
      continue;
    }

    if (f.type === "result" && typeof f.result === "string") {
      pushReply(f.result, e.ts, "reply");
      continue;
    }

    if (f.method === "item/completed") {
      const item = obj(obj(f.params)?.item);
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        pushReply(item.text, e.ts, "reply");
      } else if (item?.type === "fileChange" && Array.isArray(item.changes)) {
        for (const ch of item.changes) {
          const c = obj(ch);
          if (!c || !REVIEW_PATH.test(str(c.path))) continue;
          if (obj(c.kind)?.type === "add" && typeof c.diff === "string") {
            reviews.push({ name: `${label}#fileChange@${e.ts}`, text: c.diff, ts: e.ts });
          } else {
            unrecoverable++;
          }
        }
      }
    }
  }
  return { reviews, unrecoverable };
}

/**
 * Collapse rewrites: an observer may write the same checkpoint's review more
 * than once (retry, rotation into a new recording). Only the LAST write per
 * (group, checkpoint, provider) is what the host consumed, so that one wins.
 * Unparseable docs are kept as-is (the extractor counts them as skipped).
 */
export function latestPerReview(reviews: RecoveredReview[]): RecoveredReview[] {
  const byKey = new Map<string, RecoveredReview>();
  const loose: RecoveredReview[] = [];
  for (const r of reviews) {
    let key: string | null = null;
    try {
      const d = obj(JSON.parse(r.text));
      if (d) key = `${str(d.session_group_id)}\0${str(d.checkpoint_id)}\0${str(d.observer_provider)}`;
    } catch {
      key = null;
    }
    if (key === null) {
      loose.push(r);
      continue;
    }
    const prev = byKey.get(key);
    if (!prev || r.ts >= prev.ts) byKey.set(key, r);
  }
  return [...byKey.values(), ...loose];
}
