#!/usr/bin/env node
/**
 * Machine-readable kernel that owns coding execution operations.
 *
 * Exposed as a stable process/JSON boundary, it authoritatively controls:
 * - lease acquire/release/reconcile/heartbeat
 * - isolated worktree create/remove/reconcile
 * - coding run claim/heartbeat/complete/recover
 * - PR lifecycle observation/advancement
 * - bounded retry/repair
 * - manifest-gated mutation authority
 *
 * All mutation operations execute through argument arrays and persist runtime state
 * outside Git in an atomic JSON file with an append-only evidence log.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  addEvidence as addControlEvidence,
  setStatus as setControlStatus,
} from './control-plane.mjs';

export const KERNEL_SCHEMA = 'coding_control_kernel_state/v1';
export const KERNEL_MANIFEST_SCHEMA = 'coding_control_kernel_manifest/v1';
export const KERNEL_INTERFACE_VERSION = '1.0.0';
export const KERNEL_REQUEST_SCHEMA = 'coding_control_kernel_request/v1';
export const KERNEL_OPERATIONS = new Set([
  'lease-acquire',
  'lease-release',
  'lease-reconcile',
  'lease-heartbeat',
  'worktree-create',
  'worktree-remove',
  'worktree-reconcile',
  'run-claim',
  'run-heartbeat',
  'run-complete',
  'run-recover',
  'pr-observe',
  'pr-advance',
  'retry-start',
  'retry-attempt',
  'retry-reconcile',
  'kernel-recover',
  'kernel-policy-update',
]);

export const SURFACE_LEASES = 'leases';
export const SURFACE_WORKTREES = 'worktrees';
export const SURFACE_RUNS = 'runs';
export const SURFACE_PR_LIFECYCLE = 'prLifecycle';
export const SURFACE_RETRIES = 'retries';
export const SURFACE_REPAIRS = 'repairs';
export const SURFACE_EVIDENCE = 'evidence';
export const SURFACE_POLICY = 'policy';
export const SURFACE_KERNEL = 'kernel';

const DEFAULT_RUNTIME_ROOT = path.join(os.tmpdir(), 'coding-control-kernel-runtime');
const OP_ID_PREFIX = 'kop';
const EVIDENCE_LOG = 'evidence.jsonl';
const STATE_FILE = 'state.json';
const MANIFEST_FILE = 'manifest.json';
const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LEASE_HEARTBEAT_TTL_MS = 60 * 1000;
const DEFAULT_RUN_TTL_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_DEADLINE_MS = 2 * 60 * 60 * 1000;
const MAX_RETRY_ATTEMPTS_DEFAULT = 3;
const KERNEL_LOCK_STALE_MS = 15 * 60 * 1000;
const EVIDENCE_PREFIX = /^[0-9a-f]{7,40}$/i;
const ACCEPTANCE_HEADINGS = Object.freeze([
  '## Engineering Acceptance Contract',
  '## Machine-Executable UAT',
  '### Issue-derived user role',
  '### Synthetic test data and starting state',
  '### Steps',
  '### Expected outcomes',
  '### Forbidden outcomes',
  '### Correctness and compliance checks',
  '### Evidence to capture',
]);
const BOUNDARY_SURFACES = new Set([
  '*',
  SURFACE_LEASES,
  SURFACE_WORKTREES,
  SURFACE_RUNS,
  SURFACE_PR_LIFECYCLE,
  SURFACE_RETRIES,
  SURFACE_REPAIRS,
  SURFACE_EVIDENCE,
  SURFACE_POLICY,
  SURFACE_KERNEL,
]);

function isObject(value) {
  return typeof value === 'object' && value !== null;
}

function normalize(value) {
  return String(value || '').trim();
}

/**
 * Validate an issue-derived acceptance contract before a coding run begins.
 * This intentionally accepts the issue body as data rather than fetching it:
 * the caller records exactly the contract it asked the executor to satisfy.
 */
export function validateAcceptanceContract({ issueNumber, body } = {}) {
  const number = Number(issueNumber);
  const text = typeof body === 'string' ? body : '';
  const missing = ACCEPTANCE_HEADINGS.filter((heading) => !text.includes(heading));
  if (!Number.isInteger(number) || number <= 0) missing.unshift('a positive issue number');
  if (!new RegExp(`\\bissue-${number}-acceptance\\b`, 'i').test(text)) missing.push(`named deterministic target issue-${number}-acceptance`);
  return { valid: missing.length === 0, missing };
}

function acceptanceContractRequired(state, repository) {
  const policy = state.policy?.acceptanceContractRequired;
  return policy === true || (isObject(policy) && policy[repository] === true);
}

function assert(condition, message) {
  if (!condition) throw new KernelError('invalid-argument', message);
}

function nowIso() {
  return new Date().toISOString();
}

function parseIntPositive(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function shortSha(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

function isFuture(value) {
  return Date.parse(value) > Date.now();
}

function isExpired(expiryAt, now = Date.now()) {
  return Date.parse(expiryAt) <= now;
}

function sortByCreatedAt(entries) {
  return [...entries].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function repositoryMatches(target, allowed) {
  if (!allowed || !allowed.length || allowed.includes('*')) return true;
  return allowed.includes(target);
}

class KernelError extends Error {
  constructor(kind, message, repair = {}) {
    super(message);
    this.name = 'KernelError';
    this.kind = kind;
    this.repair = repair;
  }
}

function requestFingerprint(request) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      operation: request.operation,
      actor: request.actor,
      repository: request.repository,
      expected: request.expected,
      payload: request.payload,
    }))
    .digest('hex');
}

export function emptyKernelState() {
  return {
    schema: KERNEL_SCHEMA,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    policy: {},
    leases: [],
    worktrees: [],
    runs: [],
    prItems: [],
    retries: [],
    repairs: [],
    operations: [],
    evidence: [],
  };
}

export function emptyBoundaryManifest() {
  return {
    schema: KERNEL_MANIFEST_SCHEMA,
    generatedAt: nowIso(),
    governanceSurfaces: [SURFACE_POLICY],
    executors: [],
  };
}

export function resolveKernelRoot({ runtimeRoot } = {}) {
  return path.resolve(runtimeRoot || process.env.CODING_CONTROL_KERNEL_RUNTIME || DEFAULT_RUNTIME_ROOT);
}

function runtimePaths(root) {
  return {
    root,
    statePath: path.join(root, STATE_FILE),
    evidencePath: path.join(root, EVIDENCE_LOG),
    manifestPath: path.join(root, MANIFEST_FILE),
    lockPath: path.join(root, '.lock'),
  };
}

function safeJsonParse(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`invalid JSON at ${filePath}: ${error.message}`);
  }
}

function normalizeState(state) {
  return {
    ...emptyKernelState(),
    ...state,
    policy: isObject(state?.policy) ? { ...state.policy } : {},
    leases: Array.isArray(state?.leases) ? state.leases : [],
    worktrees: Array.isArray(state?.worktrees) ? state.worktrees : [],
    runs: Array.isArray(state?.runs) ? state.runs : [],
    prItems: Array.isArray(state?.prItems) ? state.prItems : [],
    retries: Array.isArray(state?.retries) ? state.retries : [],
    repairs: Array.isArray(state?.repairs) ? state.repairs : [],
    operations: Array.isArray(state?.operations) ? state.operations : [],
    evidence: Array.isArray(state?.evidence) ? state.evidence : [],
  };
}

