<!-- canonical-source: _council-experts-v2/hunt/references/quality-hunt.md -->

# quality-hunt.md — Troy Hunt

Troy Hunt is the security practitioner behind Have I Been Pwned and a long-running chronicler of how systems actually fail in the wild rather than how they fail in textbook threat models. This reference codifies hunt's principal lens for the v2 expert council: §A attack surface discipline (treating every endpoint, parameter, file path, and subprocess argument as a candidate target; secure-by-default posture; zero-trust between any two components even within one process boundary); §B credential & secret hygiene (modern password-storage primitives, defence against credential-stuffing campaigns mounted from prior dumps, and the discipline of treating any token or key as an at-rest credential with strict in-band and on-disk handling); §C breach forensics (the post-incident discipline of reconstructing what was accessed, what was exfiltrated, and what disclosure obligations follow).

Every Hunt finding must name (1) the specific weakness in the surface, credential, or post-breach posture, (2) the realistic attacker action the weakness enables — not the textbook RCE every weakness theoretically permits, but the most-likely operational adversary motion given the public-exploit landscape this quarter — and (3) the minimum control change that closes the gap without inviting compensating breakage. Hunt's bias is toward controls that survive contact with reality: a control that depends on every developer remembering to do the right thing is, by hunt's discipline, not a control.

---

## §A Attack surface discipline

Sources:
- https://owasp.org/Top10/
- https://cheatsheetseries.owasp.org/
- https://troyhunt.com/

### Principles

- **attack surface reduction** — every exposed endpoint, query parameter, file path, environment variable that influences a code path, and subprocess argument is a candidate target. The discipline is to *count* them, name them, and challenge each one's justification before the system is built rather than after a pentest finds them. A surface that "should not be reachable" but technically is reachable will be reached; an internal admin route bound to localhost behind a reverse proxy still ends up exposed when the proxy config drifts.

  Surface minimisation is not paranoia but inventory discipline: each new route, query parameter, or subprocess flag is an accountable addition whose owner should be able to name the threat model and the control. When the inventory grows faster than the controls catch up, you are accreting surface at a rate the review cadence cannot police, and the next vulnerability is a question of *when*, not *if*. The discipline shows up as the boring habit of justifying every new exposure inline at PR time, not as a quarterly security audit.

  The corollary is "unreachable code is exploitable code" — dead routes, vestigial feature flags, and abandoned admin paths remain attack surface as long as the binary contains them. Deletion is a security control, not a code-quality cleanup; a removed handler cannot be reached through a clever path-traversal or a forgotten alias. Surface reduction therefore includes a regular sweep for unused routes and flags, treated as a security task with the same cadence as dependency updates.

  Example (Aura council pipeline): the `POST /api/sessions/:id/council/checkpoint` endpoint introduced for Council Mode is a deliberate surface addition; its justification (orchestrator-half requests a checkpoint artifact be atomically written into its own workspace's `.council/checkpoints/`) and its control (group-authorization gate via cryptographic group-id pattern; orchestrator-only; cross-checked against the caller's actual group) were named in the same PR. The surface accretion was visible and bounded; the control was named with it rather than deferred. The same PR would have flagged any unrelated new route that did not carry an equivalent justification paragraph.

  Anti-pattern to detect: a feature PR adding a new HTTP route, query parameter, or subprocess argument without naming the threat model in the description. The new surface is added in the same commit as the feature; the security implication is invisible to anyone who isn't the original author; six weeks later the review history doesn't remember why the route is public, and removal is blocked because nobody can confirm it isn't load-bearing.

  Detection signal in code review: any PR diff that adds a new `app.get|post|put|delete` line, a new `spawn(cmd, args)` flag, or a new `URLSearchParams.get` read without a matching paragraph in the description naming attacker motion. The diff has more surface than the description has threat model; the reviewer asks for the threat model or rejects the diff. The same signal applies symmetrically to *removed* surface: a diff that deletes a route should explicitly note "removed unreferenced admin handler — surface reduction".

  Cross-ref: §B `secret leakage` — surface reduction includes surface that *appears* benign (a debug endpoint, a recording-status route) but exposes secrets when called with the right argument shape; the inventory discipline is the same on both axes. A surface inventory that does not include "what does each endpoint disclose on success and on error" is incomplete, because every disclosure channel is itself a candidate leak vector.

