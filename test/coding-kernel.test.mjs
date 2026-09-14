import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  SURFACE_LEASES,
  SURFACE_RUNS,
  SURFACE_WORKTREES,
  SURFACE_PR_LIFECYCLE,
  SURFACE_RETRIES,
  emptyBoundaryManifest,
  executeKernelOperation,
  initializeKernelRuntime,
  readKernelState,
  validateAcceptanceContract,
  writeKernelState,
} from '../src/coding-kernel.mjs';

const BASE_NOW = Date.parse('2026-09-05T00:00:00.000Z');

function nextNow() {
  let now = BASE_NOW;
  return () => {
    now += 1017;
    return new Date(now).toISOString();
  };
}

function makeKernel(executors) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-kernel-test-'));
  const manifest = { ...emptyBoundaryManifest(), executors };
  initializeKernelRuntime(runtimeRoot, manifest);
  const now = nextNow();
  let sequence = 0;
  const request = (payload) => executeKernelOperation({
    runtimeRoot,
    idempotencyKey: `req-${payload.operation}-${++sequence}`,
    now: now(),
    ...payload,
  });
  return { runtimeRoot, request };
}

function cliRequest(runtimeRoot, payload) {
  let output;
  try {
    output = execFileSync('node', [
      'src/coding-kernel.mjs',
      '--runtime-root',
      runtimeRoot,
      '--request',
      JSON.stringify(payload),
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    output = error.stdout.toString();
  }
  return JSON.parse(output);
}

function readEvidenceLines(runtimeRoot) {
  const evidenceFile = path.join(runtimeRoot, 'evidence.jsonl');
  if (!fs.existsSync(evidenceFile)) return [];
  return fs.readFileSync(evidenceFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((entry) => JSON.parse(entry));
}

const ACCEPTANCE_BODY = `## Engineering Acceptance Contract
## Machine-Executable UAT
### Issue-derived user role
### Synthetic test data and starting state
### Steps
### Expected outcomes
### Forbidden outcomes
### Correctness and compliance checks
### Evidence to capture
\`issue-625-acceptance\``;

// 0) acceptance contracts are parseable and an enabled policy blocks incomplete work.
{
  assert.equal(validateAcceptanceContract({ issueNumber: 625, body: ACCEPTANCE_BODY }).valid, true);
  assert.equal(validateAcceptanceContract({ issueNumber: 625, body: '## Engineering Acceptance Contract' }).valid, false);
  const { runtimeRoot, request } = makeKernel([
    { id: 'governance', surfaces: ['policy'], repositories: ['repo-a'], governance: true },
    { id: 'runner', surfaces: [SURFACE_RUNS], repositories: ['repo-a'] },
  ]);
  const enabled = request({ operation: 'kernel-policy-update', actor: 'governance', repository: 'repo-a', payload: { key: 'acceptanceContractRequired', value: { 'repo-a': true } } });
  assert.equal(enabled.ok, true);
  const blocked = request({ operation: 'run-claim', actor: 'runner', repository: 'repo-a', payload: { workItemId: 'WI-625' } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.repair.kind, 'missing-acceptance-contract');
  const admitted = request({ operation: 'run-claim', actor: 'runner', repository: 'repo-a', payload: { workItemId: 'WI-625', acceptanceContract: { issueNumber: 625, body: ACCEPTANCE_BODY } } });
  assert.equal(admitted.ok, true);
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}

// 1) duplicate/overlapping lease claims fail closed and create repair records.
{
  const { runtimeRoot, request } = makeKernel([
    { id: 'agent-a', surfaces: [SURFACE_LEASES], repositories: ['repo-a'], governance: false },
  ]);
  const first = request({ operation: 'lease-acquire', actor: 'agent-a', repository: 'repo-a', payload: { resource: 'src/app.js' } });
  assert.equal(first.ok, true);
  const duplicate = request({ operation: 'lease-acquire', actor: 'agent-a', repository: 'repo-a', payload: { resource: 'src/app.js' }, idempotencyKey: 'dup-lease' });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.repair.kind, 'duplicate-lease');
  const state = readKernelState(runtimeRoot);
  assert.equal(state.repairs.filter((entry) => entry.kind === 'duplicate-lease').length, 1);
  const cached = request({ operation: 'lease-acquire', actor: 'agent-a', repository: 'repo-a', payload: { resource: 'src/app.js' }, idempotencyKey: 'dup-lease' });
  assert.equal(cached.cached, true);
  assert.equal(cached.ok, false);
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}

// 2) stale run and stale lease recovery create bounded repair records.
{
  const { runtimeRoot, request } = makeKernel([
    { id: 'agent-a', surfaces: [SURFACE_RUNS], repositories: ['repo-a'] },
    { id: 'agent-b', surfaces: [SURFACE_RUNS, SURFACE_RETRIES], repositories: ['repo-a'] },
    { id: 'agent-c', surfaces: ['*'], repositories: ['repo-a'] },
  ]);
  request({ operation: 'run-claim', actor: 'agent-a', repository: 'repo-a', payload: { workItemId: 'WI-100' } });
  const state = readKernelState(runtimeRoot);
  const staleRun = state.runs[0];
  staleRun.heartbeatAt = '2000-01-01T00:00:00.000Z';
  writeKernelState(runtimeRoot, state);
  const recovered = request({ operation: 'run-recover', actor: 'agent-b', repository: 'repo-a', payload: { runId: staleRun.id } });
  assert.equal(recovered.ok, true);
  const repaired = readKernelState(runtimeRoot).repairs;
  assert.equal(repaired.filter((entry) => entry.kind === 'stale-run').length, 1);
  request({ operation: 'lease-acquire', actor: 'agent-c', repository: 'repo-a', payload: { resource: 'src/app.js', ttlMs: 1 } });
  const leaseState = readKernelState(runtimeRoot);
  leaseState.leases[0].expiresAt = '2000-01-01T00:00:00.000Z';
  writeKernelState(runtimeRoot, leaseState);
  const kernelRecovery = request({ operation: 'kernel-recover', actor: 'agent-c', repository: 'repo-a', payload: {} });
  assert.equal(kernelRecovery.ok, true);
  assert.equal(kernelRecovery.staleLeases, 1);
  assert.equal(readKernelState(runtimeRoot).repairs.filter((entry) => entry.kind === 'stale-lease').length, 1);
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}

// 3) stale PR evidence is tracked and stale transitions are rejected.
{
  const { runtimeRoot, request } = makeKernel([
    { id: 'builder', surfaces: [SURFACE_PR_LIFECYCLE], repositories: ['repo-a'] },
  ]);
  const opened = request({ operation: 'pr-observe', actor: 'builder', repository: 'repo-a', payload: { event: 'opened', workItemId: 'PR-1', pr: 101 } });
  assert.equal(opened.ok, true);
  const ready = request({ operation: 'pr-observe', actor: 'builder', repository: 'repo-a', payload: { event: 'ready_for_review', workItemId: 'PR-1', pr: 101 } });
  assert.equal(ready.ok, true);
  const verified = request({ operation: 'pr-observe', actor: 'builder', repository: 'repo-a', payload: { event: 'checks_passed', workItemId: 'PR-1', pr: 101, head: 'abcdef1' } });
  assert.equal(verified.ok, true);
  const moved = request({ operation: 'pr-observe', actor: 'builder', repository: 'repo-a', payload: { event: 'head_changed', workItemId: 'PR-1', head: '1234567' } });
  assert.equal(moved.ok, true);
  const staleState = readKernelState(runtimeRoot);
  const item = staleState.prItems[0];
  const staleEvidence = item.evidence.filter((entry) => !entry.commit || entry.commit !== '1234567');
  assert.equal(staleEvidence.length >= 1, true);
  assert.equal(staleState.repairs.some((entry) => entry.kind === 'stale-pr-evidence'), true);
  const staleAdvance = request({ operation: 'pr-advance', actor: 'builder', repository: 'repo-a', payload: { workItemId: 'PR-1', to: 'verified' } });
  assert.equal(staleAdvance.ok, false);
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}

// 4) boundary: unknown actors or unauthorized surfaces fail closed.
{
  const { runtimeRoot, request } = makeKernel([
    { id: 'builder', surfaces: [SURFACE_LEASES], repositories: ['repo-a'], governance: false },
  ]);
  const deniedRun = request({ operation: 'run-claim', actor: 'builder', repository: 'repo-a', payload: { workItemId: 'WI-200' } });
  assert.equal(deniedRun.ok, false);
  assert.match(deniedRun.reason, /cannot use surface runs|not authorized for/i);
  const deniedPolicy = request({ operation: 'kernel-policy-update', actor: 'builder', repository: 'repo-a', payload: { key: 'release-window', value: 'business-hours' } });
  assert.equal(deniedPolicy.ok, false);
  assert.equal(deniedPolicy.repair.kind, 'boundary-violation');
  const unknownExecutor = request({ operation: 'lease-release', actor: 'ghost', repository: 'repo-a', payload: { leaseId: 'nonexistent' } });
  assert.equal(unknownExecutor.ok, false);
  assert.equal(unknownExecutor.repair.kind, 'unknown-executor');
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}

// 5) unknown run outcomes fail closed and emit bounded repair records.
{
  const { runtimeRoot, request } = makeKernel([
    { id: 'runner', surfaces: [SURFACE_RUNS], repositories: ['repo-a'] },
  ]);
  request({ operation: 'run-claim', actor: 'runner', repository: 'repo-a', payload: { workItemId: 'WI-300' } });
  const state = readKernelState(runtimeRoot);
  const runId = state.runs[0].id;
  const unknown = request({ operation: 'run-complete', actor: 'runner', repository: 'repo-a', payload: { runId, outcome: 'corrupted' } });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.repair.kind, 'unknown-run-outcome');
  assert.equal(readKernelState(runtimeRoot).repairs.filter((entry) => entry.kind === 'unknown-run-outcome').length, 1);
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}

// 6) retry caps, deadlines and terminal behavior are enforced.
{
  const { runtimeRoot, request } = makeKernel([
    { id: 'runner', surfaces: [SURFACE_RUNS, SURFACE_RETRIES], repositories: ['repo-a'] },
    { id: 'auditor', surfaces: [SURFACE_RUNS, SURFACE_RETRIES], repositories: ['repo-a'] },
  ]);
  request({ operation: 'run-claim', actor: 'runner', repository: 'repo-a', payload: { workItemId: 'WI-400' } });
  let state = readKernelState(runtimeRoot);
  const runId = state.runs[0].id;
  request({ operation: 'run-complete', actor: 'runner', repository: 'repo-a', payload: { runId, outcome: 'failed' } });
  const started = request({
    operation: 'retry-start',
    actor: 'runner',
    repository: 'repo-a',
    payload: { runId, predicate: 'always', cap: 2, baseline: 'running' },
  });
  assert.equal(started.ok, true);
  state = readKernelState(runtimeRoot);
  const retryId = state.retries[0].id;
  request({ operation: 'retry-attempt', actor: 'auditor', repository: 'repo-a', payload: { retryId, predicate: 'always' } });
  request({ operation: 'retry-attempt', actor: 'auditor', repository: 'repo-a', payload: { retryId, predicate: 'always' } });
  const exhausted = request({ operation: 'retry-attempt', actor: 'auditor', repository: 'repo-a', payload: { retryId, predicate: 'always' } });
  assert.equal(exhausted.status, 'exhausted');
  state = readKernelState(runtimeRoot);
  assert.equal(state.retries[0].status, 'exhausted');
  assert.equal(state.retries[0].attempts, 3);
  assert.equal(state.repairs.filter((entry) => entry.kind === 'retry-exhausted').length, 1);

  // Terminal path when predicate no longer matches.
  const terminalRetry = request({
    operation: 'retry-start',
    actor: 'runner',
    repository: 'repo-a',
    payload: { runId, predicate: 'onFailure', cap: 1, baseline: 'running' },
  });
  assert.equal(terminalRetry.ok, true);
  const terminalId = readKernelState(runtimeRoot).retries.slice(-1)[0].id;
  let terminalState = readKernelState(runtimeRoot);
  terminalState.runs[0].status = 'running';
  writeKernelState(runtimeRoot, terminalState);
  state = readKernelState(runtimeRoot);
  state.retries[state.retries.length - 1].status = 'active';
  writeKernelState(runtimeRoot, state);
  request({ operation: 'retry-attempt', actor: 'auditor', repository: 'repo-a', payload: { retryId: terminalId, predicate: 'onUnknown' } });
  terminalState = readKernelState(runtimeRoot);
  assert.equal(terminalState.repairs.some((entry) => entry.kind === 'retry-terminated'), true);
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}

// 7) worktree reconcile marks orphaned trees and records repairs.
{
  const { runtimeRoot, request } = makeKernel([
    { id: 'agent-a', surfaces: [SURFACE_WORKTREES], repositories: ['repo-a'] },
  ]);
  const created = request({ operation: 'worktree-create', actor: 'agent-a', repository: 'repo-a', payload: { worktreeId: 'wt-fs', repository: 'repo-a' } });
  assert.equal(created.ok, true);
  const state = readKernelState(runtimeRoot);
  const worktree = state.worktrees[0];
  fs.rmSync(worktree.path, { recursive: true, force: true });
  const reconciled = request({ operation: 'worktree-reconcile', actor: 'agent-a', repository: 'repo-a', payload: {} });
  assert.equal(reconciled.ok, true);
  const reconciledState = readKernelState(runtimeRoot);
  const reconciledEntry = reconciledState.worktrees.find((item) => item.id === worktree.id);
  assert.equal(reconciledEntry.status, 'orphaned');
  assert.equal(reconciledState.repairs.some((entry) => entry.kind === 'orphaned-worktree' && entry.targetId === worktree.id), true);
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}

// 8) PR lifecycle transitions remain deterministic and evidence-bound.
{
  const { runtimeRoot, request } = makeKernel([
    { id: 'builder', surfaces: [SURFACE_PR_LIFECYCLE], repositories: ['repo-a'] },
  ]);
  const open = request({ operation: 'pr-observe', actor: 'builder', repository: 'repo-a', payload: { event: 'opened', workItemId: 'PR-2', pr: 202 } });
  assert.equal(open.ok, true);
  const review = request({ operation: 'pr-observe', actor: 'builder', repository: 'repo-a', payload: { event: 'ready_for_review', workItemId: 'PR-2', pr: 202 } });
  assert.equal(review.ok, true);
  const verified = request({ operation: 'pr-observe', actor: 'builder', repository: 'repo-a', payload: { event: 'checks_passed', workItemId: 'PR-2', pr: 202, head: 'abcd123' } });
  assert.equal(verified.ok, true);
  const released = request({ operation: 'pr-observe', actor: 'builder', repository: 'repo-a', payload: { event: 'smoke_passed', workItemId: 'PR-2', pr: 202, head: 'abcd123' } });
  assert.equal(released.ok, true);
  const item = readKernelState(runtimeRoot).prItems[0];
  assert.equal(item.status, 'released');
  assert.equal(item.evidence.filter((entry) => entry.type === 'executor_started').length, 1);
  assert.equal(item.evidence.filter((entry) => entry.type === 'executor_result').length, 1);
  assert.equal(item.evidence.filter((entry) => entry.type === 'verification_passed').length, 1);
  assert.equal(item.evidence.filter((entry) => entry.type === 'release_smoke_passed').length, 1);
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}

// 9) unknown operation is visible and returns immutable repair evidence through CLI.
{
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-kernel-cli-test-'));
  initializeKernelRuntime(runtimeRoot, {
    ...emptyBoundaryManifest(),
    executors: [{ id: 'builder', surfaces: ['*'], repositories: ['repo-a'] }],
  });
  const duplicate = cliRequest(runtimeRoot, {
    operation: 'ghost-operation',
    actor: 'builder',
    repository: 'repo-a',
    idempotencyKey: 'cli-unsupported',
    payload: {},
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.repair.kind, 'unsupported-operation');

  const evidence = readEvidenceLines(runtimeRoot);
  assert.ok(evidence.length >= 1);
  assert.equal(evidence[evidence.length - 1].kind, 'kernel-operation');
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}

console.log('coding-kernel tests: passed');
