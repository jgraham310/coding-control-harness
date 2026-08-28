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
| `next` | Prints the ranked queue with the reason for each position |
| `brief` | Writes and prints the report for you, since the last brief |
| `validate` | Fails if the state file contradicts its own evidence |
| `board` | Dumps the work items |

## Making it proactive

The harness has no scheduler; your agent runner is the scheduler. Point it at
`prompts/cycle.md`, which tells the agent to read your direction file, run a
cycle, advance exactly one item, and report:

```sh
0 */2 * * * cd /path/to/repo && claude -p "$(cat prompts/cycle.md)" >> ops/coding-control/cycle.log 2>&1
```

Delivery of the brief is the agent's job, not the harness's — it sends the
brief over whatever channel it already has.

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
| All checks green on the head commit | `verification_passed` | `verified` |
| Any check failing | — | `blocked`, with the commit in the reason |

`released` is deliberately out of reach: it needs `release_smoke_passed`, which
no GitHub observation supplies. Write that adapter against your own production
smoke checks. Each state requires the whole chain beneath it, so nothing skips
a gate.

Models may implement or review bounded tasks. They do not certify their own
work, and an agent's report of completion is only ever `reported_done`.

## What this does not do

Tool-level rails are enforced (see **Safety rails**), but the lifecycle ledger
is not: an agent that declines to call the control plane is unconstrained by
it. Pair the harness with branch protection and required status checks so the
ledger and the repository agree on what "verified" means.

## Safety note

This repository contains policy primitives, not a universal autonomous merge or
deployment system. Any adapter that merges or deploys should be narrowly scoped,
exact-commit bound, fail closed, and separately tested in your environment.

## License

MIT.