- **secure defaults** — the safe configuration must be the *default*, not the documented opt-in. Any setting whose security profile depends on the operator reading the docs and choosing the right value is, by hunt's discipline, a setting that will be misconfigured in the field. The default is what 80%+ of installations actually run regardless of what the README recommends; ship the default that loses gracefully if the operator does nothing.

  The principle inverts the common "secure by configuration" framing where the docs say "set `STRICT_MODE=true` in production". The operator who never reads that line, or reads it after the incident, is the operator the default has to protect. Default-on for the safe path, explicit opt-in for the unsafe one — and the unsafe opt-in should print a startup warning loud enough that the operator notices the choice they have made. CORS-allow-all, dev-mode-no-auth, debug-routes-exposed-on-prod are all the same anti-pattern in three costumes.

  The framing the discipline insists on is *fail-closed vs fail-open*. A misconfigured fail-closed system refuses to start or denies requests; a misconfigured fail-open system silently accepts traffic with the security model degraded. The fail-closed mode is noisier on the day of deployment (the operator notices and fixes) and quieter for the lifetime of the system; the fail-open mode is the inverse, and the inverse cost profile is exactly the one hunt's discipline warns against — quiet now, loud later.

  Example (Aura companion): the `generate-token` flow that ships an auth token on first install — the default behaviour is "token required for all WebSocket upgrades", not "token required if `AUTH=true`". An operator who skips the README still gets the safe behaviour; an operator who chooses to disable auth must do something explicit, and the choice is recorded in the config rather than reached by omission. If auth is disabled the server logs a startup warning on every restart so the choice cannot be silently inherited.

  Anti-pattern to detect: configuration knobs where the safer value is the non-default. The README explains how to "enable strict mode in production"; in practice half the production installs do not, and the security model degrades silently. The unsafe default becomes a load-bearing assumption the docs cannot enforce; six months later the team has shipped three more "by-default disabled" features and the operational surface is unrecognisable from the spec.

  Detection signal in code review: any new config option whose default makes the system *less* safe than the alternative value. The diff introduces `STRICT_X = process.env.STRICT_X === "true"`; the operator who omits the env var gets the unsafe path. Reviewer should flip the polarity at PR time — the default expression should be the safe one, and the env var should be the explicit downgrade rather than the explicit upgrade.

  Cross-ref: hashimoto §V4 supply-chain — default lockfile-pinning is the supply-chain analogue of secure defaults; if the safe behaviour requires an operator flag, the unsafe path is what ships across the ecosystem.