function normalizeManifest(manifest) {
  return {
    ...emptyBoundaryManifest(),
    ...manifest,
    executors: Array.isArray(manifest?.executors) ? manifest.executors : [],
    governanceSurfaces: Array.isArray(manifest?.governanceSurfaces) ? manifest.governanceSurfaces : [SURFACE_POLICY],
  };
}

function assertManifestExecutor(entry) {
  const id = normalize(entry.id);
  assert(id, 'executor id must be a non-empty string');
  assert(Array.isArray(entry.surfaces), `executor ${id} must define mutation surfaces`);
  assert(Array.isArray(entry.repositories), `executor ${id} must declare repositories`);
}

function validateManifest(manifest) {
  for (const executor of manifest.executors) {
    assertManifestExecutor(executor);
    for (const surface of executor.surfaces) {
      assert(BOUNDARY_SURFACES.has(surface), `executor ${executor.id} declares unsupported surface ${surface}`);
    }
  }
}

export function readKernelState(root) {
  const { statePath } = runtimePaths(resolveKernelRoot({ runtimeRoot: root }));
  const existing = safeJsonParse(statePath);
  if (!existing) return emptyKernelState();
  if (existing.schema && existing.schema !== KERNEL_SCHEMA) {
    throw new Error(`Invalid kernel state schema at ${statePath}: ${existing.schema}`);
  }
  const state = normalizeState(existing);
  if (state.schema !== KERNEL_SCHEMA) state.schema = KERNEL_SCHEMA;
  return state;
}

export function readBoundaryManifest(root) {
  const { manifestPath } = runtimePaths(resolveKernelRoot({ runtimeRoot: root }));
  const existing = safeJsonParse(manifestPath);
  if (!existing) return emptyBoundaryManifest();
  if (existing.schema && existing.schema !== KERNEL_MANIFEST_SCHEMA) {
    throw new Error(`Invalid kernel manifest schema at ${manifestPath}: ${existing.schema}`);
  }
  return normalizeManifest(existing);
}

function withAtomicWrite(targetPath, payload) {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, targetPath);
}

export function writeKernelState(root, state) {
  const { statePath } = runtimePaths(resolveKernelRoot({ runtimeRoot: root }));
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const next = { ...state, updatedAt: nowIso() };
  next.schema = KERNEL_SCHEMA;
  withAtomicWrite(statePath, next);
}

export function writeBoundaryManifest(root, manifest) {
  const { manifestPath } = runtimePaths(resolveKernelRoot({ runtimeRoot: root }));
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const next = normalizeManifest(manifest);
  next.schema = KERNEL_MANIFEST_SCHEMA;
  next.generatedAt = nowIso();
  withAtomicWrite(manifestPath, next);
}

export function initializeKernelRuntime(root, manifest = emptyBoundaryManifest()) {
  const paths = runtimePaths(resolveKernelRoot({ runtimeRoot: root }));
  fs.mkdirSync(paths.root, { recursive: true });
  writeBoundaryManifest(paths.root, manifest);
  writeKernelState(paths.root, emptyKernelState());
}

function canonicalRequest(request) {
  if (!isObject(request)) throw new Error('Kernel request must be an object.');
  const operation = normalize(request.operation);
  assert(operation, 'Kernel request requires operation');
  const payload = isObject(request.payload) ? request.payload : {};
  return {
    operation,
    actor: normalize(request.actor),
    repository: normalize(request.repository),
    idempotencyKey: normalize(request.idempotencyKey),
    payload,
    expected: normalize(request.expected),
    now: request.now || nowIso(),
    runtimeRoot: resolveKernelRoot({ runtimeRoot: request.runtimeRoot }),
    fingerprint: shortSha(`${operation}|${request.actor || ''}|${request.repository || ''}|${JSON.stringify(payload)}|${request.expected || ''}`),
  };
}

function getExecutor(manifest, actorId) {
  const actor = normalize(actorId);
  return (manifest.executors || []).find((entry) => entry.id === actor);
}

function requireExecutor(manifest, actor, surface, repository, operation) {
  const resolved = getExecutor(manifest, actor);
  if (!resolved) throw new KernelError('unknown-executor', `Unknown executor: ${actor}`, { surface, repository, targetId: operation });
  if (!repositoryMatches(normalize(repository || resolved.defaultRepository), resolved.repositories)) {
    throw new KernelError('boundary-violation', `Executor ${actor} is not authorized for repository ${normalize(repository || resolved.defaultRepository || '(unspecified)')}`, {
      surface,
      repository: repository || resolved.defaultRepository,
      targetId: operation,
    });
  }
  if (!resolved.surfaces.includes('*') && !resolved.surfaces.includes(surface)) {
    throw new KernelError('boundary-violation', `Executor ${actor} cannot use surface ${surface} for ${operation}`, {
      surface,
      repository,
      targetId: operation,
    });
  }
  if (surface === SURFACE_POLICY && !resolved.governance) {
    throw new KernelError('boundary-violation', `Executor ${actor} is not authorized for governance surface ${surface}`, {
      surface,
      repository,
      targetId: operation,
    });
  }
  return resolved;
}

function operationId(state) {
  return `${OP_ID_PREFIX}-${sortByCreatedAt(state.operations).length + 1}`;
}

function leaseId(state, resource) {
  return `lease-${resource.replace(/[^\w.-]/g, '_')}-${state.leases.length + 1}`;
}

function runId(state, workItemId) {
  return `run-${workItemId}-${state.runs.length + 1}`;
}

function worktreeId(state, repository) {
  return `wt-${repository.replace(/[^\w.-]/g, '_')}-${state.worktrees.length + 1}`;
}

function retryId(state, targetId) {
  return `retry-${targetId}-${state.retries.length + 1}`;
}

function repairId(state, targetId) {
  return `repair-${targetId}-${state.repairs.length + 1}`;
}

function makeRepair(state, { kind, actor, surface, reason, targetId, repository, cap = MAX_RETRY_ATTEMPTS_DEFAULT, deadline }) {
  const existing = state.repairs.find((entry) => entry.kind === kind && entry.targetId === targetId && entry.status === 'open');
  if (existing) return existing;
  const repair = {
    id: repairId(state, targetId),
    kind,
    actor,
    surface,
    repository: repository || null,
    reason,
    status: 'open',
    attempts: 0,
    cap,
    createdAt: nowIso(),
    deadline: deadline || new Date(Date.now() + DEFAULT_RETRY_DEADLINE_MS).toISOString(),
    targetId,
  };
  state.repairs.push(repair);
  return repair;
}

