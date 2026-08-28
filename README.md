# Coding Control Harness

A harness that makes a coding agent act like an engineering owner: it keeps
work moving, prioritises it, reports on it without being asked, and gives you
one file to redirect it.

It separates an agent's report from verified completion. Work moves through a
visible lifecycle only when the appropriate evidence has been recorded:

```text
prepared → running → reported_done → verified → released
```

The harness is intentionally provider-agnostic. It contains no credentials,
GitHub account IDs, repository names, agent transcripts, or deployment logic.

## What it provides

- **Evidence-bound lifecycle** — an item cannot be marked verified without
  observed verification evidence.
- **Durable checkpoints** — handoffs record an owner, next action, and success
  predicate so work resumes after restarts.
- **File reservations** — active lanes cannot silently overlap on the same
  module or file.
- **Curated memory** — proposed memories require attributable approval before
  they are recalled.
- **Enforced safety rails** — user-authored rules deny a tool call from a
  `PreToolUse` hook, before it runs, with the reason recorded and surfaced in
  the next brief.
- **Pilot closeout** — a pilot produces a measured `scale`, `adjust`, or
  `stop` recommendation rather than disappearing after initial enthusiasm.
- **Prioritised queue** — `next` ranks the board by what most needs a human or
  an agent right now: blocked work, work awaiting release, stale lanes.
- **Standing brief** — `brief` writes a report that leads with what needs you
  and states plainly when a cycle was quiet.
- **Authoritative memory export** — `export-memory` emits a versioned,
  allowlisted snapshot of evidence-backed facts for a downstream memory system,
  and refuses rather than weakening a claim it cannot substantiate.
- **One steering file** — `direction.md` is yours. Pin work, defer work, or
  leave standing instructions; the agent reads it before it reads the board.

## Quick start

Requires Node.js 20 or later, and the `gh` CLI authenticated for the repos you
want supervised.

```sh
git clone https://github.com/YOUR-ACCOUNT/coding-control-harness.git
cd coding-control-harness
npm test
node src/control-plane.mjs init
```

`init` creates `ops/coding-control/state.json` and `ops/coding-control/direction.md`.
List the repositories to supervise in `state.json`:

```json
"repos": [
  { "name": "you/service-a", "label": "cto", "owner": "openclaw", "priority": 1 },
  { "name": "you/service-b", "label": "cto", "owner": "openclaw" }
]
```

Every open issue carrying that label becomes tracked work. Omit `label` to
track every open issue.

## Running it

```sh
npm run cycle        # sync from GitHub, validate, write a brief
```

| Command | What it does |
| --- | --- |
| `sync` | Observes issues, PRs, and checks via `gh`; records evidence |
| `smoke` | Observes production; records release evidence (see below) |
| `next` | Prints the ranked queue with the reason for each position |
| `brief` | Writes and prints the report for you, since the last brief |
| `validate` | Fails if the state file contradicts its own evidence |
| `board` | Dumps the work items |
| `export-memory` | Writes the allowlisted memory claims as JSON (see below) |

## Making it proactive

Install the cycle on a schedule. `prompts/cycle.md` tells the agent to read your
direction file, run a cycle, advance exactly one item, and report.

```sh
npm run schedule install     # every two hours via `claude -p`
npm run schedule show
npm run schedule remove
```

`SCHEDULE` and `AGENT` override the cadence and the runner, and installing twice
leaves one entry:

```sh
SCHEDULE="*/30 * * * *" AGENT="codex exec -" npm run schedule install
```

### Delivering the brief

Set `notify` in `state.json` to any command that reads the brief on stdin:

```json
"notify": "telegram-send --stdin"
```

`brief` pipes to it after writing the report. A delivery that fails exits
non-zero and says so rather than losing the report quietly — the brief is still
written and printed.

### Concurrency

Every command that writes takes an exclusive lock (`ops/coding-control/.lock`)
and writes state through a temp file and a rename, so overlapping cycles cannot
interleave a read-modify-write or leave a truncated state file. A second cycle
that finds the lock held exits rather than racing. A lock left behind by a
killed process is broken after fifteen minutes.

## Release evidence