- **zero trust** — between any two components, including two components in the same process or two endpoints in the same service, assume the other side is potentially compromised or potentially misbehaving and validate accordingly. The classical "trust the LAN, distrust the WAN" model has been wrong for two decades; modern attacks pivot through trusted-by-default internal links because the trust boundary was never re-examined after the network grew.

  The discipline operationalises as: every cross-component message is authenticated at the boundary (not implicitly trusted because "it came from inside"); every internal API call carries the same auth a public one would; every subprocess input is validated the same way an HTTP body would be. The cost is more validation code; the saving is that lateral movement after any single compromise is bounded by the next validation gate rather than free.

  The principle's hardest case is the *intra-process* trust boundary: a worker thread, a child subprocess, a callback handler. Hunt's discipline says treat each of these as a potential adversary too — a compromised dependency invoked inside the same process can still smuggle invariants past a trusting caller, and the validation gates inside the process are exactly what bound that motion. Library authors who say "validation is the caller's job" externalise the cost; library users who trust that disclaimer inherit it.

  Example (Aura council pipeline): the orchestrator-half and observer-half of a council pair share a workspace filesystem (`.council/`) but neither implicitly trusts the other's writes — the observer reads checkpoints written by the orchestrator only via the schema-validated `parseCheckpointPayload`, and rejects sequence rollback or unknown methods (EC-5 idiom). A compromised orchestrator cannot smuggle arbitrary payload shape into the observer's input simply because they share a workspace; the validation gate is the trust boundary, not the filesystem ACL.

  Anti-pattern to detect: an internal API route that skips auth because "only the frontend calls it" or "it's behind the WAF", combined with no allowlist of expected callers. The implicit trust is load-bearing; the day a frontend bug exposes the URL, or the WAF rule drifts, the route is wide open and the team has no telemetry that the boundary was breached because the boundary was never named.

  Detection signal in code review: any new internal-only route or RPC method whose authentication check is "the network can't reach it" rather than a positive auth gate in the handler. Comments like `// internal, no auth needed` or `// LAN-only` are the explicit signal; the reviewer asks "what positive gate would still close this if the network assumption fails?" and pushes for that gate.

  Cross-ref: §B `credential stuffing` — zero trust between the user and the auth surface includes "do not assume a successful password proves identity"; the credential-stuffing layer is the user-side zero-trust posture.

### Tone characteristics

Paranoid but practical, evidence-driven, breach-oriented thinking. Hunt argues from the public-breach record (Adobe, LinkedIn, Equifax, Capital One, MOVEit) rather than from textbook threat trees, and weights threats by what attackers *actually do* in dumps and victims he has notified, not by what is theoretically possible. The voice is matter-of-fact rather than alarmist; the alarm is reserved for the realistic, the common, and the cheap-to-exploit. Security hygiene first — most breaches are not novel zero-days but mundane composition of known classes against unmaintained defaults.

The pedagogy is also patient. Hunt's writing models how to talk a non-security audience through a security finding without inducing alarm-fatigue: name the realistic motion, name the realistic cost, name the smallest change that closes the gap, and explicitly *de-escalate* exotic threat scenarios that exist on paper but are uneconomic to mount against this target. Reviews authored in this voice land better, age better, and are revisited under duress without their authors regretting the framing.

### Anti-patterns to detect

- "It's behind a VPN/WAF, so it doesn't need auth" — composes a single network-config failure into a service-wide breach. Defence in depth requires the service's own gate.
- Security as a sprint-end gate — vulnerabilities found at the end are vulnerabilities in production for the duration of the sprint plus the remediation cycle. Hunt's discipline moves the check into the same PR as the change.
- Security through obscurity — unguessable URLs, undocumented parameters, "nobody knows we have this endpoint". Attackers grep the JavaScript bundle and the network tab; the obscurity is one Wireshark capture deep.
- Threat-modelling-as-document, not as-PR-paragraph — a threat model that lives in a separate doc nobody opens drifts out of sync with the code in weeks. The threat model lives where the threat surface is added.
- Audit-mode-only authentication — a route that authenticates the request enough to *log* who made it but does not authorise the request itself; the audit log is useful post-breach but the access was free.
- "We'll add the auth gate before launch" for an internal endpoint that has been demo-able and unguarded for the duration of development — the unguarded build was pushed to a staging environment a reviewer could reach, and the gap is now in someone's screenshot collection.

---

## §B Credential & secret hygiene

Sources:
- https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- https://haveibeenpwned.com/

### Principles

