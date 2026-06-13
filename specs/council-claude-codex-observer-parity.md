# Council Mode Claude+Codex Observer Parity

## Summary

Make the experimental `claude+codex` Council Mode pairing behave like a real paired review mode instead of a cosmetic pairing label. If Aura Companion offers `claude+codex` as a selectable Council pairing, then the Codex observer must actually wake on checkpoints, produce review artifacts, and surface its findings through the same user-visible Council flow as `claude+claude`. If that behavior cannot be guaranteed, the pairing must not be presented as available.

This spec does not change the `claude+claude` happy path. It closes the gap where mixed-provider pairing can launch while the observer side silently performs no review work.

## Job Stories

### 1. Launch only a truthful mixed-provider pairing

When I enable Council Mode and select `claude+codex`, I want that option to mean a functioning observer review workflow, so I do not spend time and tokens on a pair that only looks active.

#### Acceptance Criteria

- Given the New Session form shows `claude+codex` as selectable, when I create that pair, then the observer half is capable of participating in checkpoint-driven review.
- Given the system cannot support a functioning Codex observer on the current build or environment, when I open the pairing selector, then `claude+codex` is unavailable or clearly marked unsupported before launch.
- Given a user attempts to create a mixed-provider pair while the observer path is unsupported, when the create request is submitted, then no half-working pair is created.
- Given `claude+claude` remains supported, when the mixed pairing is unavailable, then the default Council option still works normally.

### 2. Wake the Codex observer on each Council checkpoint

When the orchestrator emits a Council checkpoint in a `claude+codex` pair, I want the Codex observer to receive that checkpoint and complete one review cycle, so the pair provides real independent review rather than a sleeping second session.

#### Acceptance Criteria

- Given an active `claude+codex` Council pair, when the orchestrator emits a checkpoint, then the observer transitions into an active review cycle rather than staying idle indefinitely.
- Given the observer completes a checkpoint review, when the cycle finishes, then a review artifact is produced with Codex attribution and the orchestrator-side Council UI receives the review.
- Given multiple checkpoints occur across a session, when each checkpoint is emitted, then each review cycle is independently attributable to the matching checkpoint rather than silently skipped.
- Given the observer wake cannot be delivered for a checkpoint, when that failure occurs, then the system records and surfaces a concrete failure state instead of appearing healthy while no review happened.
- Given a spawn-time checkpoint is used to verify the pair is live, when the mixed-provider pair starts, then that initial checkpoint also results in an observer-side completion signal or an explicit failure state.

### 3. Make observer failure visible and actionable

When the mixed-provider observer cannot review, I want the failure to be explicit in the UI and diagnostics, so I can distinguish “observer found nothing” from “observer never ran.”

#### Acceptance Criteria

- Given the observer wake path is unavailable, when a checkpoint is emitted, then the Council UI shows that the observer is unavailable, degraded, or unsupported rather than remaining in a misleading neutral state.
- Given the observer review path fails after pair creation, when I inspect the session state or logs, then the failure reason identifies the wake/review path rather than only showing a generic active pair.
- Given a checkpoint review succeeds, when I inspect the same surfaces, then they no longer show the degraded or unsupported state.
- Given a non-mixed pair (`claude+claude`) is active, when its observer reviews normally, then the new failure messaging does not regress or pollute the healthy path.

## Boundaries

- Always: treat `claude+codex` as a truth-in-advertising feature; if the observer cannot review, the product must say so before or during launch.
- Always: preserve the existing `claude+claude` Council workflow while fixing mixed-provider parity.
- Always: make observer non-participation visible as a Council-state problem, not as an invisible no-op.
- Never: present `claude+codex` as available solely because both CLIs exist.
- Never: count a spawned but non-reviewing observer session as a successful Council observer.
- Never: silently skip observer wake failures in a way that leaves the pair looking healthy.

## Assumptions

- The intended product contract is that `claude+codex` is a real experimental pairing, not a placeholder label.
- Review parity means checkpoint-driven observer behavior, not merely starting a second CLI session.
- Archived sessions from the reported incidents are no longer available for direct replay, so implementation verification must rely on current code paths, tests, and new smoke validation rather than those original live pairs.

## Verification

After implementing, compare results against each acceptance criterion above and list any unmet requirements.
