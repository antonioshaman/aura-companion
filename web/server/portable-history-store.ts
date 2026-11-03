import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { writeAtomicJson } from "./atomic-write.js";
import { MAX_ARCHIVE_BYTES, parsePortableArchive, PortableHistoryError, type PortableArchive } from "./portable-history.js";

export interface PortableArchiveSummary {
  id: string;
  exportedAt: string;
  sessions: number;
  projects: string[];
}

// Canonical key order gives identical content the same id even after JSON tools
// reorder keys. Export timestamp is provenance, not identity of project evidence.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Inert archives never enter SessionStore or the launcher/bridge maps. */
export class PortableHistoryStore {
  private readonly root: string;
  constructor(directory: string) {
    const absolute = resolve(directory);
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
    if (lstatSync(absolute).isSymbolicLink()) throw new Error("Portable archive directory must not be a symlink.");
    this.root = realpathSync(absolute);
  }

  /** EC-7: resolve and check each filesystem access at this boundary. */
  private path(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new PortableHistoryError("invalid", "Invalid archive identifier.");
    const file = join(this.root, `${id}.json`);
    try {
      const st = lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || !realpathSync(file).startsWith(this.root + sep)) {
        throw new PortableHistoryError("invalid", "Archive storage entry is not a regular file.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return file;
  }

  import(raw: unknown): { id: string; duplicate: boolean } {
    const archive = parsePortableArchive(raw);
    const { exportedAt: _timestamp, ...evidence } = archive;
    // Hash AFTER redaction; never pass the service id through the text redactor.
    const id = createHash("sha256").update(canonical(evidence)).digest("hex");
    const file = this.path(id);
    try {
      statSync(file);
      // A corrupt existing object is an error, not a successful duplicate.
      this.get(id);
      return { id, duplicate: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    writeAtomicJson(file, archive, { maxBytes: MAX_ARCHIVE_BYTES });
    return { id, duplicate: false };
  }

  get(id: string): PortableArchive {
    const file = this.path(id);
    if (statSync(file).size > MAX_ARCHIVE_BYTES) throw new PortableHistoryError("limit", "Stored archive exceeds 32 MiB.");
    return parsePortableArchive(readFileSync(file, "utf8"));
  }

  list(): PortableArchiveSummary[] {
    return readdirSync(this.root).filter(file => /^[a-f0-9]{64}\.json$/.test(file)).map(file => {
      const id = file.slice(0, -5);
      const archive = this.get(id);
      return { id, exportedAt: archive.exportedAt, sessions: archive.sessions.length, projects: [...new Set(archive.sessions.map(session => session.project))] };
    });
  }
}
