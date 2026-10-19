/** Small, pure formatting helpers for the Diagnostics cards (pinned `now` in tests). */

export function ago(now: number, t: number | null | undefined): string {
  if (t === null || t === undefined) return "never";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Whole minutes between two times, for labels like "silent 20m". */
export function minutesBetween(now: number, t: number): number {
  return Math.max(0, Math.floor((now - t) / 60_000));
}

export function clock(t: number | null | undefined): string {
  if (t === null || t === undefined) return "—";
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dateTime(t: number | null | undefined): string {
  if (t === null || t === undefined) return "—";
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function uptime(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}
