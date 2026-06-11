import type { BrowserIncomingMessage } from "./session-types.js";
import type { Session } from "./ws-bridge-types.js";
import type { SessionStore, PersistedSession } from "./session-store.js";

// ─── Persistence Pipeline ───────────────────────────────────────────────────
// Extracted from WsBridge to consolidate history append + disk persistence
// into explicit, testable functions.

export const MESSAGE_HISTORY_LIMIT = 2000;

/**
 * In-memory retention for archived sessions.
 *
 * Active sessions retain up to MESSAGE_HISTORY_LIMIT messages so the user
 * can scroll back through a long conversation without hitting the cap.
 * Archived sessions, however, sit in the in-memory `sessions` Map until
 * server restart and accumulate across the box's uptime — on a long-uptime
 * host with many archived sessions this is the dominant contribution to
 * the bun parent's RSS (observed 75,921 totalHistoryMessages across ~38
 * sessions on a 58-day-uptime box, vs the 10 active × 2000 = 20,000
 * upper bound that would apply if archived state were not retained).
 *
 * On archive (and on restore-from-disk for any session already flagged
 * archived), trim the in-memory copy to the last ARCHIVED_HISTORY_RETENTION
 * messages. The on-disk persisted state is untouched — unarchive can
 * lazily rehydrate if a deeper scroll-back is ever wired up, and raw
 * protocol recordings under `~/.companion/recordings/` are the durable
 * source of truth either way.
 */
export const ARCHIVED_HISTORY_RETENTION = 100;

/**
 * Trim an archived session's in-memory state to bounded retention.
 * Mutates the session in place. eventBuffer is cleared entirely — it
 * is a transient replay buffer for live browser resync, not authoritative
 * state, and is zero-value once the session is archived.
 */
export function trimArchivedSessionState(
  session: Session,
  retention: number = ARCHIVED_HISTORY_RETENTION,
): void {
  // Mark the bridge-local archived bit. This is the single chokepoint hit by
  // BOTH archive paths: live archive (`trimArchivedSessionMemory`) and restore
  // of an already-archived row on boot. Downstream, `handleBrowserConnect`
  // reads it to suppress the synthetic `group_created` replay + relaunch
  // request so an archived Council half cannot be resurrected as a ghost group.
  session.archived = true;
  if (session.messageHistory.length > retention) {
    session.messageHistory.splice(0, session.messageHistory.length - retention);
  }
  if (session.eventBuffer.length > 0) {
    session.eventBuffer = [];
  }
}

/**
 * Append a message to session history with cap enforcement, then persist to disk.
 * Consolidates the common appendHistory + persistSession pattern into one call,
 * eliminating the risk of appending without persisting.
 */
export function appendAndPersist(
  session: Session,
  msg: BrowserIncomingMessage,
  store: SessionStore | null,
  historyLimit: number = MESSAGE_HISTORY_LIMIT,
): void {
  appendHistory(session, msg, historyLimit);
  persistSession(session, store);
}

/**
 * Append a message to session history with cap enforcement.
 * Trims oldest messages when the history exceeds the limit.
 */
export function appendHistory(
  session: Session,
  msg: BrowserIncomingMessage,
  historyLimit: number = MESSAGE_HISTORY_LIMIT,
): void {
  session.messageHistory.push(msg);
  if (session.messageHistory.length > historyLimit) {
    session.messageHistory.splice(0, session.messageHistory.length - historyLimit);
  }
}

/**
 * Persist session state to disk (debounced via SessionStore).
 * No-op if no store is attached.
 */
export function persistSession(session: Session, store: SessionStore | null): void {
  if (!store) return;
  store.save(serializeForStore(session));
}

/**
 * Serialize a Session into the shape expected by SessionStore.save().
 * Converts Maps to arrays and selects the persisted fields.
 */
export function serializeForStore(session: Session): PersistedSession {
  return {
    id: session.id,
    state: session.state,
    messageHistory: session.messageHistory,
    pendingMessages: session.pendingMessages,
    pendingPermissions: Array.from(session.pendingPermissions.entries()),
    eventBuffer: session.eventBuffer,
    nextEventSeq: session.nextEventSeq,
    lastAckSeq: session.lastAckSeq,
    processedClientMessageIds: session.processedClientMessageIds,
  };
}