`src/release.mjs` observes production and records `release_smoke_passed`. Like
the GitHub adapter it only observes: it does not deploy, promote, roll back, or
restart anything, so the component certifying a release is never the one
performing it.

```json
"release": {
  "versionUrl": "https://api.example.com/version",
  "commitPath": "build.commit",
  "checks": [
    { "name": "health", "url": "https://api.example.com/health", "expectStatus": 200 },
    { "name": "auth-required", "url": "https://api.example.com/me", "expectStatus": 401 },
    { "name": "orders", "command": "./scripts/smoke-orders.sh" }
  ]
}
```

`versionUrl` must report the commit currently deployed; `commitPath` is a
dotted path into the JSON (omit it if the body is the bare SHA). Checks are
HTTP assertions (`expectStatus`, `expectBody` regex) or shell commands judged
by exit code.

```sh
node src/control-plane.mjs smoke
```

The load-bearing question is not "did the smoke checks pass" but **"did they
pass against code that actually contains this item, and was that code tested"**.
So for each verified, merged item the adapter:

1. Reads the live commit from `versionUrl`. If it cannot determine what is
   deployed, it records nothing — it never assumes the newest thing is live.
2. Confirms via `gh api compare` that the live commit **contains the item's
   merge commit**. The PR head is not the deployed code — a squash or merge
   commit is — so containment, not equality, is the test. Not contained, or
   diverged, means the item stays `verified` and waits.
3. Confirms **CI ran green on the merge commit itself**. Verification was
   recorded against the PR head; a squash produces a different commit, and that
   commit is what ships. Both check runs and commit statuses are consulted, so
   external CI counts. No CI of its own means the deployed artifact is
   unverified and the item waits.
4. Runs the smoke checks once per deployment. All must pass. A failure blocks
   the item, naming the live commit and the checks that failed.
5. Records `release_smoke_passed` bound to the item's own head, with the
   deployed and merge SHAs and the number of independent witnesses to the
   deployed commit alongside for audit, and moves it to `released`.

An empty `checks` list refuses to certify rather than passing vacuously. And
because the evidence is commit-bound like every other gate, a later push to the
item retires its release evidence along with its verification.

If your repositories do not run CI on merge commits, set
`"requireMergeChecks": false`. Step 3 is then skipped and the recorded evidence
says so in as many words — the claim becomes "smoke passed" rather than "the
deployed artifact was tested", and the audit trail shows which one you have.

### Attesting what is actually live

`versionUrl` is the deployment describing itself. That is one witness, and
syntactic validation does not make it truthful: a compromised or misconfigured
endpoint can report a well-formed SHA that is not what is running. Name a
second, independent source and the two must agree:

```json
"corroborate": { "deployments": "production" }
```

That reads GitHub's own record of what is deployed. GitHub lists deployments
newest-first regardless of outcome, so the newest record is routinely *not*
what is running — the adapter therefore resolves the deployment that is
actually serving: it walks back from the newest until it finds one whose
**latest status is `success`**. A deployment that failed, is still queued or in
progress, or succeeded and was later superseded and marked `inactive` is not
serving and cannot corroborate its SHA. If nothing in the scanned window is
active, that is an error naming what was rejected, never a guess. Set `scan`
(default 10) for an environment that records long runs of failed deployments.

This costs one API call per record inspected, which is one or two in practice.

For a target GitHub does not know about, use a command that prints the live SHA
by querying the platform directly:

```json
"corroborate": { "command": "kubectl get deploy/api -o jsonpath='{...}'" }
```

Disagreement stops the release pass and certifies nothing — two sources
diverging is a strong signal that something is wrong, and picking a winner
would defeat the point. A corroborating source that cannot be read is likewise
a refusal, never a quiet fall back to the single witness.

This raises forgery from "compromise the application" to "compromise the
application and the deployment record, consistently". It does not make the
claim unforgeable — **something must be trusted, and the harness cannot escape
that by adding sources.** What it can do is be honest about which it had: the
recorded evidence carries a `witnesses` count, and with one it says the
deployed commit was *self-reported and unconfirmed* rather than implying a
proof that was never obtained.

### Trust boundary