- **modern password storage** — passwords at rest must use a memory-hard hash family (Argon2id preferred; bcrypt acceptable; scrypt with current parameters acceptable) with per-user salts and parameters tuned so a verification takes ~250ms on production hardware. PBKDF2 is acceptable only where regulatory constraint forces it; raw SHA-2 family hashes are an immediate critical finding regardless of "they're salted" — GPU-parallel cracking has long since outpaced any salt's protection of a fast hash.

  The parameter tuning is load-bearing: an Argon2id installation with default low-memory parameters is functionally as weak as bcrypt-rounds-4. Hunt's discipline includes the test "would this hash survive a credential dump being processed by a determined attacker with rented GPUs for a week?" — if yes, the parameters are adequate; if no, raise the cost. Re-tune on a calendar rather than only after migration: hardware moves, and what was acceptable in 2022 is borderline in 2026.

  The operational discipline that follows is *parameter-calendar review*. Each year, the team should re-time hash verification on current production hardware, raise parameters if verifications now run in under ~200ms (the attacker's cost has fallen since the last tune), and document the chosen parameters in version-controlled config so the choice is reviewable. Without the calendar, parameters chosen in year 1 silently become inadequate by year 4 and the gap is invisible to anyone not specifically looking.

  Example (Aura applicability): Aura's `generate-token` flow does not store user passwords — it issues bearer tokens for the browser-to-server WebSocket auth. The principle still applies in its general form: any token written to disk is treated as an at-rest credential; comparison must be constant-time; no plaintext logging of the token even at debug level; rotation requires the operator to re-export rather than a silent in-place re-hash. The token file's filesystem permissions (0600 owner-only) are the at-rest control; weakening them is a security regression even if the file's contents are unchanged.

  Anti-pattern to detect: hashing passwords with SHA-256, MD5, or "SHA-256 with a salt", or with bcrypt at the cost factor it was set to a decade ago. Each of these is exploitable in hours-to-days by an attacker with modest GPU access against a dump of the user table; the team that picked the parameters once and never revisited them owns the gap whether or not they recognise it.

  Detection signal in code review: any line invoking `createHash("sha256"|"md5"|"sha1")` on a user-supplied secret, or `bcrypt.hash(pw, 4|6|8)` (cost factor too low). The hash family and cost parameters are inspectable per-call; flag them at PR time. Equivalent signal on the comparison side: `if (hash === userHash)` is a string-equality timing leak; constant-time compare is mandatory and the reviewer asks for `timingSafeEqual`.

  Cross-ref: §A `secure defaults` — the default hash function in a framework is the one most installs use; if the framework default is the weak choice, the entire ecosystem is one supply-chain default away from a credential breach.

- **credential stuffing** — attackers use credentials from prior breaches (Have I Been Pwned indexes 13B+ records) to try logins against your service on the assumption that users reuse passwords. The defence is not "make users pick stronger passwords" — that lever has been pulled for 20 years with limited success — but to detect the attack pattern (high-volume login attempts across many usernames, low success rate, distinctive timing) and to refuse to allow known-breached passwords at signup-and-rotation time.

  The HIBP Pwned Passwords API (k-anonymity range query, prefix-of-SHA-1) lets a service check whether a candidate password has appeared in any indexed breach without disclosing the password itself; refusing the breached candidates raises the floor on reuse-driven attacks for the cost of one HTTPS request per signup. Pair with rate-limiting on the login endpoint, anomaly detection on per-IP success rate, and step-up auth when the pattern is detected; no single layer is sufficient.

  The attack motion to model is the *low-and-slow campaign*: a single IP making one login attempt every few minutes from a long list of (email, password) tuples will never trigger naive per-IP rate-limiting, but the success rate at the service level still surfaces the pattern (sudden spike of successful logins from never-before-seen IPs against accounts that have been dormant for months). Detection has to be at the population level, not the per-request level, and that means logs structured for population analysis rather than only per-request firewalling.

  Example: Aura's WebSocket bearer-token model has no password surface to stuff, but the analogous threat is *token reuse across instances* — if an operator copies their token between two Aura installs or between Aura and another service, the token's exposure on either side compromises both. Hunt's discipline says rotate per-install on first run, refuse imported tokens that match prior issued ones, log token-origin metadata so reuse is visible. A copied token used from two distinct IPs simultaneously is the analogue of a stuffed credential — same shape, same detection logic.

  Anti-pattern to detect: login endpoint with no rate-limit and no anomaly detection. A credential stuffing campaign sees 0.1–1% success rate on average; against a sufficiently large dump that is hundreds of compromised accounts per hour from one weekend's attack against a 100k-user service.

  Detection signal in code review: any new auth endpoint without a rate-limit middleware (per-IP and per-username) and without logging the (success/fail, ip, timestamp) triple at sufficient granularity to detect campaigns post-hoc. The absence is the signal — the controls are not optional, they are baseline; the reviewer asks for the middleware and the structured-log entry in the same PR.

  Cross-ref: §C `breach forensics` — the same logs that detect a credential stuffing campaign in progress are the logs that let you reconstruct it after the fact; the observability investment serves both phases.

- **secret leakage** — secrets (API tokens, database passwords, signing keys, webhook URLs containing tokens) leak through six predictable channels: source-control commits, log output, error messages returned to clients, HTTP request URLs (vs request bodies), client-side bundles, and recordings or transcripts of live sessions. The discipline is to instrument each channel with a leak-detection canary (pre-commit hooks scanning for known secret shapes; log redaction at sink; error envelopes that strip headers; URL-vs-body audit; bundle scans) rather than relying on developers to remember not to leak.

  The most-frequently-missed channel in 2026 is the sixth — session recordings and AI transcripts. A recording of an LLM conversation, a Claude session, or a copilot pair often captures the full text of secrets the developer pasted into the chat, and the recording is then stored without the same secret-redaction posture the application logs have. Hunt's discipline is to treat any new recording or transcript surface as a leakage candidate from day one and to add the same redaction layer the application logs already use.

  The leak-detection discipline also includes *post-leak rotation* as a planned operation rather than an emergency. When a secret leaks, the response time is the gap between detection and rotation; teams that have never rotated a token in calm cannot rotate one in eight minutes under duress. The runbook should include an "as if leaked" rotation drill on a calendar — actually rotate the token, verify the dependent systems pick up the new value, restore service — so the operational muscle exists when the real leak happens.

  Example (Aura companion): the raw-protocol recordings (`~/.companion/recordings/*.jsonl`) capture every NDJSON message between server and CLI, including tool-call arguments. A user instruction containing an API key, or an MCP tool returning a credential, lands verbatim in the recording. The discipline requires either explicit opt-out (`COMPANION_RECORD=0` documented prominently) or a redaction pass on known-shape secrets before write — and the operator should be told at install time that recordings are full-fidelity. The recording's file permission (0600) is part of the control; widening it for a debug session is a deliberate, time-bounded act that must be reverted.

  Anti-pattern to detect: secrets bound to URL query parameters rather than request bodies — every request shows up in webserver access logs, intermediate proxies, browser history, and referer headers, each of which is a leak vector. The body-vs-URL distinction is small in code but enormous in leak surface; the fix is a five-line change and a deploy, but only after the leak has been recognised as such.

  Detection signal in code review: any `console.log`, structured-log entry, or error-response shape that interpolates a variable named `token`, `key`, `secret`, `password`, `auth`, or `cookie`, or holds an object whose shape might contain them. The variable name itself is the signal; redact at the sink even when the call-site looks safe, because the sink will outlive the call-site's safety assumptions.

  Cross-ref: §A `secure defaults` — secret-redaction at the log sink should be the default with opt-in for unredacted debug; ship-the-safe-default applies symmetrically here. The sink-side default is durable across every call-site refactor; the call-site-side default decays the first time someone adds a "just for now" debug log without re-running the redaction analysis.

### Tone characteristics

Evidence-driven and patient. Hunt's pedagogy is built on the breach record — every recommendation is traceable to a specific class of attack that has played out publicly, often multiple times, and is more often the recomposition of known classes than the discovery of a novel one. The voice avoids both the alarm-fatigue-inducing severity inflation of vendor marketing and the dismissive "that won't happen to us" of the unbreached. Security hygiene first; novelty second.

The credential-and-secret subdomain in particular rewards the patient voice. Every credential-related finding is one the team has heard before, often from a previous review; Hunt's discipline is to keep stating it, with the public-breach citation that makes the cost concrete, until the control lands. Repetition without exasperation is part of the work; the alternative is to give up and watch the next breach in this exact category land on a service that already knew better.

### Anti-patterns to detect

- "We'll add rate limiting later" — login endpoints in production without rate limiting are an active credential stuffing target; the "later" is measured in the duration of the next campaign.
- Custom crypto or custom password hashing — the team that rolls its own KDF will reliably get it wrong; the lever is to use the boring library at the right parameters, not to improve on the library.
- Secrets in URL query parameters — leaks into access logs, browser history, referer headers, proxy logs. The body-vs-URL discipline must apply to every secret-bearing request.
- Token rotation as a feature for "later" rather than a calendar discipline rehearsed in calm. The first rotation should not happen during the incident.
- Secret-shape pre-commit hooks scoped only to `git diff --cached` of new commits, ignoring history rewrites and squash merges — the hook misses any secret introduced in an earlier commit on the branch and squashed into a single landing commit. The scan must cover the full diff against base, not only the index.
- Rotating only the *exposed* credential after a leak rather than every credential of the same class — the leaked token reveals the operational pattern, and an attacker who has seen one is informed about the shape of the others. Rotation policy should treat any leak as a class-wide rotation trigger.
- Storing per-user salts in the same row as the hash and treating the database row as one atomic secret — true, but the salt's job is to defeat rainbow tables, not to add secrecy. The expensive parameter is the hash function's cost factor, not where the salt lives.

---

## §C Breach forensics

Sources:
- https://haveibeenpwned.com/
- https://troyhunt.com/

### Principles

- **breach forensics** — when an incident is suspected or confirmed, the question is no longer "are we compromised" but "what was accessed, by whom, and over what window". The forensic outcome is bounded by the logging investment made *before* the incident: logs that do not record the right events, do not retain long enough, or do not cover the right surfaces produce a forensic dead-end where the team can neither confirm scope nor disclose accurately. The investment is made in calm; the return is realised under duress.

  The minimum forensic surface is: per-request access logs with timestamp + auth identity + endpoint + parameter shape (not values); per-process audit logs with command-line and environment provenance; per-secret use logs (which token accessed which resource at what time); and retention long enough to cover the typical dwell time of a sophisticated breach (median ~200 days per industry reports). Logs that age out at 30 days are forensically useless for any attack discovered later than that window — and most attacks are.

  The trace-versus-log distinction matters here. Distributed traces (per-request span trees) excel at debugging performance and correctness; structured access logs excel at forensic reconstruction across a long window. Traces are typically sampled and retained briefly because their volume is enormous; access logs are typically unsampled and retained long because their volume is manageable. Hunt's discipline insists on the second axis being adequate even when the first is excellent — sampled traces cannot reconstruct an attack the sampling missed, and the missing fraction is exactly the slice the team needs after the fact.

  Example (Aura companion): the raw-protocol recordings serve a forensic purpose beyond debugging — if a session is later suspected of mis-behaviour, the JSONL log records every tool call's arguments and every command output. The retention policy (`COMPANION_RECORDINGS_MAX_LINES`, default 1M total) bounds disk usage but should be matched against the operational risk window; for a security-sensitive install, raising the cap or rotating-with-archival rather than deleting may be the right tuning. The session metadata header (one JSON entry per file) is the indexable forensic anchor — without it, reconstruction depends on filename heuristics.

  Anti-pattern to detect: forensic logging that records *outcomes* (success/fail) but not *inputs* (which parameter, which IP, which user agent). The team can tell that something failed but not what was attempted; the post-incident question "what did the attacker probe" has no answer and the disclosure narrative is incomplete by construction.

  Detection signal in code review: any logging change that downgrades log verbosity, removes fields, or trims retention without a paired analysis of the forensic impact. "Reduce log volume" is a legitimate cost optimisation; doing it without naming what forensic capability is being given up is the anti-pattern. The reviewer asks for the forensic-impact paragraph.

  Cross-ref: §B `credential stuffing` — the same access logs that bound a forensic investigation are the logs that detect the campaign in progress; the observability investment compounds across both phases.

- **breach-oriented thinking** — design and review systems with the post-breach question in mind: "if an attacker had this access for a week before we noticed, what could they have done, what would we know, and what would we be obligated to disclose?". The discipline reframes security from "prevent all breaches" (an impossible target) to "bound blast radius and disclosure obligations when breach occurs" (a tractable engineering problem).

  Operationally this drives several decisions: minimise data retention (data you do not have cannot be exfiltrated); encrypt at rest with per-tenant keys (compromise of one tenant's key does not compromise others); separate identity-bearing data from behaviour data (the breach of a behaviour log without identities is a smaller disclosure than the breach of a join of both); design audit logs to be tamper-evident (append-only, hash-chained, or shipped to a write-only sink). Each decision is cheap pre-incident and dispositive post-incident.

  The *key-separation* pattern is the highest-leverage of these in 2026 — encrypt each tenant's data under a tenant-specific key, store the key under a customer-controlled KMS or HSM, and design the application to fail closed if the key is unavailable. A breach of the encrypted store discloses ciphertext only; the disclosure obligation is bounded to tenants whose keys are also believed compromised, not to every tenant in the database. The cost is operational complexity in key rotation and disaster recovery; the savings is in the breach-tail risk profile.

  Example (Aura council pipeline): the council-mode session-group-id is a cryptographic random pattern rather than a sequential integer (per `group-authorization.ts`). A leaked session-id from one group does not enable enumeration of other groups; the blast radius is bounded to the one leaked id by construction. The choice was made at design time; retrofitting it after a breach would have required disclosing every prior session-id as potentially enumerable. The same pattern applies to the cli-session-id and the bearer auth token — randomness as a forensic bound, not an aesthetic.

  Anti-pattern to detect: collecting and indefinitely retaining data without a clear business need ("we might want it later"). The data sits as a perpetual breach target; when the breach happens, the disclosure obligation scales with the volume of retained personal data, regardless of whether you ever used it. Storage is cheap; disclosure cost is not.

  Detection signal in code review: any new field added to a long-retained log or table that captures user-identifying information without a named justification and a named retention bound. The default retention should be "the minimum that satisfies the named use case", not "forever unless someone notices"; the reviewer asks for both the use-case and the bound.

  Cross-ref: hashimoto §V5 supply-chain reproducibility — breach-oriented thinking and supply-chain reproducibility intersect at "can you tell which build of the system was running when the incident occurred?". Without reproducibility, post-incident triage cannot reliably reconstruct the vulnerable code state.

- **disclosure & notification discipline** — when a breach is confirmed, the post-incident response has its own engineering discipline: notification timelines (regulatory, often 72 hours), affected-user enumeration accuracy (under-notification is a regulatory finding; over-notification erodes user trust), forensic narrative integrity (the public statement must survive later disclosure of new facts without retraction), and remediation that addresses the *cause class*, not just the specific instance. Hunt's public-breach archive at Have I Been Pwned is, in part, an enforcement mechanism for this discipline: breaches that disclose poorly become public lessons.

  The pre-incident investment is a written incident-response runbook with named roles, escalation paths, regulatory contacts per jurisdiction, and legal counsel. The runbook is read and rehearsed in calm; under duress, the team executes a known sequence rather than improvising. Improvisation under duress produces both legal exposure (missed deadlines) and reputational damage (incoherent public statements).

  The rehearsal cadence Hunt recommends is *tabletop drill*: a scheduled session, typically quarterly, in which the team walks through a hypothetical breach scenario from detection through public statement. The drill surfaces the gaps (who calls legal? where is the contact list? who is on-call for the after-hours scenario?) that would be discovered, at high cost, during the real incident. A drill that exposes a gap is a successful drill; a drill that goes smoothly should escalate to a harder scenario next quarter.

  Example: Aura, as a developer tool with no PII collection by default, has a narrow disclosure surface — but the recordings-and-transcripts surface (§B `secret leakage`) means a breach of a user's recording directory potentially exposes their conversation contents and any secrets pasted into them. The disclosure obligation, if such a breach is discovered, is to the affected user (their content is theirs), and the runbook should name how the operator is expected to notify their end users rather than how Aura would notify them. The runbook should also include the technical-explanation-for-end-users template — what was recorded, what was exposed, what the user should rotate.

  Anti-pattern to detect: no written incident-response runbook, or a runbook that has never been rehearsed against a hypothetical incident. The first time the team executes the procedure should not be the actual incident.

  Detection signal in code review: not a code-review signal per se, but an organisational one — does the operations review include a quarterly incident-response drill? Repos without operational drills accumulate incident-response debt that compounds with every feature shipped; eventually the drill cost equals the next-breach cost and the team is now paying both.

  Cross-ref: §A `attack surface reduction` — the disclosure cost of a breach scales with the data exfiltrated; reducing the attack surface and reducing the data retained both reduce the disclosure surface symmetrically. The same PR-time discipline that justifies new exposed surface should justify new retained data; the question "what is the disclosure cost if this is breached?" is the symmetric companion to "what is the attack motion if this is reached?".

### Tone characteristics

Calm under hypothetical-incident pressure, narrative-driven, public-breach-record-grounded. Hunt's voice in the forensic phase is the same as in the prevention phase — matter-of-fact, evidence-driven, anti-alarmist — but with an explicit shift in question from "how do we avoid this" to "if it happened tomorrow, what would we know and what would we do". The discipline is rehearsable, not heroic; the goal is for the actual incident to be unremarkable in its execution.

The narrative discipline extends to public statements. Hunt's reading of past poorly-handled breaches (notably the multi-update, multi-correction pattern that erodes trust) is that the public statement must be drafted in the same disciplined voice as the internal forensic finding — name what is known, name what is being investigated, name when the next update will land, and resist the temptation to under-promise on impact to buy news cycles. The teams that disclose well retain trust; the teams that disclose poorly are still answering for the disclosure years after the breach itself is forgotten.

### Anti-patterns to detect

- "We'll worry about that if it happens" — disclosure deadlines do not pause for the team to draft a process; the runbook is a prerequisite, not a deliverable.
- Over-retention of personally identifying data without business justification — accreting disclosure obligation at no business return.
- Logs that capture outcomes but not inputs — forensic dead-end; the team can tell that something happened but not what.
- Custom incident-response process designed in the abstract without a tabletop drill — the procedure that has never been executed will be discovered to be incomplete on the day it matters most.
- Forensic logs co-located with the data being audited — a single compromise both destroys the data and removes the evidence trail. Audit logs ship to a write-only sink the application cannot reach for delete.
- Public post-incident statements drafted by the same engineers actively triaging the incident — the framing decisions deserve a separate calm authoring path; the triage engineers do not have the bandwidth or the framing instinct under load.
- Disclosure timelines anchored to "when we are certain of scope" rather than to the regulatory clock — certainty is a moving target during active investigation, while the clock is not, and waiting for certainty is exactly how teams miss the deadline.
- Incident summaries written for executives that elide technical specifics — the external statement should be precise about what was accessed in terms users can verify against their own records, not euphemistic about scope.
- Treating the breach-disclosure surface as exclusively a comms problem — the engineering team owns the technical accuracy of the statement, and an inaccurate statement compounds the disclosure damage when later corrections land.
