import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "../../api.js";
import type { StatusSnapshot } from "../../../server/auth-status/status-core.js";
import {
  PROVIDER_IDS,
  type DoctorBinary,
  type DoctorFinding,
  type DoctorPlace,
  type DoctorReport,
  type ProviderAuthStatus,
  type ProviderDoctorResult,
} from "../../../server/auth-status/auth-types.js";
import {
  describeAuthState,
  describeDoctorClear,
  describeDoctorFinding,
  describeDoctorUnchecked,
  doctorPlaceLabel,
  formatAction,
  formatKnown,
  providerLabel,
} from "../../../server/auth-status/auth-catalog.js";
import { ago, dateTime } from "./format.js";

/**
 * "LLM sign-in" card on the Diagnostics page (LLM auth phase 1, task 14;
 * spec stories 1 + 2). Shows the status of BOTH providers and the doctor
 * report, every text through the shared catalog — the same words the
 * `aura-companion auth status` / `doctor` CLI prints.
 *
 * GET endpoints are the server's cache only, so the card loads them once on
 * mount and never polls; "Check" / "Run doctor" are explicit POSTs (a probe
 * can cost a CLI spawn and is rate-limited server-side: a 429 still carries
 * the cached result and is shown as "checked recently"). Unknown fields are
 * the word "unknown", never blank.
 */

export type LlmAuthLoad<T> = { tag: "loading" } | { tag: "ready"; data: T | null } | { tag: "failed"; message: string };
type Busy = "none" | "status" | "doctor";

const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : String(e));
const buttonClass =
  "shrink-0 px-3 py-2 min-h-[36px] rounded-lg text-xs font-medium bg-cc-active text-cc-fg hover:bg-cc-hover cursor-pointer disabled:opacity-50 disabled:cursor-default";

function placeText(p: DoctorPlace): string {
  const path = p.homeUser ? `~${p.homeUser}/${p.relPath}` : p.relPath;
  return `${path} (${doctorPlaceLabel(p.place)})`;
}

function binaryText(b: DoctorBinary): string {
  return `${placeText(b.location)} · version ${formatKnown(b.version)}`;
}

function findingFact(f: DoctorFinding): string {
  switch (f.kind) {
    case "binary_divergence":
      return `Launched: ${binaryText(f.launched)}${f.reference ? ` · installed: ${binaryText(f.reference)}` : ""}`;
    case "cli_outdated":
      return `Launched: ${binaryText(f.launched)} · required ${f.required} or newer`;
    case "credential_copy":
      return `Copy: ${placeText(f.copy)}, owner ${f.copy.owner}`;
    case "credential_foreign_owner":
    case "credential_unreadable":
      return `File: ${placeText(f.file)}, owner ${f.file.owner}; service user ${f.serviceUser}`;
    default: {
      const never: never = f;
      throw new Error(`unhandled doctor finding ${JSON.stringify(never)}`);
    }
  }
}