`versionUrl` is a network response, so it is treated as hostile input. The
commit it reports must match `^[0-9a-f]{7,40}$` before it is used, and `gh` is
invoked with an argument list and no shell, so nothing observed can be
interpreted as a command or traverse an API path. A malformed or compromised
endpoint aborts the repo's release pass and certifies nothing.

The two places a shell is used — the `notify` command and a check's `command` —
run literal strings from your own `state.json`. No observed value is
interpolated into either. Those files are as trusted as the machine running the
cycle; treat write access to `state.json` as equivalent to shell access.

## Exporting facts to a memory system

`export-memory` writes an allowlisted, versioned snapshot of the facts this
harness is authoritative about, for a downstream memory consumer to ingest.

```sh
node src/control-plane.mjs export-memory              # JSON to stdout
node src/control-plane.mjs export-memory claims.json  # or to a path you name
npm run export-memory
```

It is an export and nothing else. It never writes to the ledger, never touches
release state, never calls the downstream system, and never infers a fact the
evidence does not already carry.

### The contract

```json
{
  "schema": "harness-memory-export/v1",
  "generatedAt": "2026-08-28T12:00:00.000Z",
  "source": {
    "system": "coding-control-harness",
    "stateDigest": "sha256:b38bc5d971f4d3305af1c6709662b371a3912b16dd33622b4ff1b6cc8f25e91a"
  },
  "claims": [
    {
      "id": "800e4535041bebf4f12de6667af7e313",
      "claim": "Work item api#7 in acme/api was released: merge commit aaaa… reached the live deployment bbbb…, and release smoke checks passed against it.",
      "subject": "release/item/acme/api/api#7",
      "validFrom": "2026-08-28",
      "validUntil": null,
      "source": "harness ledger",
      "authority": "harness",
      "provenance": {
        "evidenceIds": [
          "api#7/release_smoke_passed@cccc…",
          "api#7/verification_passed@cccc…"
        ],
        "repository": "acme/api"
      }
    },
    {
      "id": "b1f0c8d2…",
      "claim": "acme/api is deployed at commit bbbb…, attested by release smoke checks.",
      "subject": "release/state/acme/api",
      "validFrom": "2026-08-28",
      "validUntil": null,
      "source": "harness ledger",
      "authority": "harness",
      "provenance": { "evidenceIds": ["api#7/release_smoke_passed@cccc…"], "repository": "acme/api" }
    }
  ]
}
```

### Subjects, and which of them supersede

A subject is a governed key. Two claims sharing one describe the same thing at
different times; two claims with different subjects never compete.

| Subject | Kind | Supersedes? |
| --- | --- | --- |
| `release/item/<owner>/<repo>/<work item id>` | An item reached production | No. Durable — a later release does not make it untrue, and every item keeps its own subject. |
| `release/state/<owner>/<repo>` | What the repository currently has deployed | Yes. One subject per repository; each deployment closes the one before it. |

**Grammar.** Segments are `/`-separated. `<owner>/<repo>` matches
`[A-Za-z0-9._-]+/[A-Za-z0-9._-]+`. A work item id matches
`[A-Za-z0-9._#/-]{1,64}` and **routinely contains `#`** — ids are `<repo>#<issue>`
shaped, so `release/item/acme/api/api#7` is the normal case, not an edge one. It
is the ledger's own identifier and is exported unescaped; a consumer must treat
the subject as an opaque string, not as a URI whose fragment begins at `#`.

**Querying deployment state.** The claims under one `release/state/<repo>`
subject form a non-overlapping timeline:

| Query | Predicate |
| --- | --- |
| What is live now | `validUntil === null` — exactly one claim per repository |
| What was live on `D` | `validFrom <= D && (validUntil === null || D < validUntil)` |

Validity is day-granular, per the contract above. Two deployments on one day
leave the earlier with an empty window, which reads correctly: by the end of
that day the later one was live. Several items released against a single
deployment describe one state, not several, so they collapse into one claim
carrying all of their evidence. A rollback to an earlier commit opens a new
claim rather than reopening the old one.

