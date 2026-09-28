/**
 * The orchestrator's `intentionalKills` set, with ownership for the one mark
 * that is meant to be temporary (P4/FIX-AUTOHEAL-1).
 *
 * A relaunch marks its own session intentional while it SIGTERMs the old
 * process (CR-12: no reconnect flicker) and must clear that mark afterwards,
 * or keepalive would stay locked out. Before this class the relaunch simply
 * `delete`d the id in its `finally` — which also wiped a mark that archive,
 * delete, a user kill or a group teardown had set WHILE the relaunch was
 * awaiting (EC-2: the session must stay down).
 *
 * `addTransient` records the relaunch's mark as transient; any plain `add`
 * (every other writer — unchanged call sites) turns it durable, and
 * `releaseTransient` only removes a mark that is still transient. It stays a
 * `Set<string>` so every existing `has`/`add`/`delete` reader keeps working.
 */
export class IntentionalKills extends Set<string> {
  private transient?: Set<string>;

  /**
   * Marks `sessionId` for the duration of a relaunch. Returns false when a
   * mark already existed — then the caller does not own it and must not
   * release it.
   */
  addTransient(sessionId: string): boolean {
    if (this.has(sessionId)) return false;
    super.add(sessionId);
    (this.transient ??= new Set()).add(sessionId);
    return true;
  }

  /** Removes the mark only if no durable writer claimed it meanwhile. */
  releaseTransient(sessionId: string): void {
    if (!this.transient?.delete(sessionId)) return;
    super.delete(sessionId);
  }

  isTransient(sessionId: string): boolean {
    return this.transient?.has(sessionId) ?? false;
  }

  override add(sessionId: string): this {
    this.transient?.delete(sessionId);
    return super.add(sessionId);
  }

  override delete(sessionId: string): boolean {
    this.transient?.delete(sessionId);
    return super.delete(sessionId);
  }

  override clear(): void {
    this.transient?.clear();
    super.clear();
  }
}
