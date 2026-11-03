/** Browser-safe portable contract. These limits apply to both import and export. */
export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const MAX_DRAFT_BYTES = 24 * 1024;
export const MAX_SESSIONS = 200;
export const MAX_MESSAGES = 50_000;
export const MAX_DEPTH = 32;
export const MAX_STRING_BYTES = 16 * 1024 * 1024;
export const MAX_JSON_NODES = 250_000;
export type PortableJson = null | boolean | number | string | PortableJson[] | { [key: string]: PortableJson };
export interface PortableMessage {
  role: "user" | "assistant" | "tool" | "system" | "result";
  content: PortableJson;
  timestamp?: number;
  streamStatus?: "complete" | "interrupted" | "errored";
}
export interface PortableSession {
  id: string;
  project: string;
  backend: "claude" | "codex";
  model?: string;
  cliVersion?: string;
  /** Historical provenance only; never a working-directory instruction. */
  cwd?: string;
  messages: PortableMessage[];
}
export interface PortableArchive {
  format: "aura-portable-history";
  version: 1;
  exportedAt: string;
  redactionVersion: number;
  exclusions: string[];
  sessions: PortableSession[];
}
export interface PortableSource {
  id: string;
  project: string;
  cwd?: string;
  backend: "claude" | "codex";
  model?: string;
  cliVersion?: string;
  messageHistory: unknown[];
}
export interface ContinuationDraft {
  text: string;
  omittedMessages: number;
  omittedAttachments: number;
  truncated: boolean;
}
