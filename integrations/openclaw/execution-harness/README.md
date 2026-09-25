# Execution Harness

This directory is the versioned source for the OpenClaw execution adapter.
It is deployed from a clean checkout of `coding-control-harness`; mutable
ledgers, exact-head dispatch state, release trains, receipts, and logs remain
under the operator's local `ops/execution-harness` runtime directory. Do not
commit those runtime files. The watchdog needs `--state` and `--work-state`,
the Promise Ledger needs `--state`, and the exact-head dispatcher needs
`EXACT_HEAD_REVIEW_STATE` to preserve that separation. Run
`npm run openclaw-execution:test` before deploying a changed source head.

## Bounded durable WorkState

`work-state-runtime.mjs` is the canonical state runtime for a durable lane.
It stores a bounded `WorkState` record (objective, named acceptance tests,
authority boundary, phase, next action, owner, dependencies/blockers, current
facts and decisions, evidence references, retry policy, deadline, and version)
separately from the append-only execution event record.  It never stores model
reasoning or raw tool output in the agent context.

Raw outputs are registered first as immutable evidence receipts.  A state
transition then requires the caller's expected version, an allowlisted action
with an idempotency key, a schema-valid patch, and a rationale.  The runtime
uses an exclusive file lock and atomic rename; stale writers fail rather than
overwriting a newer state.  The action is recorded as `prepared` before it can
be executed and can be completed only with an immutable evidence receipt.

```sh
node work-state-runtime.mjs record-evidence --receipt '<receipt-json>'
node work-state-runtime.mjs register --record '<work-state-json>'
node work-state-runtime.mjs transition --id <id> --expected-version <n> \
  --patch '<json-patch>' --action '<action-json>' --rationale '<why>'
node work-state-runtime.mjs complete-action --action-id <id> \
  --outcome succeeded --evidence-ref <receipt-id>
node work-state-runtime.mjs context --id <id> --latest-evidence <receipt-id>
```

New development packets automatically receive a WorkState record.  When an
attached packet is recovered, the harness injects its WorkState and selected
evidence receipt rather than reconstructing execution from the transcript.
Historical event logs and raw artifacts remain retrievable for audit,
debugging, release evidence, and postmortems.

This is the durable control plane for the CivicLine, Astellen, and TEMS portfolio. `execution-state.json` is the source of truth for active work lanes; it records the exact phase, proof, next action, heartbeat deadline, blocker, and pending user-facing event.

The controller refuses phase claims without evidence, uses atomic state writes, and turns a missed next-action, heartbeat, verification, or actionable-review remediation deadline into a persisted `stalled` event. An actionable review is a first-class `review-blocked` state: green CI cannot bypass it. A watchdog must process pending events, act on the lane's next action, and acknowledge the event only after it has reported the material state change.

## Development adapter

The shared core owns state, evidence, deadlines, events, and legal transitions.
The development adapter converts a terminal-event template in a source lane into
a concrete Claude Code packet: repository, branch, worktree, tmux session,
`GATES.md`, verification command, first deadline, and literal dispatch command.
It derives a machine-recorded execution contract for every packet: objective,
constraints, validation command, stop condition, and checkpoint cadence.

Two automatic terminal-event transitions are encoded:

- a merged/production-verified lane with a `development.successor` template
  retires and dispatches the successor packet;
- an actionable review with a `development.remediation` template retires the
  blocked source and dispatches the remediation packet.

`watch --apply` performs those transitions. `dispatch-development --lane <id>
--kind successor|remediation` is the explicit recovery path. The controller
prepares a tmux/Claude dispatch contract; the watchdog is responsible for
launching it or `attach-development` records a verified existing tmux lane and
its first live-pane evidence. This authority boundary
is deliberate: the adapter may create internal development work, but it cannot
send external communications, spend money, alter permissions, or deploy
production.

### Recovery and execution-contract proof