function appendEvidence(state, { kind, actor, repository, workItemId, runId: runIdentifier, payload }) {
  const entry = {
    id: `evidence-${shortSha(JSON.stringify({ kind, actor, repository, workItemId, runId: runIdentifier, payload, at: nowIso() }))}`,
    kind,
    actor,
    repository: repository || null,
    workItemId: workItemId || null,
    runId: runIdentifier || null,
    observedAt: nowIso(),
    payload,
  };
  state.evidence.push(entry);
  return entry;
}

function appendEvidenceLog(root, entry) {
  const { evidencePath } = runtimePaths(root);
  fs.appendFileSync(evidencePath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function operationFailure(state, request, reason, repairKind, options = {}) {
  const repair = makeRepair(state, {
    kind: repairKind,
    actor: request.actor,
    surface: options.surface || SURFACE_REPAIRS,
    reason,
    targetId: options.targetId,
    repository: options.repository,
    cap: options.cap,
    deadline: options.deadline,
  });
  return {
    ok: false,
    reason,
    repair: { id: repair.id, kind: repair.kind, status: repair.status, targetId: repair.targetId },
  };
}

function operationSuccess(state, request, result) {
  return { ...(result || {}), ok: true };
}

function cachedOrRun(state, request) {
  if (!request.idempotencyKey) return null;
  const existing = state.operations.find((entry) => entry.requestId === request.idempotencyKey && entry.operation === request.operation);
  if (!existing) return null;
  if (existing.requestFingerprint !== request.fingerprint) {
    return {
      ok: false,
      reason: `idempotency key ${request.idempotencyKey} reused with different payload`,
      operation: request.operation,
      operationId: existing.id,
      actor: existing.actor,
      cached: true,
      repair: { id: `repair-${shortSha(existing.id + request.fingerprint)}`, kind: 'idempotency-conflict', status: 'closed', targetId: existing.id },
    };
  }
  return { ...existing.result, ok: existing.status === 'applied', operation: existing.operation, operationId: existing.id, actor: existing.actor, cached: true };
}

function isActiveLease(lease, at = Date.now()) {
  return lease.status === 'active' && !lease.releasedAt && !isExpired(lease.expiresAt, at);
}

function activeLease(state, resource, now = Date.now()) {
  return state.leases.find((lease) => lease.resource === resource && isActiveLease(lease, now));
}

function findRun(state, runIdValue) {
  return state.runs.find((run) => run.id === runIdValue);
}

function requireStateRun(state, runIdValue) {
  const run = findRun(state, runIdValue);
  if (!run) throw new KernelError('missing-run', `Unknown run: ${runIdValue}`, { surface: SURFACE_RUNS, targetId: runIdValue });
  return run;
}

function isRunStale(run, now = Date.now()) {
  const heartbeatAt = Date.parse(run.heartbeatAt || run.startedAt || run.createdAt);
  return heartbeatAt + (run.heartbeatTtlMs || DEFAULT_RUN_TTL_MS) < now;
}

function findPrItem(state, workItemId) {
  return state.prItems.find((item) => item.id === workItemId);
}

function buildPrItem({ workItemId, repository, actor, now = nowIso() }) {
  return {
    id: workItemId,
    owner: actor || 'kernel',
    repository,
    status: 'prepared',
    statusAt: now,
    history: [],
    evidence: [],
    evidenceAt: {},
  };
}

function prAppendEvidence(item, evidence) {
  return addControlEvidence(item, evidence);
}

function handleLeaseAcquire(state, manifest, request) {
  const actor = requireExecutor(manifest, request.actor, SURFACE_LEASES, request.repository, request.operation);
  const payload = request.payload;
  const resource = normalize(payload.resource);
  const repository = normalize(payload.repository || request.repository);
  if (!resource) return operationFailure(state, request, 'lease acquire requires resource', 'invalid-leased-resource', { surface: SURFACE_LEASES });
  if (!repository) return operationFailure(state, request, 'lease acquire requires repository', 'invalid-leased-resource', { surface: SURFACE_LEASES });

  const now = Date.parse(request.now);
  const ttlMs = parseIntPositive(payload.ttlMs, DEFAULT_LEASE_TTL_MS);
  const heartbeatTtl = parseIntPositive(payload.heartbeatTtlMs, DEFAULT_LEASE_HEARTBEAT_TTL_MS);
  if (activeLease(state, resource, now)) {
    return operationFailure(state, request, `resource ${resource} already has an active lease`, 'duplicate-lease', {
      surface: SURFACE_LEASES,
      repository,
      targetId: resource,
      cap: 1,
      deadline: nowIso(),
    });
  }
  const acquired = {
    id: leaseId(state, resource),
    resource,
    repository,
    executor: actor.id,
    actor: actor.id,
    acquiredAt: request.now,
    heartbeatAt: request.now,
    heartbeatTtlMs: heartbeatTtl,
    expiresAt: new Date(now + ttlMs).toISOString(),
    status: 'active',
    notes: normalize(payload.notes),
  };
  state.leases.push(acquired);
  const evidence = appendEvidence(state, { kind: 'lease-acquired', actor: actor.id, repository, payload: { leaseId: acquired.id, resource } });
  appendEvidenceLog(request.runtimeRoot, evidence);
  return operationSuccess(state, request, {
    lease: acquired,
    evidenceId: evidence.id,
  });
}

function handleLeaseHeartbeat(state, manifest, request) {
  const actor = requireExecutor(manifest, request.actor, SURFACE_LEASES, request.repository, request.operation);
  const leaseIdValue = normalize(request.payload.leaseId);
  if (!leaseIdValue) return operationFailure(state, request, 'lease heartbeat requires leaseId', 'invalid-lease-heartbeat', {
    surface: SURFACE_LEASES,
    repository: request.repository,
    cap: 1,
  });
  const lease = state.leases.find((entry) => entry.id === leaseIdValue);
  if (!lease) return operationFailure(state, request, `unknown lease: ${leaseIdValue}`, 'unknown-lease', { surface: SURFACE_LEASES, targetId: leaseIdValue, repository: request.repository, cap: 1 });
  if (lease.executor !== request.actor && !actor.governance) {
    return operationFailure(state, request, `lease ${lease.id} belongs to ${lease.executor}`, 'lease-ownership-mismatch', {
      surface: SURFACE_LEASES,
      repository: lease.repository,
      targetId: lease.id,
      cap: 1,
    });
  }
  if (!lease.releasedAt && !isExpired(lease.expiresAt, Date.parse(request.now))) {
    lease.heartbeatAt = request.now;
    const ttlMs = parseIntPositive(request.payload.ttlMs, lease.heartbeatTtlMs || DEFAULT_LEASE_HEARTBEAT_TTL_MS);
    lease.expiresAt = new Date(Date.parse(request.now) + ttlMs).toISOString();
    return operationSuccess(state, request, { leaseId: lease.id, heartbeatAt: lease.heartbeatAt, expiresAt: lease.expiresAt });
  }
  lease.status = 'stale';
  lease.releasedAt = request.now;
  return operationFailure(state, request, `lease ${lease.id} is no longer active`, 'stale-lease', {
    surface: SURFACE_LEASES,
    repository: lease.repository,
    targetId: lease.id,
    cap: 1,
  });
}

function handleLeaseRelease(state, manifest, request) {
  const actor = requireExecutor(manifest, request.actor, SURFACE_LEASES, request.repository, request.operation);
  const now = request.now;
  const targetId = normalize(request.payload.leaseId);
  if (!targetId) return operationFailure(state, request, 'lease release requires leaseId', 'invalid-lease-release', { surface: SURFACE_LEASES, repository: request.repository, cap: 1 });
  const lease = state.leases.find((entry) => entry.id === targetId);
  if (!lease) return operationFailure(state, request, `unknown lease: ${targetId}`, 'lease-not-found', { surface: SURFACE_LEASES, repository: request.repository, targetId, cap: 1 });
  if (lease.executor !== request.actor && !actor.governance) {
    return operationFailure(state, request, `lease ${lease.id} belongs to ${lease.executor}`, 'lease-release-unauthorized', {
      surface: SURFACE_LEASES,
      repository: lease.repository,
      targetId: lease.id,
      cap: 1,
    });
  }
  if (!lease.releasedAt) {
    lease.releasedAt = now;
    lease.status = 'released';
    lease.releasedBy = request.actor;
  }
  return operationSuccess(state, request, { leaseId: lease.id, status: lease.status });
}

function handleLeaseReconcile(state, manifest, request) {
  requireExecutor(manifest, request.actor, SURFACE_LEASES, request.repository, request.operation);
  const now = Date.parse(request.now);
  const stale = state.leases.filter((lease) => lease.status === 'active' && isExpired(lease.expiresAt, now));
  for (const lease of stale) {
    lease.status = 'stale';
    lease.releasedAt = lease.releasedAt || request.now;
    if (!state.repairs.some((entry) => entry.kind === 'stale-lease' && entry.targetId === lease.id && entry.status === 'open')) {
      makeRepair(state, {
        kind: 'stale-lease',
        actor: request.actor,
        surface: SURFACE_LEASES,
        reason: `lease ${lease.id} expired at ${lease.expiresAt}`,
        targetId: lease.id,
        repository: lease.repository,
      });
    }
  }
  return operationSuccess(state, request, { stale: stale.length, leases: stale.map((entry) => entry.id) });
}

function isActiveWorktree(entry) {
  return !entry.removedAt && entry.status !== 'orphaned';
}

function handleWorktreeCreate(state, manifest, request) {
  requireExecutor(manifest, request.actor, SURFACE_WORKTREES, request.repository, request.operation);
  const repository = normalize(request.payload.repository || request.repository);
  if (!repository) return operationFailure(state, request, 'worktree create requires repository', 'invalid-worktree-repo', { surface: SURFACE_WORKTREES, repository });

  const branch = normalize(request.payload.branch) || 'main';
  const requestedId = normalize(request.payload.worktreeId);
  const worktreeDir = path.join(request.runtimeRoot, 'worktrees', requestedId || shortSha(`${repository}:${branch}:${Date.now()}`));
  const marker = path.join(worktreeDir, '.kernel-worktree');

  const root = path.join(request.runtimeRoot, 'worktrees');
  fs.mkdirSync(root, { recursive: true });

  if (state.worktrees.some((entry) => isActiveWorktree(entry) && entry.repository === repository && entry.path === worktreeDir)) {
    return operationFailure(state, request, `a worktree for ${repository} already exists at ${worktreeDir}`, 'duplicate-worktree', {
      surface: SURFACE_WORKTREES,
      repository,
      targetId: worktreeDir,
      cap: 1,
    });
  }
  if (requestedId && state.worktrees.some((entry) => entry.id === requestedId && isActiveWorktree(entry))) {
    return operationFailure(state, request, `worktree id ${requestedId} already exists`, 'duplicate-worktree-id', {
      surface: SURFACE_WORKTREES,
      repository,
      targetId: requestedId,
      cap: 1,
    });
  }

  fs.mkdirSync(worktreeDir, { recursive: true });
  fs.writeFileSync(marker, `${JSON.stringify({ repository, branch, owner: request.actor, createdAt: request.now })}\n`);

  const created = {
    id: requestedId || worktreeId(state, repository),
    repository,
    branch,
    actor: request.actor,
    path: worktreeDir,
    createdAt: request.now,
    status: 'active',
  };
  state.worktrees.push(created);
  const evidence = appendEvidence(state, { kind: 'worktree-created', actor: request.actor, repository, payload: { worktreeId: created.id, path: worktreeDir } });
  appendEvidenceLog(request.runtimeRoot, evidence);
  return operationSuccess(state, request, { worktree: created, evidenceId: evidence.id });
}

function handleWorktreeRemove(state, manifest, request) {
  requireExecutor(manifest, request.actor, SURFACE_WORKTREES, request.repository, request.operation);
  const targetId = normalize(request.payload.worktreeId);
  if (!targetId) return operationFailure(state, request, 'worktree remove requires worktreeId', 'invalid-worktree-remove', {
    surface: SURFACE_WORKTREES,
    repository: request.repository,
    cap: 1,
  });
  const worktree = state.worktrees.find((entry) => entry.id === targetId);
  if (!worktree) return operationFailure(state, request, `unknown worktree: ${targetId}`, 'unknown-worktree', {
    surface: SURFACE_WORKTREES,
    repository: request.repository,
    targetId,
    cap: 1,
  });
  if (worktree.removedAt) return operationSuccess(state, request, { worktreeId: worktree.id, status: 'already-removed' });
  if (worktree.actor !== request.actor) {
    const executor = getExecutor(manifest, request.actor);
    if (!executor?.governance) {
      return operationFailure(state, request, `worktree ${targetId} is owned by ${worktree.actor}`, 'worktree-unauthorized', {
        surface: SURFACE_WORKTREES,
        repository: worktree.repository,
        targetId,
        cap: 1,
      });
    }
  }
  if (fs.existsSync(worktree.path)) {
    fs.rmSync(worktree.path, { recursive: true, force: true });
  }
  worktree.removedAt = request.now;
  worktree.status = 'removed';
  return operationSuccess(state, request, { worktreeId: worktree.id, status: worktree.status });
}

function handleWorktreeReconcile(state, manifest, request) {
  requireExecutor(manifest, request.actor, SURFACE_WORKTREES, request.repository, request.operation);
  const now = request.now;
  const touched = [];
  for (const worktree of state.worktrees) {
    if (!isActiveWorktree(worktree)) continue;
    if (!worktree.path || !fs.existsSync(worktree.path)) {
      worktree.status = 'orphaned';
      worktree.orphanedAt = now;
      touched.push(worktree.id);
      if (!state.repairs.some((entry) => entry.kind === 'orphaned-worktree' && entry.targetId === worktree.id && entry.status === 'open')) {
        makeRepair(state, {
          kind: 'orphaned-worktree',
          actor: request.actor,
          surface: SURFACE_WORKTREES,
          reason: `worktree ${worktree.id} is missing on disk`,
          targetId: worktree.id,
          repository: worktree.repository,
          cap: 1,
        });
      }
    }
  }
  return operationSuccess(state, request, { reconciled: touched.length, touched });
}

function handleRunClaim(state, manifest, request) {
  const actor = requireExecutor(manifest, request.actor, SURFACE_RUNS, request.payload.repository || request.repository, request.operation);
  const payload = request.payload;
  const workItemId = normalize(payload.workItemId);
  const repository = normalize(payload.repository || request.repository);
  if (!workItemId || !repository) return operationFailure(state, request, 'run claim requires workItemId and repository', 'invalid-run-claim', {
    surface: SURFACE_RUNS,
    repository,
    cap: 1,
  });

  if (acceptanceContractRequired(state, repository)) {
    const acceptance = validateAcceptanceContract(payload.acceptanceContract);
    if (!acceptance.valid) return operationFailure(
      state,
      request,
      `run claim is blocked: acceptance contract is incomplete (${acceptance.missing.join('; ')})`,
      'missing-acceptance-contract',
      { surface: SURFACE_RUNS, repository, targetId: workItemId, cap: 1, deadline: request.now },
    );
  }

  const leaseIdValue = normalize(payload.leaseId);
  if (leaseIdValue) {
    const lease = state.leases.find((entry) => entry.id === leaseIdValue);
    if (!lease) return operationFailure(state, request, `run claim uses unknown lease ${leaseIdValue}`, 'missing-run-lease', {
      surface: SURFACE_RUNS,
      repository,
      targetId: leaseIdValue,
      cap: 1,
    });
    if (lease.executor !== request.actor) {
      return operationFailure(state, request, `lease ${lease.id} belongs to ${lease.executor}`, 'lease-ownership-mismatch', {
        surface: SURFACE_LEASES,
        repository,
        targetId: lease.id,
        cap: 1,
      });
    }
    if (!isActiveLease(lease, Date.parse(request.now))) {
      return operationFailure(state, request, `lease ${lease.id} is stale`, 'stale-run-lease', {
        surface: SURFACE_LEASES,
        repository,
        targetId: lease.id,
        cap: 1,
      });
    }
  }

  if (state.runs.some((run) => run.workItemId === workItemId && ['running', 'recovering'].includes(run.status))) {
    return operationFailure(state, request, `work item ${workItemId} is already claimed`, 'overlapping-run', {
      surface: SURFACE_RUNS,
      repository,
      targetId: workItemId,
      cap: 1,
      deadline: request.now,
    });
  }

  const run = {
    id: runId(state, workItemId),
    workItemId,
    repository,
    executor: actor.id,
    leaseId: leaseIdValue || null,
    status: 'running',
    claimedAt: request.now,
    heartbeatAt: request.now,
    heartbeatTtlMs: parseIntPositive(payload.heartbeatTtlMs, DEFAULT_RUN_TTL_MS),
    createdAt: request.now,
    outcome: 'claimed',
    attempts: 0,
  };
  state.runs.push(run);
  const evidence = appendEvidence(state, { kind: 'run-claimed', actor: actor.id, repository, workItemId, runId: run.id, payload: { workItemId, acceptanceContract: acceptanceContractRequired(state, repository) ? { issueNumber: payload.acceptanceContract.issueNumber } : null } });
  appendEvidenceLog(request.runtimeRoot, evidence);
  return operationSuccess(state, request, { runId: run.id, status: run.status });
}

function handleRunHeartbeat(state, manifest, request) {
  const run = requireStateRun(state, request.payload.runId);
  requireExecutor(manifest, request.actor, SURFACE_RUNS, run.repository, request.operation);
  if (!['running', 'recovering'].includes(run.status)) {
    return operationFailure(state, request, `run ${run.id} is ${run.status}`, 'run-not-active', {
      surface: SURFACE_RUNS,
      repository: run.repository,
      targetId: run.id,
      cap: 1,
      deadline: request.now,
    });
  }
  run.heartbeatAt = request.now;
  return operationSuccess(state, request, { runId: run.id, heartbeatAt: run.heartbeatAt });
}

function handleRunComplete(state, manifest, request) {
  const run = requireStateRun(state, request.payload.runId);
  requireExecutor(manifest, request.actor, SURFACE_RUNS, run.repository, request.operation);
  const outcome = normalize(request.payload.outcome);
  if (!['passed', 'failed', 'aborted', 'stopped'].includes(outcome)) {
    run.status = 'unknown';
    run.outcome = outcome || null;
    run.completedAt = request.now;
    return operationFailure(state, request, `unknown run outcome ${outcome || '(missing)'}`, 'unknown-run-outcome', {
      surface: SURFACE_RUNS,
      repository: run.repository,
      targetId: run.id,
      cap: 1,
      deadline: request.now,
    });
  }
  run.status = outcome === 'passed' ? 'completed' : outcome;
  run.outcome = outcome;
  run.completedAt = request.now;
  const evidence = appendEvidence(state, {
    kind: 'run-complete',
    actor: request.actor,
    repository: run.repository,
    workItemId: run.workItemId,
    runId: run.id,
    payload: { outcome },
  });
  appendEvidenceLog(request.runtimeRoot, evidence);
  return operationSuccess(state, request, { runId: run.id, status: run.status, evidenceId: evidence.id });
}

function handleRunRecover(state, manifest, request) {
  const run = requireStateRun(state, request.payload.runId);
  requireExecutor(manifest, request.actor, SURFACE_RUNS, run.repository, request.operation);
  if (!isRunStale(run, Date.parse(request.now))) {
    return operationSuccess(state, request, { runId: run.id, status: run.status, stale: false });
  }
  if (run.status === 'recovering') {
    return operationSuccess(state, request, { runId: run.id, status: run.status, stale: true });
  }
  run.status = 'recovering';
  if (!state.repairs.some((entry) => entry.kind === 'stale-run' && entry.targetId === run.id && entry.status === 'open')) {
    makeRepair(state, {
      kind: 'stale-run',
      actor: request.actor,
      surface: SURFACE_RUNS,
      reason: `run ${run.id} missed heartbeat`,
      targetId: run.id,
      repository: run.repository,
    });
  }
  return operationSuccess(state, request, { runId: run.id, status: run.status, stale: true });
}

function handlePrObserve(state, manifest, request) {
  requireExecutor(manifest, request.actor, SURFACE_PR_LIFECYCLE, request.payload.repository || request.repository, request.operation);
  const payload = request.payload;
  const workItemId = normalize(payload.workItemId);
  const repository = normalize(payload.repository || request.repository);
  const event = normalize(payload.event);
  if (!workItemId || !repository || !event) {
    return operationFailure(state, request, 'pr observe requires workItemId, repository, and event', 'invalid-pr-observation', {
      surface: SURFACE_PR_LIFECYCLE,
      repository,
      cap: 1,
    });
  }

  const item = findPrItem(state, workItemId) || buildPrItem({ workItemId, repository, actor: request.actor, now: request.now });
  if (!state.prItems.includes(item)) {
    item.createdAt = request.now;
    state.prItems.push(item);
    const evidence = appendEvidence(state, { kind: 'pr-item-created', actor: request.actor, repository, workItemId, payload: { source: 'pr-observe' } });
    appendEvidenceLog(request.runtimeRoot, evidence);
  }

  try {
    if (event === 'opened') {
      item.pr = payload.pr ? Number(payload.pr) : item.pr;
      item.head = normalize(payload.head) || item.head;
      prAppendEvidence(item, {
        type: 'executor_started',
        source: `PR #${item.pr || 'unknown'} opened`,
        observedAt: request.now,
        actor: request.actor,
      });
      setControlStatus(item, 'running', request.now);
      return operationSuccess(state, request, { workItemId: item.id, status: item.status });
    }

    if (event === 'ready_for_review') {
      item.pr = payload.pr ? Number(payload.pr) : item.pr;
      prAppendEvidence(item, {
        type: 'executor_result',
        source: `PR #${item.pr || 'unknown'} ready for review`,
        observedAt: request.now,
      });
      setControlStatus(item, 'reported_done', request.now);
      return operationSuccess(state, request, { workItemId: item.id, status: item.status });
    }

    if (event === 'checks_passed') {
      const head = normalize(payload.head);
      if (!EVIDENCE_PREFIX.test(head)) {
        return operationFailure(state, request, 'checks_passed requires a commit SHA', 'invalid-pr-check-commit', {
          surface: SURFACE_PR_LIFECYCLE,
          repository,
          targetId: item.id,
          cap: 1,
        });
      }
      item.head = head;
      prAppendEvidence(item, {
        type: 'verification_passed',
        source: `PR #${item.pr || item.id} verification passed`,
        observedAt: request.now,
        commit: head,
      });
      setControlStatus(item, 'verified', request.now);
      return operationSuccess(state, request, { workItemId: item.id, status: item.status, head: item.head });
    }

    if (event === 'checks_failed') {
      const reason = normalize(payload.reason) || 'verification failed';
      prAppendEvidence(item, {
        type: 'verification_failed',
        source: `PR #${item.pr || item.id} verification failed`,
        observedAt: request.now,
        reason,
      });
      setControlStatus(item, 'blocked', request.now);
      item.blockedReason = reason;
      return operationSuccess(state, request, { workItemId: item.id, status: item.status, reason });
    }

    if (event === 'head_changed') {
      const head = normalize(payload.head);
      if (item.head && head && item.head !== head) {
        makeRepair(state, {
          kind: 'stale-pr-evidence',
          actor: request.actor,
          surface: SURFACE_PR_LIFECYCLE,
          reason: `PR ${item.pr || item.id} head moved ${item.head} -> ${head}`,
          targetId: item.id,
          repository,
          cap: 1,
          deadline: request.now,
        });
      }
      item.head = head || item.head;
      item.blockedReason = normalize(payload.reason) || item.blockedReason;
      return operationSuccess(state, request, { workItemId: item.id, status: item.status, head: item.head || null });
    }

    if (event === 'smoke_passed') {
      const head = normalize(payload.head);
      if (!EVIDENCE_PREFIX.test(head)) {
        return operationFailure(state, request, 'smoke_passed requires a commit SHA', 'invalid-pr-smoke-commit', {
          surface: SURFACE_PR_LIFECYCLE,
          repository,
          targetId: item.id,
          cap: 1,
        });
      }
      item.head = head;
      item.mergeCommit = normalize(payload.mergeCommit);
      prAppendEvidence(item, {
        type: 'release_smoke_passed',
        source: `smoke checks passed for PR #${item.pr || item.id}`,
        observedAt: request.now,
        commit: head,
        mergeCommit: item.mergeCommit,
      });
      setControlStatus(item, 'released', request.now);
      return operationSuccess(state, request, { workItemId: item.id, status: item.status, head: item.head });
    }

    return operationFailure(state, request, `unsupported PR event: ${event}`, 'unsupported-pr-event', {
      surface: SURFACE_PR_LIFECYCLE,
      repository,
      targetId: workItemId,
      cap: 1,
    });
  } catch (error) {
    return operationFailure(state, request, error.message, 'stale-pr-evidence', {
      surface: SURFACE_PR_LIFECYCLE,
      repository,
      targetId: item.id,
      cap: 1,
      deadline: request.now,
    });
  }
}

function handlePrAdvance(state, manifest, request) {
  requireExecutor(manifest, request.actor, SURFACE_PR_LIFECYCLE, request.payload.repository || request.repository, request.operation);
  const payload = request.payload;
  const workItemId = normalize(payload.workItemId);
  const to = normalize(payload.to);
  if (!workItemId || !to) return operationFailure(state, request, 'pr-advance requires workItemId and to', 'invalid-pr-advance', {
    surface: SURFACE_PR_LIFECYCLE,
    repository: request.repository,
    cap: 1,
  });
  const item = findPrItem(state, workItemId);
  if (!item) return operationFailure(state, request, `unknown work item: ${workItemId}`, 'missing-pr-item', {
    surface: SURFACE_PR_LIFECYCLE,
    repository: request.repository,
    targetId: workItemId,
    cap: 1,
  });

  try {
    setControlStatus(item, to, request.now);
    return operationSuccess(state, request, { workItemId: item.id, status: item.status });
  } catch (error) {
    return operationFailure(state, request, error.message, 'stale-pr-evidence', {
      surface: SURFACE_PR_LIFECYCLE,
      repository: item.repository,
      targetId: item.id,
      cap: 1,
      deadline: request.now,
    });
  }
}

function isKnownPredicate(payload) {
  return ['onUnknown', 'onFailure', 'always'].includes(payload.predicate);
}

function evaluatePredicate(payload, run) {
  if (payload.predicate === 'onUnknown') return run.status === 'unknown';
  if (payload.predicate === 'onFailure') return ['failed', 'stopped', 'aborted'].includes(run.status);
  if (payload.predicate === 'always') return true;
  return false;
}

function parseRetryDeadline(requested, defaultMs = DEFAULT_RETRY_DEADLINE_MS) {
  if (!requested) return new Date(Date.now() + defaultMs).toISOString();
  if (isFuture(requested)) return requested;
  const minutes = parseIntPositive(requested, NaN);
  if (!Number.isNaN(minutes)) return new Date(Date.now() + minutes * 60 * 1000).toISOString();
  throw new Error(`invalid retry.deadline: ${requested}`);
}

function handleRetryStart(state, manifest, request) {
  const payload = request.payload;
  const run = requireStateRun(state, payload.runId);
  requireExecutor(manifest, request.actor, SURFACE_RETRIES, run.repository, request.operation);

  const predicate = normalize(payload.predicate);
  if (!isKnownPredicate({ predicate })) return operationFailure(state, request, 'retry-start requires predicate onUnknown|onFailure|always', 'invalid-retry-predicate', {
    surface: SURFACE_RETRIES,
    repository: run.repository,
    targetId: run.id,
    cap: 1,
  });

  if (!['running', 'recovering', 'unknown', 'failed'].includes(run.status)) {
    return operationFailure(state, request, `run ${run.id} in terminal state ${run.status}`, 'retry-not-applicable', {
      surface: SURFACE_RETRIES,
      repository: run.repository,
      targetId: run.id,
      cap: 1,
    });
  }

  if (state.retries.some((entry) => entry.targetId === run.id && entry.status === 'active')) {
    return operationFailure(state, request, `run ${run.id} already has an active retry`, 'retry-already-active', {
      surface: SURFACE_RETRIES,
      repository: run.repository,
      targetId: run.id,
      cap: 1,
    });
  }

  let deadline;
  try {
    deadline = parseRetryDeadline(payload.deadline, parseIntPositive(payload.deadlineMs, DEFAULT_RETRY_DEADLINE_MS));
  } catch (error) {
    return operationFailure(state, request, error.message, 'invalid-retry-deadline', {
      surface: SURFACE_RETRIES,
      repository: run.repository,
      targetId: run.id,
      cap: 1,
    });
  }

  const cap = parseIntPositive(payload.cap, MAX_RETRY_ATTEMPTS_DEFAULT);
  const retry = {
    id: retryId(state, run.id),
    targetType: 'run',
    targetId: run.id,
    actor: request.actor,
    repository: run.repository,
    predicate,
    cap,
    attempts: 0,
    createdAt: request.now,
    deadline,
    status: 'active',
    baseline: normalize(payload.baseline || 'running'),
  };
  state.retries.push(retry);
  return operationSuccess(state, request, { retry: { ...retry } });
}

function handleRetryAttempt(state, manifest, request) {
  const payload = request.payload;
  const retryValue = normalize(payload.retryId);
  const retry = state.retries.find((entry) => entry.id === retryValue);
  if (!retry) return operationFailure(state, request, `unknown retry: ${retryValue}`, 'missing-retry', {
    surface: SURFACE_RETRIES,
    targetId: retryValue,
    cap: 1,
  });

  const run = requireStateRun(state, retry.targetId);
  requireExecutor(manifest, request.actor, SURFACE_RETRIES, run.repository, request.operation);

  if (retry.status !== 'active') return operationSuccess(state, request, { status: retry.status, attempts: retry.attempts, retry: retry.id });
  if (isExpired(retry.deadline, Date.parse(request.now))) {
    retry.status = 'exhausted';
    makeRepair(state, {
      kind: 'retry-deadline-exhausted',
      actor: request.actor,
      surface: SURFACE_RETRIES,
      reason: `retry ${retry.id} hit deadline ${retry.deadline}`,
      targetId: retry.id,
      repository: run.repository,
      cap: retry.cap,
      deadline: request.now,
    });
    return operationSuccess(state, request, { status: retry.status, attempts: retry.attempts, retry: retry.id });
  }

  const predicate = normalize(payload.predicate || retry.predicate);
  if (!isKnownPredicate({ predicate })) {
    return operationFailure(state, request, 'retry-attempt requires predicate onUnknown|onFailure|always', 'invalid-retry-predicate', {
      surface: SURFACE_RETRIES,
      repository: run.repository,
      targetId: retry.id,
      cap: 1,
    });
  }

  if (!evaluatePredicate({ predicate }, run)) {
    retry.status = 'terminal';
    makeRepair(state, {
      kind: 'retry-terminated',
      actor: request.actor,
      surface: SURFACE_RETRIES,
      reason: `retry ${retry.id} predicate no longer matches run ${run.id}`,
      targetId: retry.id,
      repository: run.repository,
      cap: 1,
      deadline: request.now,
    });
    return operationSuccess(state, request, { status: retry.status, attempts: retry.attempts, retry: retry.id });
  }

  retry.attempts += 1;
  if (retry.attempts > retry.cap) {
    retry.status = 'exhausted';
    makeRepair(state, {
      kind: 'retry-exhausted',
      actor: request.actor,
      surface: SURFACE_RETRIES,
      reason: `retry ${retry.id} exceeded cap ${retry.cap}`,
      targetId: retry.id,
      repository: run.repository,
      cap: retry.cap,
      deadline: request.now,
    });
    run.status = 'failed';
    return operationSuccess(state, request, { status: retry.status, attempts: retry.attempts, retry: retry.id });
  }

  run.status = retry.baseline || 'running';
  const next = new Date(Date.parse(request.now) + 15 * 60 * 1000).toISOString();
  retry.nextAttemptAt = next;
  return operationSuccess(state, request, { status: retry.status, attempts: retry.attempts, retry: retry.id, nextAttemptAt: next });
}

function handleRetryReconcile(state, manifest, request) {
  requireExecutor(manifest, request.actor, SURFACE_RETRIES, request.repository, request.operation);
  const now = Date.parse(request.now);
  const updated = [];
  for (const retry of state.retries.filter((entry) => entry.status === 'active')) {
    if (retry.deadline && isExpired(retry.deadline, now)) {
      retry.status = 'exhausted';
      updated.push(retry.id);
      makeRepair(state, {
        kind: 'retry-deadline-exhausted',
        actor: request.actor,
        surface: SURFACE_RETRIES,
        reason: `retry ${retry.id} deadline passed`,
        targetId: retry.id,
        repository: retry.repository,
        cap: retry.cap,
        deadline: request.now,
      });
      continue;
    }
    if (retry.attempts >= retry.cap) {
      retry.status = 'exhausted';
      updated.push(retry.id);
      makeRepair(state, {
        kind: 'retry-cap-exhausted',
        actor: request.actor,
        surface: SURFACE_RETRIES,
        reason: `retry ${retry.id} reached cap ${retry.cap}`,
        targetId: retry.id,
        repository: retry.repository,
        cap: retry.cap,
        deadline: request.now,
      });
    }
  }
  return operationSuccess(state, request, { reconciled: updated });
}

function handleKernelRecover(state, manifest, request) {
  requireExecutor(manifest, request.actor, SURFACE_REPAIRS, request.repository, request.operation);
  const now = Date.parse(request.now);
  let staleRuns = 0;
  let staleLeases = 0;

  for (const run of state.runs) {
    if ((run.status === 'running' || run.status === 'recovering') && isRunStale(run, now)) {
      run.status = 'recovering';
      run.recoveredAt = request.now;
      staleRuns += 1;
      if (!state.repairs.some((entry) => entry.kind === 'stale-run' && entry.targetId === run.id && entry.status === 'open')) {
        makeRepair(state, {
          kind: 'stale-run',
          actor: request.actor,
          surface: SURFACE_RUNS,
          reason: `run ${run.id} missed heartbeat`,
          targetId: run.id,
          repository: run.repository,
          cap: 1,
        });
      }
    }
  }

  for (const lease of state.leases.filter((entry) => entry.status === 'active')) {
    if (isExpired(lease.expiresAt, now)) {
      lease.status = 'stale';
      lease.releasedAt = request.now;
      staleLeases += 1;
      if (!state.repairs.some((entry) => entry.kind === 'stale-lease' && entry.targetId === lease.id && entry.status === 'open')) {
        makeRepair(state, {
          kind: 'stale-lease',
          actor: request.actor,
          surface: SURFACE_LEASES,
          reason: `Lease ${lease.id} expired at ${lease.expiresAt}`,
          targetId: lease.id,
          repository: lease.repository,
          cap: 1,
        });
      }
    }
  }

  for (const worktree of state.worktrees.filter((entry) => isActiveWorktree(entry) && !entry.removedAt)) {
    if (!fs.existsSync(worktree.path)) {
      worktree.status = 'orphaned';
      worktree.orphanedAt = request.now;
      if (!state.repairs.some((entry) => entry.kind === 'orphaned-worktree' && entry.targetId === worktree.id && entry.status === 'open')) {
        makeRepair(state, {
          kind: 'orphaned-worktree',
          actor: request.actor,
          surface: SURFACE_WORKTREES,
          reason: `worktree ${worktree.id} is missing on disk`,
          targetId: worktree.id,
          repository: worktree.repository,
          cap: 1,
        });
      }
    }
  }

  return operationSuccess(state, request, { staleRuns, staleLeases });
}

function handleKernelPolicyUpdate(state, manifest, request) {
  requireExecutor(manifest, request.actor, SURFACE_POLICY, request.payload.repository || request.repository, request.operation);
  const key = normalize(request.payload.key);
  if (!key) return operationFailure(state, request, 'policy update requires key', 'invalid-policy-update', { surface: SURFACE_POLICY, repository: request.payload.repository || request.repository, cap: 1 });
  state.policy[key] = request.payload.value;
  const evidence = appendEvidence(state, {
    kind: 'policy-updated',
    actor: request.actor,
    repository: request.repository || null,
    payload: { key, value: request.payload.value },
  });
  appendEvidenceLog(request.runtimeRoot, evidence);
  return operationSuccess(state, request, { key, value: request.payload.value });
}

const HANDLERS = {
  'lease-acquire': handleLeaseAcquire,
  'lease-release': handleLeaseRelease,
  'lease-reconcile': handleLeaseReconcile,
  'lease-heartbeat': handleLeaseHeartbeat,
  'worktree-create': handleWorktreeCreate,
  'worktree-remove': handleWorktreeRemove,
  'worktree-reconcile': handleWorktreeReconcile,
  'run-claim': handleRunClaim,
  'run-heartbeat': handleRunHeartbeat,
  'run-complete': handleRunComplete,
  'run-recover': handleRunRecover,
  'pr-observe': handlePrObserve,
  'pr-advance': handlePrAdvance,
  'retry-start': handleRetryStart,
  'retry-attempt': handleRetryAttempt,
  'retry-reconcile': handleRetryReconcile,
  'kernel-recover': handleKernelRecover,
  'kernel-policy-update': handleKernelPolicyUpdate,
};

function withKernelLock(root, fn) {
  const { lockPath } = runtimePaths(resolveKernelRoot({ runtimeRoot: root }));
  let lockHandle;
  try {
    lockHandle = fs.openSync(lockPath, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const held = fs.statSync(lockPath);
    if (Date.now() - held.mtimeMs < KERNEL_LOCK_STALE_MS) {
      throw new Error(`another kernel process holds ${lockPath} since ${held.mtime.toISOString()}`);
    }
    fs.rmSync(lockPath, { force: true });
    lockHandle = fs.openSync(lockPath, 'wx');
  }
  try {
    fs.writeSync(lockHandle, `${process.pid}\n`);
    return fn();
  } finally {
    fs.closeSync(lockHandle);
    fs.rmSync(lockPath, { force: true });
  }
}

function validateBoundary(manifest) {
  if (!Array.isArray(manifest.executors)) {
    throw new Error('Kernel manifest must expose executors as an array.');
  }
  validateManifest(manifest);
}

function finalizeKernelResult(state, request, result) {
  const operationResult = result || { ok: false, operation: request.operation, reason: 'kernel handler returned no result' };
  const operationRecord = {
    id: operationId(state),
    operation: request.operation,
    ...request,
    at: request.now,
    status: operationResult.ok ? 'applied' : 'rejected',
    result: operationResult,
    requestId: request.idempotencyKey,
    requestFingerprint: request.fingerprint,
  };
  state.operations.push(operationRecord);
  writeKernelState(request.runtimeRoot, state);
  appendEvidenceLog(request.runtimeRoot, {
    kind: 'kernel-operation',
    operation: request.operation,
    operationId: operationRecord.id,
    actor: request.actor,
    at: request.now,
  });
  return {
    ...operationResult,
    operation: request.operation,
    operationId: operationRecord.id,
    actor: request.actor,
  };
}

export function executeKernelOperation(rawRequest) {
  const request = canonicalRequest(rawRequest);
  return withKernelLock(request.runtimeRoot, () => {
    const state = readKernelState(request.runtimeRoot);
    const manifest = readBoundaryManifest(request.runtimeRoot);
    validateBoundary(manifest);

    const handler = HANDLERS[request.operation];
    if (!handler) {
      const result = operationFailure(state, request, `unsupported operation ${request.operation}`, 'unsupported-operation', {
        surface: SURFACE_KERNEL,
        targetId: request.operation,
        cap: 1,
        deadline: request.now,
      });
      return finalizeKernelResult(state, request, result);
    }

    const cached = cachedOrRun(state, request);
    if (cached) return cached;

    try {
      return finalizeKernelResult(state, request, handler(state, manifest, request));
    } catch (error) {
      if (error instanceof KernelError) {
        return finalizeKernelResult(state, request, operationFailure(state, request, error.message, error.kind || 'kernel-handler-error', error.repair || {}));
      }
      const result = operationFailure(state, request, error.message, 'kernel-handler-error', {
        surface: SURFACE_REPAIRS,
        repository: request.repository,
        targetId: request.operation,
        cap: 1,
      });
      return finalizeKernelResult(state, request, result);
    }
  });
}

function parseRequestFromArgv(argv) {
  let runtimeRoot = null;
  let requestText = null;
  const args = [...argv];
  while (args.length) {
    const current = args.shift();
    if (current === '--runtime-root') {
      runtimeRoot = args.shift();
      continue;
    }
    if (current === '--request') {
      requestText = args.shift();
      continue;
    }
    if (current && current.startsWith('{') && !requestText) {
      requestText = current;
      continue;
    }
    if (current.endsWith('.json') && !requestText) {
      requestText = fs.readFileSync(current, 'utf8');
    }
  }
  if (!requestText) throw new Error('Usage: coding-kernel.mjs --runtime-root PATH --request \'{json}\'');
  const request = JSON.parse(requestText);
  if (!request.runtimeRoot) request.runtimeRoot = runtimeRoot;
  return request;
}

// macOS exposes /tmp through /private/tmp.  Compare canonical filesystem paths
// so the process/JSON boundary works from either spelling rather than silently
// exiting without a receipt.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url))) {
  try {
    const request = parseRequestFromArgv(process.argv.slice(2));
    const result = executeKernelOperation(request);
    if (!result.ok) {
      console.log(JSON.stringify({ interface: KERNEL_INTERFACE_VERSION, ...result }, null, 2));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ interface: KERNEL_INTERFACE_VERSION, ...result }, null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
