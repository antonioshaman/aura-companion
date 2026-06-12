# Codex Session Switching and State Clarity

## Summary

Make Codex sessions behave like Claude sessions in three user-facing ways:

- the model selector is visible and usable inside an active Codex chat,
- switching model works without losing the visible session identity,
- the UI no longer feels like it is "waiting for input" when the session is actually in plan mode, relaunching, or near a usage limit.

The feature must also stop offering stale or unsupported Codex model choices as if they were guaranteed to work.

## Job Stories

### 1. Switch model from inside a Codex session

When I am already inside a Codex session and want to change the agent model, I want the same model selector affordance I have in Claude sessions, so I can keep working without creating a new visible session.

#### Acceptance Criteria

- Given an active Codex session, when I open the session toolbar, then I can see a model selector.
- Given a selectable Codex model, when I choose it, then the session stays under the same visible Companion session identity.
- Given a Codex model change is in progress, then the UI shows that the session is restarting with the chosen model.
- Given Codex does not support a live in-place model change, when I switch models, then the app does not silently do nothing.
- Given the session is not connected, when I try to switch models, then the model change is not accepted.

### 2. Launch only models Codex can actually run

When I pick a Codex model from the dropdown, I want every visible choice to be launchable, so I do not hit a failure after I already selected it.

#### Acceptance Criteria

- Given the Codex model list is available, when the dropdown opens, then it shows only launchable Codex models.
- Given a requested Codex model is not available for this account, when I start or relaunch the session, then the system chooses the nearest supported fallback.
- Given a fallback is used, then the UI makes that replacement visible to me.
- Given no supported Codex model is available, when I attempt to launch, then I get a clear error instead of a broken session.
- Given the archived unsupported-model case, when I launch again, then the same failure does not recur.

### 3. Make session state feel explicit instead of frozen

When a session is in plan mode, near a limit, or relaunching, I want the UI to say that plainly, so I do not mistake normal state for a hang.

#### Acceptance Criteria

- Given the session is in plan mode, when I look at the composer, then I can see that execution is paused and not confused with a stalled session.
- Given the session is relaunching, when I look at the chat header or toolbar, then I can tell that the app is restarting rather than idle.
- Given Codex usage limits are present, when I open the session context panel, then I can see them as usage information rather than as an error state.
- Given the session is waiting on a user action, when I look at the UI, then the prompt explains what action is needed.
- Given the session is actively running, when I look at the same areas, then the UI does not show the paused/relaunching copy.

## Boundaries

- Always: keep the visible Companion session identity stable when switching Codex models.
- Always: show only models that can actually launch, or clearly explain any fallback.
- Always: distinguish plan mode, relaunching, and usage-limit state in the UI.
- Never: pretend Codex supports live `set_model` if it does not.
- Never: expose stale Codex defaults as guaranteed supported choices.
- Never: make the user guess whether the session is waiting for input, paused, or restarting.

## Assumptions

- "Any model from the dropdown" means every visible Codex option must be launchable, either directly or through an explicit fallback.
- Codex model changes must be handled by relaunch, not by a live in-session model switch.
- The "waiting for input" feeling is a UX clarity problem as much as a backend issue, so both need to be addressed together.

## Verification

After implementing, compare results against each acceptance criterion above and list any unmet requirements.