Development packets created after this control carry `autoRecover: true`. If a
recoverable active lane loses its executor, the watchdog invalidates the stale
attachment, creates a fresh named tmux session in the recorded worktree, and
launches a recovery prompt that embeds the deterministic handoff record. It
then verifies literal session, pane, and working-directory evidence before
marking the lane attached again. Terminal lanes and legacy packets without
`autoRecover` are never restarted automatically.

An execution contract is enforced at the PR boundary. Each declared validation
must be explicitly recorded with exact evidence and an artifact identity through
`record-contract-check`; an implementation lane cannot transition to `pr-open`
until the standard gates and its contract validations pass.

### Dispatch truth

`attached` is a proved state, not a claim. `attach-development` now requires a
live tmux pane whose literal working directory matches the packet's declared
isolated worktree, and records both. Every watchdog pass rechecks that session,
pane, and worktree. A missing session, missing pane evidence, or cwd mismatch
invalidates the attachment, stalls the packet, and creates a durable event.
The watchdog must create/attach the correct lane before it can resume ordinary
implementation work.

## Non-interactive execution directive

Once a task is authorized, do not ask Jason to approve ordinary next steps. Completion of one step triggers the next in-scope step: implement, test, open the PR, review, merge when the recorded gate passes, package the release, and run the scheduled production gate.

Yield only for a verified blocker that needs human action, a Jason-only decision (strategy, architecture, spending, external communication, permissions/credentials, or an unapproved sensitive mutation), or when no authorized ready work remains. An active or ready lane is never a reason to wait for a new prompt.

Persist state before dispatch, at every material evidence transition, and before yielding or closing a lane. A branch, worktree, plan, or assignment is not delivery evidence.

### Claude Code implementation lanes

For a trusted, isolated repository worktree, dispatch Claude Code in non-interactive mode. It must proceed through implementation, focused tests, PR preparation, and any safe fixes without asking for routine approval. The standard launch form is:

```sh
claude -p "<bounded issue objective and acceptance criteria>" \
  --dangerously-skip-permissions
```

The dispatcher independently chooses whether a particular lane needs an allow-list. The default is **no tool allow-list**: a bounded implementation task must not stop for routine tool expansion, package installs, test runners, browser checks, GitHub operations, or safe repository maintenance. An allow-list is reserved for an unusually sensitive or intentionally restricted task, never as a substitute for supervision.

This autonomy is limited by the lane boundary, not by repeated permissions: use a dedicated worktree, an issue-scoped prompt, and no production credentials or customer-facing communication authority. Production mutation, credential/permission changes, spending, and unapproved external communications remain Jason-only boundaries.

### Standing product-issue UAT contract

Every new product issue must contain the following exact `## Machine-Executable UAT` section before Claude Code can be attached. The role is derived from the workflow affected by that issue; it is not a fixed admin/clerk persona. Correctness and compliance are mandatory acceptance dimensions. The default data boundary is disposable synthetic test data only.

```md
## Machine-Executable UAT

### Issue-derived user role
<!-- Name the day-to-day user of this exact workflow and why this role is correct. -->

### Synthetic test data and starting state
<!-- Disposable records/accounts only; include setup and preconditions. -->

### Steps
1. ...

### Expected outcomes
- ...

### Forbidden outcomes
- ...

### Correctness and compliance checks
- ...

### Evidence to capture
- Screenshot/video, browser-console/network result, persisted-record/audit result, and exact artifact/revision.
```

The harness refuses to attach a new Claude Code implementation lane when any heading is missing. Claude must repair the issue body before implementation. A passed `staging_uat` record must bind the same artifact to the role rationale, synthetic data, steps, expected/forbidden outcomes, compliance checks, browser errors, and captured evidence. If synthetic data cannot exercise the issue faithfully, record the limitation and hold the gate; never substitute customer data.

### ACP versus tmux

ACP is for short, bounded work whose result is expected within one agent invocation: inspection, a focused review, a narrowly scoped diagnosis, or a quick verification. It is **not** the execution host for implementation, CI/review waiting, iterative repair, PR packaging, or any lane that can legitimately run longer than an ACP timeout.