| Field | Meaning |
| --- | --- |
| `stateDigest` | `sha256` of the key-sorted serialisation of the whole state file. Any change to the source state changes it; key ordering alone does not. |
| `id` | `sha256(subject, claim, validFrom)`, truncated to 32 hex characters. The same fact keeps the same id across exports; a changed fact gets a new one. |
| `subject` | The governed key the claim belongs to. See the subject table below for which subjects supersede. |
| `validFrom` | The date the evidence was observed. `validUntil` is `null` while the claim is still current, and otherwise the date a later claim on the same subject superseded it. |
| `authority` | `harness` — this system is the authority for the claim, not a relay of somebody else's. |
| `evidenceIds` | `<work item>/<evidence type>@<commit>`, resolvable against the ledger. Evidence records carry no stored id, and inventing one would mean writing to the ledger. |

Claims are sorted by `subject`, then `validFrom`, then `id`, so identical
ledger state produces byte-identical output apart from `generatedAt`.

**Allowlist.** Two fact kinds are exported today, both derived from the same
source: an item the ledger already records as `released` that still holds
release-smoke evidence for its current head. Everything earlier in the
lifecycle is not a fact about production and produces no claim at all. Adding a
third kind means adding a builder alongside `releaseItemClaims` and
`deploymentStateClaims`; nothing is exported by default.

### Trust boundary

The export is a boundary in its own right, not a continuation of the ledger's.

- **Claims are constructed, not copied.** Each one is built from named scalar
  fields — repository, work item id, merge commit, deployed commit, observation
  date — every one re-checked against the same shapes the release adapter
  enforces. Free text never reaches the output, so evidence prose, blocked
  reasons, `notify` commands, agent transcripts, and any credential or URL
  pasted into them are structurally unable to be exported.
- **Incomplete evidence is refused, not weakened.** A release record missing its
  merge commit, deployed commit, or observation time aborts the export rather
  than producing a vaguer claim. So does a released item with no current
  verification evidence.
- **Ambiguity is refused, not resolved.** Two different commits recorded live in
  one repository at the same instant is the ledger contradicting itself about
  what is running. Ordering them would be a guess, so the export stops instead.
- **An invalid ledger exports nothing.** `export-memory` runs the same
  validation as `validate` first and refuses outright if it fails: a state file
  that contradicts itself is not an authority, and filtering it down to the
  parts that still look intact would launder the contradiction.
- **One direction only.** The consumer trusts this output as far as it trusts
  the machine holding `state.json` — which, as above, is as far as it trusts
  shell access to that machine.

## Which skill was used

Work of different kinds wants different handling, and "the agent chose badly"
is invisible unless the choice is written down. Build the catalog from the
skills actually installed for the agent, so it carries canonical identifiers
rather than names someone invented:

```sh
node src/control-plane.mjs skills ~/.openclaw/agents/cos/agent/codex-home/skills
```

That reads each `<name>/SKILL.md` manifest and records the skill's `name`,
description, and — where the manifest declares them — `metadata.source` and
`metadata.version`, so the record identifies the exact skill and where it came
from:

```json
"skills": [
  { "id": "define-goal", "description": "Turn a fuzzy intention into a measurable goal.", "installed": true },
  { "id": "unlazy", "version": "2.0.0", "source": "https://github.com/Leonxlnx/unlazy",
    "match": "stall|half done|exhaustive", "installed": true }
]
```

Add a `match` regex to any entry to have `next` suggest it; entries without one
always apply. Re-scanning preserves the patterns you wrote, and a catalogued
skill that is no longer on disk is kept and marked `installed: false`, because
work already routed to it still names it.

The agent then records which one it used, and why:

```sh
node src/control-plane.mjs route api#7 unlazy openclaw "long autonomous run, keeps stalling at 80%"
```

A route must name a catalogued skill, a non-blank decider, and a non-blank
reason — an unexplained choice is not a recorded one, and accepting a blank one
would silence the warning below by saying nothing. Duplicate or empty skill ids
and uncompilable `match` patterns are validation errors, so a skill cannot sit
in the catalog quietly matching nothing.

