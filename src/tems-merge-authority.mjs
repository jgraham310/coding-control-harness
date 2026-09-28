import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const TEMS_REPOSITORY = 'jgraham310/tems';
const sourceCharter = resolve(homedir(), '.openclaw/repos/henry-operating-system/agents/tems-cto/CHARTER.json');
const deployedCharter = resolve(homedir(), '.openclaw/workspace-tems-cto/CHARTER.json');
const kernelStatePath = resolve(homedir(), '.openclaw/state/coding-control-kernel/state.json');

export function assertTemsMergeAuthority(repository, charter) {
  if (repository !== TEMS_REPOSITORY) return;
  if (charter?.agentId !== 'tems-cto' || charter.mode !== 'routine' ||
      !charter.repositories?.includes(repository) ||
      !charter.autonomousOperations?.includes('merge_green_pr') ||
      !charter.protocolRequired?.includes('merge_green_pr') ||
      charter.productionAuthority !== false ||
      charter.boundedAuthority?.merge !== true ||
      charter.boundedAuthority?.production !== false ||
      charter.boundedAuthority?.prohibitedOperations?.includes('merge_green_pr')) {
    throw new Error('TEMS autonomous merge is prohibited by bounded authority');
  }
}

export function assertTemsProtocolEvidence(repository, pr, head, evidence, kernelState, now = Date.now()) {
  if (repository !== TEMS_REPOSITORY) return;
  const observed = Date.parse(evidence?.observedAt);
  const expires = Date.parse(evidence?.expiresAt);
  if (!Number.isInteger(Number(pr)) || Number(pr) < 1 ||
      !/^[a-f0-9]{40}$/.test(head ?? '') ||
      evidence?.kind !== 'kernel_pr_verification' ||
      evidence?.status !== 'passed' ||
      evidence?.repository !== repository ||
      Number(evidence?.pr) !== Number(pr) ||
      evidence?.head_sha !== head ||
      evidence?.artifact !== `git:${head}` ||
      evidence?.observer !== 'coding-kernel' ||
      !Number.isFinite(observed) || !Number.isFinite(expires) ||
      observed > now || expires <= now || expires - observed > 30 * 60 * 1000) {
    throw new Error('current exact-head TEMS merge protocol evidence is missing or stale');
  }
  const operation = kernelState?.operations?.find((entry) => entry.id === evidence.kernel_operation_id);
  const item = kernelState?.prItems?.find((entry) => entry.id === evidence.work_item_id);
  const remote = operation?.result?.remoteVerification;
  const verification = item?.evidence?.find((entry) => entry.type === 'verification_passed' &&
    entry.commit === head && entry.observedAt === evidence.observedAt);
  if (kernelState?.schema !== 'coding_control_kernel_state/v1' ||
      !operation || operation.operation !== 'pr-observe' || operation.status !== 'applied' ||
      operation.repository !== repository || operation.payload?.repository !== repository ||
      operation.payload?.workItemId !== evidence.work_item_id ||
      operation.payload?.event !== 'checks_passed' || operation.payload?.head !== head ||
      operation.now !== evidence.observedAt || operation.result?.ok !== true ||
      operation.result?.status !== 'verified' || operation.result?.head !== head ||
      operation.result?.workItemId !== evidence.work_item_id ||
      remote?.source !== 'github-api' || remote.repository !== repository ||
      remote.pr !== Number(pr) || remote.head_sha !== head ||
      !Number.isInteger(remote.checks_count) || remote.checks_count < 1 ||
      remote.verified_at !== evidence.observedAt ||
      !Number.isFinite(Date.parse(remote.host_status_created_at)) ||
      !item || item.repository !== repository || Number(item.pr) !== Number(pr) ||
      item.head !== head || item.status !== 'verified' || !verification) {
    throw new Error('TEMS merge protocol evidence has no matching kernel-issued verification');
  }
}

export function assertCurrentTemsMergeAuthority(repository, charterPath = sourceCharter, deployedPath = deployedCharter, pr, head, evidencePath, statePath = kernelStatePath) {
  if (repository !== TEMS_REPOSITORY) return;
  assertTemsMergeAuthority(repository, JSON.parse(readFileSync(charterPath, 'utf8')));
  assertTemsMergeAuthority(repository, JSON.parse(readFileSync(deployedPath, 'utf8')));
  if (!evidencePath) throw new Error('current exact-head TEMS merge protocol evidence is missing or stale');
  assertTemsProtocolEvidence(repository, pr, head, JSON.parse(readFileSync(evidencePath, 'utf8')),
    JSON.parse(readFileSync(statePath, 'utf8')));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { assertCurrentTemsMergeAuthority(process.argv[2], sourceCharter, deployedCharter, process.argv[3], process.argv[4], process.argv[5]); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