Use a named tmux session as the default host for every Claude Code implementation lane. The session must be tied to one worktree and issue, and its name, pane target, last observed evidence, and next heartbeat must be recorded in `execution-state.json`. The watchdog inspects the literal pane state: if Claude is actively working, it leaves it alone; if a routine prompt or completed checkpoint is visible, it immediately sends the next instruction; if the lane is inactive or stalled, it resumes or records a real blocker. Do not restart a healthy tmux lane merely because a supervising ACP turn ended.

`watch --apply` also kills any tmux session idle for 24h (`--tmux-idle-hours N`) unless an active lane records it as its `tmuxSession` or `dispatch.session`. Each kill is reported as a `tmux_session_reaped` finding, not as an event. Without `--apply`, watch only lists the sessions it would kill. `--skip-tmux` disables this. So an ad-hoc tmux session that should outlive 24h idle must be registered as an active lane.

## Commands

```sh
node ops/execution-harness/harness.mjs status
node ops/execution-harness/harness.mjs watch --apply
node ops/execution-harness/harness.mjs register-lane --id astellen-reconcile \
  --repository jgraham310/astellen --title 'Reconcile Astellen' \
  --objective 'A verified Astellen delivery packet exists.' \
  --next-action 'Inspect live evidence and select the next packet.' \
  --due '2026-08-16T13:00:00Z'
node ops/execution-harness/harness.mjs operational-report \
  --lanes civicline-2540,astellen-reconcile,tems-reconcile \
  --summary 'Verified portfolio state and next actions.'
node ops/execution-harness/harness.mjs transition --issue 2540 --to implementing \
  --evidence 'worktree and branch exist at SHA …' --heartbeat-due '2026-08-15T13:15:00-04:00'
node ops/execution-harness/harness.mjs observe --issue 2540 \
  --evidence 'commit abc123; focused tests passed' --heartbeat-due '2026-08-15T13:30:00-04:00'
node ops/execution-harness/harness.mjs record-review --issue 2540 --status actionable \
  --head 'git:abc123' --evidence 'unresolved correctness blocker' \
  --next-action 'correct the condition and add its regression test' \
  --due '2026-08-15T13:30:00-04:00'
node ops/execution-harness/harness.mjs dispatch-development --lane tems-reconcile \
  --kind remediation
node ops/execution-harness/harness.mjs attach-development --lane tems-561-review-remediation \
  --tmux-session tems-onboarding --evidence 'Claude is actively implementing the remediation.' \
  --heartbeat-due '2026-08-16T17:00:00Z'
node ops/execution-harness/harness.mjs verify --issue 2540 --gate targeted_tests --status passed \
  --command 'uv run pytest tests/test_clerk_go_live_readiness_2540.py -q' \
  --evidence '42 passed' --artifact 'git:abc123'
node ops/execution-harness/harness.mjs verify --issue 2540 --gate staging_uat --status passed \
  --command 'playwright UAT journey' --artifact 'sha256:...' --evidence 'journey completed without console or network errors' \
  --journey '{"persona":"staging clerk","startingState":"incomplete tenant","actions":["sign in"],"expectedOutcome":"readiness page","forbiddenOutcomes":["live workspace"],"observedOutcome":"readiness page rendered","browserErrors":[]}'
node ops/execution-harness/harness.mjs release-gate --issue 2540 \
  --candidate '{"artifact":"sha256:...","eligible_merged_prs":true,...}'
```

## Policy encoded here

