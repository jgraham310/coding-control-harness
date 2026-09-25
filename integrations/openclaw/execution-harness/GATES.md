# Gates: Deterministic adapter control plane

- [x] G1: Adapter manifests are machine-readable and fail closed when authority, sources, or escalation boundaries are incomplete.
  CHECK: node deterministic-engine.test.mjs
  EXPECT: deterministic engine tests: passed
  EVIDENCE: deterministic engine tests: passed

- [x] G2: The action queue provides idempotent, dependency-aware, retry-bounded transitions without model interpretation.
  CHECK: node deterministic-engine.test.mjs
  EXPECT: deterministic engine tests: passed
  EVIDENCE: deterministic engine tests: passed

- [x] G3: Snapshot fingerprints suppress unchanged external observations and emit a deterministic material-delta event when source evidence changes.
  CHECK: node deterministic-engine.test.mjs
  EXPECT: deterministic engine tests: passed
  EVIDENCE: deterministic engine tests: passed

- [x] G4: Routine tmux-pane states are classified deterministically, including missing session, active work, routine prompt, Jason-only prompt, and unknown state.
  CHECK: node deterministic-engine.test.mjs
  EXPECT: deterministic engine tests: passed
  EVIDENCE: deterministic engine tests: passed

- [x] G5: A briefing view is generated from ledger records without model use and identifies only action-required decisions, off-track goals, and upcoming deadlines.
  CHECK: node deterministic-engine.test.mjs
  EXPECT: deterministic engine tests: passed
  EVIDENCE: deterministic engine tests: passed

- [x] G6: The existing harness and the deterministic-engine suite pass, and the operating contract documents model escalation as the exception.
  CHECK: node test-harness.mjs && node deterministic-engine.test.mjs
  EXPECT: execution-harness tests: passed
  EVIDENCE: execution-harness tests: passed | deterministic engine tests: passed

- [x] G7: Extracted goal-contract, scheduler-proof, state-handoff, and independent-review patterns remain deterministic by default and are verified by the engine and development-dispatch suites.
  CHECK: node deterministic-engine.test.mjs && node test-harness.mjs
  EXPECT: deterministic engine tests: passed
  EVIDENCE: deterministic engine tests: passed | development adapter transition tests: passed | execution-harness tests: passed

- [x] G8: A recoverable executor loss creates a fresh tmux lane only after literal worktree verification and passes the durable handoff forward; execution-contract validation blocks PR-open until exact evidence and artifact identity are recorded.
  CHECK: node test-harness.mjs
  EXPECT: execution-harness tests: passed
  EVIDENCE: development adapter transition tests: passed | execution-harness tests: passed

- [x] G9: The live recoverable Astellen lane is migrated to the enforced execution contract and automatic-recovery policy; Jason-only pane language is classified deterministically rather than advanced as a routine prompt.
  CHECK: node deterministic-engine.test.mjs && node harness.mjs status --skip-github --skip-staging
  EXPECT: deterministic engine tests: passed
  EVIDENCE: deterministic engine tests: passed | astellen-eeoc-404 dispatch.autoRecover=true | phase=blocked on the recorded Jason-only decision

- [x] G10: Durable WorkState transitions are schema-validated, version-checked, idempotency-keyed, evidence-backed, and survive a fresh runtime process without replaying a prepared action.
  CHECK: node work-state.test.mjs && node work-state-runtime.test.mjs && node test-harness.mjs
  EXPECT: work-state tests: passed | work-state runtime restart tests: passed | execution-harness tests: passed
  EVIDENCE: 2026-09-19 local deterministic run passed; stale expected-version transition was rejected and a development recovery handoff resolved to bounded WorkState context.

- [x] G11: CivicLine and TEMS CTO reset-time guidance binds durable execution to canonical WorkState, immutable evidence, expected-version checks, and idempotency keys.
  CHECK: node cto-workstate-contract.test.mjs
  EXPECT: cto WorkState contract tests: passed
  EVIDENCE: 2026-09-19 local deterministic run passed; both reset-time workspace contracts resolve their declared canonical WorkState with zero pending actions.
