/** Shared UI/server safety boundary. External /learn writers do not share a lock. */
export const KB_ARCHIVE_UNAVAILABLE = "Archive is temporarily unavailable: external KB writers are not synchronized. Analysis, Keep and Mark for merge remain available.";

export class KbArchiveUnavailableError extends Error {
  constructor() { super(KB_ARCHIVE_UNAVAILABLE); this.name = "KbArchiveUnavailableError"; }
}

/** Fail closed before any intent, ledger or store mutation. No runtime bypass. */
export function assertKbArchiveAvailable(): void {
  throw new KbArchiveUnavailableError();
}