- A PR auto-merges only with required green CI, explicit zero-actionable-findings Codex review, mergeability, and no unresolved requested changes.
- A GitHub-hosted Codex review-bot quota notice does not by itself block the Codex-review gate. The controller must run a fresh local authenticated Codex review against the exact PR head and record its output; only a fresh failure of that local review path is a review-availability blocker.
- Every implementation lane has recorded type/lint, build, targeted-test, full-suite, staging-health, and staging-smoke gates. A gate is not passed until its command, timestamp, result evidence, and artifact identity are recorded. PR readiness requires the first three required gates; production verification requires every required gate on the same immutable artifact.
- Every product issue has a required `staging_uat` gate after staging smoke. Its pass record contains the issue-derived disposable staging persona, role rationale, synthetic data/starting state, actions, expected and forbidden outcomes, correctness/compliance checks, observed outcome, captured browser errors, and evidence artifacts. No backend-only exception applies unless the work is explicitly classified outside the product backlog.
- A running gate carries a deadline. The headless watchdog turns an exceeded deadline into a durable `verification_overdue` event, marks the lane stalled, and requires immediate remediation or a real blocker record. It cannot wait silently.
- An actionable review records the exact reviewed head, evidence, next action, and remediation deadline. At the deadline, the watchdog emits `review_remediation_overdue`, marks the lane stalled, and requires the correction or an explicit real blocker. It cannot advance to `reviewed`, merge, or release merely because CI is green.
- A terminal development lane may not remain an ambient active record. When its
  successor or remediation template is present, the next `watch --apply` creates
  a separately supervised packet and retires the source. A packet is not a
  claimed implementation start until the watchdog records its tmux-pane or
  repository evidence.
- Production promotion occurs during the nightly **2:00 AM Eastern** release cron by default. An explicit Jason critical-incident instruction authorizes an immediate, exact-artifact override. The override must be recorded with its artifact and expiry; it does not waive any CI, review, staging, rollback, or production-smoke gate. When all gates pass, the watchdog emits an `immediate_release_ready` event and dispatches the promotion immediately rather than waiting for the nightly window. The controller never deploys production itself.
- A branch or worktree alone is not evidence of implementation. The state stays `identified` until the watchdog records the actual worktree/branch proof, then requires recurring evidence before the heartbeat expires.
- Every declared portfolio repository must have a registered lane. The watchdog emits a durable `portfolio_scope_mismatch` event for any missing lane; it is not permissible to call the controller portfolio-wide while that event exists.
- An operational report is a controller command, not free-form status prose. `operational-report` refuses unregistered lanes, missing evidence, or an active non-terminal lane with no continuation deadline, then records the report's evidence in the ledger. The reporting layer must use this command before sending an operational update.

## Watchdog contract

The watchdog runs at five-minute intervals, is idempotent, and must:

1. run `watch --apply`;
2. process every pending event; send Jason one concise material update; and acknowledge only the event IDs reported;
3. execute the recorded next action or record a real blocker; and
4. never claim a state transition without command, GitHub, CI, review, staging, or production evidence.

An operational response is not a completion boundary. Before it is sent, the controller must have either recorded the next in-scope action with a deadline or recorded a real Jason-only/verified blocker. The watchdog will reopen any missed deadline without waiting for another user prompt.

## Promise ledger and outbound gate

`promise-ledger.mjs` is the durable contract for any outgoing response that
creates a future obligation. Before a message is delivered, the outbound
adapter must call `preflight-send` with an explicit classification. Potential
commitment language is rejected unless the message references one or more
active promise IDs. A registered promise requires an owner, concrete
deliverable, completion deadline, next-update deadline, success predicate,
resolver job/cadence, and escalation recipient.

The resolver invokes `watch --apply`. It emits a durable pending event when an
update or completion deadline is due. `record-update` requires evidence and a
new future update deadline; `complete` requires verification evidence and
closes all pending events for the promise. `promise-trigger.js` is the
model-free scheduler trigger. The production binding must expose only the
gated outbound-message adapter to the agent and withhold the raw Telegram send
tool; otherwise a local preflight cannot prevent bypass.

### Remedy-first outbound gate

The preflight also detects claimed corrective execution, such as “we have
implemented the controller.” Such a message uses classification `remedy` and
requires `--remedy-receipt`, which names the already-created in-scope packet,
committed control, or durable resolver. An opinion, analysis, diagnosis, or
advisory recommendation such as “the best fix is …” is non-operational unless
it also claims execution or makes a future commitment. This makes the ordering
deterministic: create the solution first, report it second. A model may review
the draft before preflight, but never substitutes for the receipt requirement.

Example:

```bash
node promise-ledger.mjs register --id cleanup-20260820 --owner 'Portfolio controller' \
  --deliverable 'Formally disposition the PR cleanup queue' --due '2026-08-20T22:00:00Z' \
  --update-due '2026-08-20T18:20:00Z' --success-predicate 'Every open PR has a verified disposition and Jason receives closure evidence.' \
  --resolver-job-id '<cron-job-id>' --resolver-cadence PT30M --escalation Jason
node promise-ledger.mjs preflight-send --classification commitment --promise-ids cleanup-20260820 \
  --message 'I will send the verified cleanup update.'
```

The nightly release cron calls `release-gate` before any production action and records the artifact SHA/digest, smoke evidence, and rollback anchor in the active lane before marking production verified.

## External adapter contract

External adapters use the same state/evidence/deadline engine but do not inherit
development's GitHub or tmux assumptions. Before any external adapter is
activated, it must declare: a parent goal and measurable success predicate; its
source(s) of truth; allowed internal actions; explicit escalation categories;
an evidence format; a cadence and stale-state deadline; and a terminal rule
(`achieved`, `blocked` with a named Jason decision, or `retired`).

Every action is classified before execution:

- **observe** — read, reconcile, and collect evidence; autonomous;
- **draft** — create internal recommendations, packets, and external-message
  drafts; autonomous but not sent;
- **internal-update** — write only to an approved internal system of record;
  autonomous only when that system is listed in the adapter authority;
- **Jason-gated** — send external communication, spend money, make a strategic
  commitment, change production, change permissions/credentials, submit/file,
  or make any other sensitive mutation.

The parent P&L controller owns the goal ledger and arbitrates capacity; child
adapters may not optimize an activity metric independently. It accepts only
evidence-backed updates and must automatically turn a missed commitment into a
new bounded packet or a Jason-only escalation. A reporting update is never a
terminal state.

## Deterministic engine

`deterministic-engine.mjs` is the model-free substrate for every adapter. It
validates manifest fields, deduplicates actions by idempotency key, enforces
dependencies and bounded retries, fingerprints source snapshots, generates a
briefing view directly from records, and classifies routine tmux-pane states.

The watchdog must first run deterministic state, source, queue, and pane checks;
then execute a returned authorized routine action or record a durable event.
It invokes Luna only when a classifier returns `modelRequired: true`; higher
tiers are reserved for strategy, architecture, risk, or Jason-gated ambiguity.
Unchanged snapshots and a clean action queue require no model invocation.

The activation manifest shape is recorded in `adapter-manifest.schema.json`;
runtime fail-closed validation lives in `deterministic-engine.mjs`.

## Deterministic task classifier

`task-classifier.mjs` is a model-free protocol selector. It accepts a small
task envelope (`request`, optional attachment names, repository, and verified
state signals) and returns a pre-approved protocol plus its matching evidence.

Precedence is fixed: production, external-send, spend, and permission markers
always return `jason_gated`; a release-verification route requires both
`merged_pr` and `release_window`; a single non-sensitive match selects research,
coding, or operations; no match or conflicting matches return
`governed_general`. It does not invoke models, tools, skills, or actions, and it
does not modify runtime configuration.

Run the deterministic fixture suite with:

```bash
node ops/execution-harness/task-classifier.test.mjs
```

## Extracted operating patterns

Four patterns are incorporated without importing a second orchestration system:

- **Execution contract:** every activation manifest contains one objective,
  explicit constraints, validation checks, a stop condition, and a checkpoint
  cadence. It turns a goal into an executable, testable packet rather than a
  narrative prompt.
- **Scheduler proof:** a heartbeat is healthy only after its scheduled run
  starts and completes within explicit bounds with exit code zero. A queued or
  merely started run is not evidence; a no-work tick remains silent.
- **State handoff:** replacement sessions receive deterministic state from the
  lane record—goal, constraints, evidence, validation, blockers, and artifact
  pointers—rather than an expensive reconstruction of prior conversation.
- **Independent review:** disabled by default and required only when a manifest
  classifies a change as security-sensitive, production-impacting, or disputed.
  The classifier decides whether review is needed; it does not invoke a model
  on ordinary work.