**This records the choice; it does not force one.** A "consult a skill before
acting" rule implemented here would be a rule the agent applies to itself,
which is not a control — the same reason the lifecycle ledger is advisory.
What the harness does instead is make the absence visible: active work with no
recorded approach appears in the brief as **no recorded approach**, and stays
there until someone explains it. If you want the step enforced rather than
observed, it belongs in the runner, alongside the `PreToolUse` hook.

With no catalog configured the feature is simply unused — it does not nag about
every item.

## Learning from what actually happened

A skill that keeps producing blocked work is a fact in the traces long before
anyone notices it. This closes the loop from those traces to a skill that
changed because of them, and — the part that usually goes missing — measures
whether the change worked.

```text
traces → observed pattern → promoted (a person agreed) → skill revision
       → measured outcome (did the signal stop?)
```

```sh
node src/control-plane.mjs patterns
node src/control-plane.mjs promote-pattern skill_ineffective:unlazy jason "applied to work it does not fit"
node src/control-plane.mjs record-revision unlazy skill_ineffective:unlazy 2.1.0 jason "narrowed when-to-use"
```

**Patterns are derived, never stored as opinion.** They are recomputed from the
record on every run, so narrowing the window changes them and nothing can go
stale in the file. Three kinds are reported today:

| Kind | Derived from | Says |
| --- | --- | --- |
| `repeated_block` | lifecycle transitions | one item keeps getting stuck |
| `rule_friction` | the denial log | the agent keeps hitting one rail |
| `skill_ineffective` | routes + transitions | work sent to a skill goes wrong afterwards |

A single bad day is not a pattern: nothing below three occurrences is reported,
and `skill_ineffective` counts only blocks that happened *after* the routing
decision, so a skill is never blamed for what preceded it.

**Promotion needs a person.** Only a pattern the traces currently show can be
promoted, and promotion snapshots the count that justified it. A revision must
answer a promoted pattern and carry a findable identifier — a version or a
commit — and its author.

**A revision is a hypothesis, not a fix.** `assessRevisions` marks it `held`
only after the pattern has not recurred for a settle window (default seven
days). Any recurrence afterwards marks it `regressed`, however good the change
looked, and the pattern goes back to unanswered. Nothing is closed by
declaration.

`held` is a standing claim about the present, not a verdict earned once. Every
revision is re-assessed on every pass, so a pattern that returns months later
still overturns a revision that had held — a fix that stopped working is
exactly what this loop exists to catch.

The brief carries a **Skill loop** section: regressions first, then confirmed
patterns nothing has answered, then what is recurring and unreviewed.

### What this does not do

It does not write the skill change. Deriving "these keep getting blocked" is
arithmetic; deciding what to do about it is judgement, and the harness does not
hold judgement. It also does not pronounce a revision good — it reports only
whether the signal that motivated it came back. Both limits are the same rule
as everywhere else here: the thing measuring the work is not the thing doing
it.

## Safety rails

Rules live in `state.json` and are enforced by `hooks/safety-rules.mjs`, which
runs *before* a tool call. The agent does not call it and cannot skip it.

```json
"safetyRules": [
  { "id": "no-force-push", "tool": "Bash", "commandPattern": "git push .*--force",
    "reason": "Force pushes require explicit review." },
  { "id": "no-prod-config", "tool": "Write", "commandPattern": "^/etc/",
    "reason": "Production config is not agent-writable." }
]
```

`tool` matches the tool name; `commandPattern` is a regex matched against one
subject string per tool — the command for `Bash`, the path for `Write`/`Edit`,
the URL for `WebFetch`. Omit either field to match all of them. Set
`"enabled": false` to retire a rule without deleting the record of it.

Install it in `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "node /ABSOLUTE/PATH/hooks/safety-rules.mjs" }] }
    ]
  }
}
```

Three properties worth knowing:

- **It only ever denies.** It never returns an `allow` decision, because that
  would suppress the permission prompts you configured for yourself.
- **It fails closed.** An unreadable `state.json` or an invalid pattern denies
  the call rather than quietly running unguarded. A *missing* `state.json`
  allows — that means no rules were configured here, not that rules broke.
