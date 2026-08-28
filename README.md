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

That reads GitHub's own deployment record for the environment. For a target
GitHub does not know about, use a command that prints the live SHA:

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

## What this does not do

Two limits are worth stating plainly.

**The hook is per-runner, not universal.** `hooks/safety-rules.mjs` speaks the
Claude Code `PreToolUse` contract. It is unroutable for an agent running under
that runner, and absent for any other. It reads a tool name and a payload on
stdin and writes a decision on stdout, so adapting it is small — but until you
do, a second agent on a different runner is not covered by it.

**The lifecycle ledger is advisory.** An agent that simply declines to call the
control plane is unconstrained by it. The only enforcement that survives a
misbehaving agent is enforcement the agent cannot reach: branch protection and
required status checks on the repositories themselves. Configure those, and the
ledger and the repository will agree on what "verified" means. Without them,
this is a very good record of what an honest agent did.

## Safety note

This repository contains policy primitives, not a universal autonomous merge or
deployment system. Any adapter that merges or deploys should be narrowly scoped,
exact-commit bound, fail closed, and separately tested in your environment.

## License

MIT.
