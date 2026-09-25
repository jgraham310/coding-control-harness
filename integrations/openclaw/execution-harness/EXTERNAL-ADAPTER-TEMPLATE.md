# External Adapter Activation Template

Do not activate an adapter until every field below is completed and the parent
controller has accepted it.

## Identity and goal

- Parent P&L/controller:
- Adapter name:
- Goal ID:
- Measurable success predicate:
- Deadline and review cadence:
- Terminal rule: achieved / blocked with a named Jason decision / retired

## Deterministic execution contract

- One-sentence objective:
- Constraints and prohibited scope changes:
- Exact validation command(s) or evidence check(s):
- Checkpoint cadence and evidence format:
- Stop condition: success predicate met / named Jason-only decision / retired
- Anti-gaming rule: do not weaken, skip, or narrow validation to claim success

## Evidence and authority

- Sources of truth (system and record):
- Evidence required to claim progress:
- Allowed autonomous actions: observe / draft / approved internal updates
- Approved internal systems of record:
- Explicitly forbidden actions:
- Jason-gated actions and escalation recipient:

## Operating contract

- First bounded action and deadline:
- Stale-state/heartbeat threshold:
- Retry/closure rule for safe, bounded dependencies:
- Material-event notification rule:
- Parent-controller capacity or priority constraints:
- Handoff pointers: goal record, sources, active artifact/worktree, and last evidence
- Independent review: disabled by default; enable only for security-sensitive,
  production-impacting, or disputed changes and name the trigger(s)

## Acceptance test

Simulate one normal goal transition, one stale deadline, one source-of-truth
conflict, and one Jason-gated action. The adapter passes only if it advances the
first two without prompting, fails closed on the conflict, and produces a
single decision packet rather than performing the gated action.

Also simulate one no-work heartbeat and one failing scheduler run. The no-work
tick must be silent; the failed run must produce a durable event and must not
be counted as a healthy cadence check.