function ProviderStatus({ s, now }: { s: ProviderAuthStatus; now: number }) {
  const entry = describeAuthState(s.state, s.provider, s.reason);
  // "retry" IS the card's Check button; repeating the bare word adds nothing.
  const action = entry.action.kind === "retry" ? "" : formatAction(entry.action);
  const bad = s.state === "invalid" || s.state === "not_signed_in";
  return (
    <div className="space-y-1" data-testid={`llm-auth-status-${s.provider}`} data-state={s.state}>
      <p className={`text-[13px] font-medium ${bad ? "text-cc-error" : s.state === "working" ? "text-cc-success" : "text-cc-warning"}`}>
        {entry.title}
      </p>
      <p className="text-xs text-cc-muted">{entry.detail}</p>
      {action && <p className="text-xs text-cc-fg break-words">{action}</p>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-cc-muted">Account</dt>
        <dd className="text-cc-fg break-all">{formatKnown(s.account)}</dd>
        <dt className="text-cc-muted">Plan</dt>
        <dd className="text-cc-fg">{formatKnown(s.plan)}</dd>
        <dt className="text-cc-muted">Sign-in</dt>
        <dd className="text-cc-fg">{formatKnown(s.method)}</dd>
        <dt className="text-cc-muted">Token expires</dt>
        <dd className="text-cc-fg tabular-nums">{formatKnown(s.tokenExpiresAt, dateTime)}</dd>
        <dt className="text-cc-muted">Last successful check</dt>
        <dd className="text-cc-fg tabular-nums">{s.lastSuccessAt === null ? "never" : `${dateTime(s.lastSuccessAt)} (${ago(now, s.lastSuccessAt)})`}</dd>
        <dt className="text-cc-muted">Checked</dt>
        <dd className="text-cc-fg tabular-nums">
          {dateTime(s.checkedAt)} ({s.verifiedBy === "provider" ? "with the provider" : "local only"})
        </dd>
        <dt className="text-cc-muted">CLI</dt>
        <dd className="text-cc-fg font-mono-code break-all">
          {formatKnown(s.cli.path)} {formatKnown(s.cli.version)}
        </dd>
      </dl>
    </div>
  );
}

function ProviderDoctor({ r }: { r: ProviderDoctorResult }) {
  return (
    <div className="space-y-1" data-testid={`llm-auth-doctor-${r.provider}`}>
      <p className="text-xs text-cc-muted">
        CLI: {r.launched ? binaryText(r.launched) : "not found on the service PATH"} · required:{" "}
        {formatKnown(r.requiredVersion, (v) => `${v} or newer`)}
      </p>
      <ul className="space-y-1.5">
        {r.findings.map((f, i) => {
          const e = describeDoctorFinding(f.kind, r.provider);
          const action = formatAction(e.action);
          return (
            <li key={`f${i}`} className="text-xs">
              <p className="text-cc-warning font-medium">{e.title}</p>
              <p className="text-cc-muted">{e.detail}</p>
              <p className="text-cc-fg font-mono-code break-all">{findingFact(f)}</p>
              {action && <p className="text-cc-fg break-words">{action}</p>}
            </li>
          );
        })}
        {r.unchecked.map((u, i) => {
          const e = describeDoctorUnchecked(u.check, u.reason, r.provider);
          const action = formatAction(e.action);
          return (
            <li key={`u${i}`} className="text-xs">
              <p className="text-cc-warning font-medium">{e.title}</p>
              <p className="text-cc-muted">
                {e.detail}
                {u.place ? ` ${placeText(u.place)}` : ""}
              </p>
              {action && <p className="text-cc-fg break-words">{action}</p>}
            </li>
          );
        })}
        {r.findings.length === 0 && r.unchecked.length === 0 && (
          <li className="text-xs text-cc-success">{describeDoctorClear(r.provider).title}</li>
        )}
      </ul>
    </div>
  );
}

/** Presentational: everything the card shows, for tests and the Playground. */
export function LlmAuthView({
  status,
  doctor,
  now,
  busy = "none",
  notice = null,
  onCheck,
  onDoctor,
}: {
  status: LlmAuthLoad<StatusSnapshot>;
  doctor: LlmAuthLoad<DoctorReport>;
  now: number;
  busy?: Busy;
  notice?: string | null;
  onCheck?: () => void;
  onDoctor?: () => void;
}) {
  const headingId = useId();
  return (
    <section
      id="diagnostics-llm-auth"
      aria-labelledby={headingId}
      aria-busy={busy !== "none" || undefined}
      className="rounded-xl border border-cc-border bg-cc-card p-4 sm:p-5 scroll-mt-4 space-y-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={headingId} className="text-sm font-semibold text-cc-fg">
            LLM sign-in
          </h2>
          <p className="text-[11px] text-cc-muted">Claude and Codex as the service user. Checks run only when you press a button.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" className={buttonClass} onClick={onCheck} disabled={busy !== "none" || !onCheck}>
            {busy === "status" ? "Checking…" : "Check"}
          </button>
          <button type="button" className={buttonClass} onClick={onDoctor} disabled={busy !== "none" || !onDoctor}>
            {busy === "doctor" ? "Running…" : "Run doctor"}
          </button>
        </div>
      </div>
      {notice && <p className="text-[11px] text-cc-warning">{notice}</p>}

      {status.tag === "loading" && <p className="text-xs text-cc-muted">Loading…</p>}
      {status.tag === "failed" && <p className="text-xs text-cc-error">Source unavailable: the status request failed ({status.message}).</p>}
      {status.tag === "ready" && status.data === null && (
        <p className="text-xs text-cc-muted">Not checked yet since the server started. Press “Check”.</p>
      )}
      {status.tag === "ready" && status.data !== null && (
        <div className="grid gap-4 sm:grid-cols-2">
          {PROVIDER_IDS.map((id) => (
            <ProviderStatus key={id} s={status.data!.providers[id]} now={now} />
          ))}
        </div>
      )}

      <div className="border-t border-cc-border pt-3 space-y-2">
        <h3 className="text-xs font-semibold text-cc-fg">Doctor</h3>
        {doctor.tag === "loading" && <p className="text-xs text-cc-muted">Loading…</p>}
        {doctor.tag === "failed" && <p className="text-xs text-cc-error">Source unavailable: the doctor request failed ({doctor.message}).</p>}
        {doctor.tag === "ready" && doctor.data === null && (
          <p className="text-xs text-cc-muted">No doctor report yet. Press “Run doctor”.</p>
        )}
        {doctor.tag === "ready" && doctor.data !== null && (
          <>
            <p className="text-[11px] text-cc-muted">
              Report from {dateTime(doctor.data.checkedAt)} as {doctor.data.serviceUser ?? "unknown user"}.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {PROVIDER_IDS.map((id) => (
                <div key={id} className="space-y-1">
                  <h4 className="text-xs font-medium text-cc-fg">{providerLabel(id)}</h4>
                  <ProviderDoctor r={doctor.data!.providers[id]} />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function tooSoon(retryAfterMs: number | undefined): string {
  const s = Math.max(1, Math.ceil((retryAfterMs ?? 0) / 1000));
  return `Checked recently — showing that result. You can check again in ${s}s.`;
}

/** Container: one GET of each cache on mount, POST on button press only. */
export function LlmAuthCard() {
  const [status, setStatus] = useState<LlmAuthLoad<StatusSnapshot>>({ tag: "loading" });
  const [doctor, setDoctor] = useState<LlmAuthLoad<DoctorReport>>({ tag: "loading" });
  const [busy, setBusy] = useState<Busy>("none");
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    api.llmAuthStatus().then(
      (r) => mounted.current && setStatus({ tag: "ready", data: r.status }),
      (e) => mounted.current && setStatus({ tag: "failed", message: errText(e) }),
    );
    api.llmAuthDoctor().then(
      (r) => mounted.current && setDoctor({ tag: "ready", data: r.report }),
      (e) => mounted.current && setDoctor({ tag: "failed", message: errText(e) }),
    );
    return () => {
      mounted.current = false;
    };
  }, []);

  const onCheck = useCallback(() => {
    setBusy("status");
    setNotice(null);
    api
      .llmAuthRecheck()
      .then(({ status: code, body }) => {
        if (!mounted.current) return;
        setNow(Date.now());
        if (code === 200 || code === 429) {
          if (body.status !== undefined) setStatus({ tag: "ready", data: body.status ?? null });
          if (code === 429) setNotice(tooSoon(body.retryAfterMs));
          return;
        }
        setNotice(`Check failed (HTTP ${code}${body.error ? `: ${body.error}` : ""}).`);
      })
      .catch((e) => mounted.current && setNotice(`Check failed: ${errText(e)}.`))
      .finally(() => mounted.current && setBusy("none"));
  }, []);

  const onDoctor = useCallback(() => {
    setBusy("doctor");
    setNotice(null);
    api
      .llmAuthDoctorRecheck()
      .then(({ status: code, body }) => {
        if (!mounted.current) return;
        setNow(Date.now());
        if (code === 200 || code === 429) {
          if (body.report !== undefined) setDoctor({ tag: "ready", data: body.report ?? null });
          if (code === 429) setNotice(tooSoon(body.retryAfterMs));
          return;
        }
        setNotice(`Doctor failed (HTTP ${code}${body.error ? `: ${body.error}` : ""}).`);
      })
      .catch((e) => mounted.current && setNotice(`Doctor failed: ${errText(e)}.`))
      .finally(() => mounted.current && setBusy("none"));
  }, []);

  return <LlmAuthView status={status} doctor={doctor} now={now} busy={busy} notice={notice} onCheck={onCheck} onDoctor={onDoctor} />;
}