- **Denials are durable.** Each one appends to
  `ops/coding-control/denials.jsonl` and is grouped by rule under **Needs you**
  in the next brief, so a rail the agent keeps hitting reaches you.

## Changing its direction

Edit `ops/coding-control/direction.md`. Bullets under `## Pinned` sort to the
top of the queue in the order you list them; bullets under `## Not now` sink
below everything. Everything else in the file is prose the agent reads and
obeys. One edit, effective next cycle, no restart.

The test suite builds an in-memory sample control plane and verifies lifecycle
gates, file-conflict detection, memory review, safety rules, pilot closeout,
prioritisation, steering, and the GitHub adapter against stubbed `gh` output.

## Integration model

The state file is the local source of truth, and adapters are the only things
allowed to move an item forward. `src/github.mjs` ships as the first one. It is
read-only against GitHub — it never merges, closes, comments, or deploys — and
it maps observations to evidence:

| Observed | Evidence | Reaches |
| --- | --- | --- |
| PR opened, linked to the issue | `executor_started` | `running` |
| PR marked ready for review | `executor_result` | `reported_done` |
| All checks green *and finished* on the head commit | `verification_passed` | `verified` |
| Any check failing | — | `blocked`, with the commit in the reason |

A queued or in-progress check is pending, never passing, so a PR cannot be
verified while its checks are still running.

`released` needs `release_smoke_passed`, which no GitHub observation supplies.
`src/release.mjs` provides it by observing production directly. Each state
requires the whole chain beneath it, so nothing skips a gate.

**Verification and release are bound to a commit.** `verification_passed` and
`release_smoke_passed` record the commit they were observed on. When a PR head
moves, evidence for the old commit stops satisfying the gate and the item falls
back to `reported_done` until the new head is verified in its own right. The
superseded observation stays on the record — it is still something that was
seen — it just no longer counts. A release adapter therefore cannot inherit a
green run from code that has since changed.

Models may implement or review bounded tasks. They do not certify their own
work, and an agent's report of completion is only ever `reported_done`.

## What this is, and what it is not

This is a supervisory control plane, suitable for running a small number of
repositories with an agent doing the work and a human reading the briefs. It
observes work, prioritises it, records commit-bound evidence, refuses claims it
cannot substantiate, and reports on itself without being asked.

It is not a universal autonomous CTO, and it is not a deployment controller.
Four controls stay with your environment, and the harness is deliberately built
to depend on them rather than to simulate them.

**The lifecycle ledger is advisory.** An agent that simply declines to call the
control plane is unconstrained by it. The only enforcement that survives a
misbehaving agent is enforcement the agent cannot reach: branch protection and
required status checks on the repositories themselves. Configure those, and the
ledger and the repository will agree on what "verified" means. Without them,
this is a very good record of what an honest agent did.

**The safety hook is per-runner.** `hooks/safety-rules.mjs` speaks the Claude
Code `PreToolUse` contract. It is unroutable for an agent running under that
runner, and absent for any other. It reads a tool name and a payload on stdin
and writes a decision on stdout, so adapting it is small — but until you do, a
second agent on a different runner is not covered by it.

**Deployment identity is attested, not proven.** The harness can require two
independent sources to agree on what is live, and it records how many it had.
It cannot prove the claim: something must be trusted, and no number of sources
escapes that. A release certified against a single self-reported witness says
so in its own evidence.

**Promotion authority is not granted here.** Nothing in this repository merges,
deploys, promotes, or rolls back. Both adapters only observe. If you add one
that acts, scope it narrowly, bind it to an exact commit, make it fail closed,
and test it separately in your environment.

## Deciding whether to keep it

Run it over two repositories as a bounded pilot rather than adopting it
outright. Record the pilot's work items and its measured control failures, and
close it out:

```sh
node src/control-plane.mjs pilot-report PILOT_ID
node src/control-plane.mjs record-pilot-decision PILOT_ID scale|adjust|stop you
```

The closeout produces a `scale`, `adjust`, or `stop` recommendation from what
was measured — unverified completion claims, missed evidence deadlines,
abandoned gates, handoffs that needed recovery, policy violations — rather than
from how the pilot felt. A decision cannot be recorded before the report exists.

## License

MIT.
