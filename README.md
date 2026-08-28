# Coding Control Harness

A small, deterministic control plane for supervising parallel coding agents.

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
- **Explainable safety rails** — visible user-authored rules can deny a tool
  action with the reason recorded.
- **Pilot closeout** — a pilot produces a measured `scale`, `adjust`, or
  `stop` recommendation rather than disappearing after initial enthusiasm.

## Quick start

Requires Node.js 20 or later.

```sh
git clone https://github.com/YOUR-ACCOUNT/coding-control-harness.git
cd coding-control-harness
npm test
```

The test suite builds an in-memory sample control plane and verifies lifecycle
gates, file-conflict detection, memory review, safety rules, and pilot closeout.

## Integration model

Use this library as the local source of truth. Connect your own deterministic
adapters to GitHub, CI, project boards, and release tooling:

1. A worker records `executor_started` before coding begins.
2. The worker records `executor_result` when it reports completion.
3. A deterministic CI/review adapter records `verification_passed` on the exact
   commit it observed.
4. A release adapter records `release_smoke_passed` only after production smoke
   checks pass.

The adapters should be the only components allowed to move an item forward.
Models may implement or review bounded tasks, but they should not certify their
own work.

## Safety note

This repository contains policy primitives, not a universal autonomous merge or
deployment system. Any adapter that merges or deploys should be narrowly scoped,
exact-commit bound, fail closed, and separately tested in your environment.

## License

MIT.
