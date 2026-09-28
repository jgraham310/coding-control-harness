import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const TEMS_REPOSITORY = 'jgraham310/tems';
const sourceCharter = resolve(homedir(), '.openclaw/repos/henry-operating-system/agents/tems-cto/CHARTER.json');
const deployedCharter = resolve(homedir(), '.openclaw/workspace-tems-cto/CHARTER.json');

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

export function assertTemsProtocolEvidence(repository, pr, head, evidence, now = Date.now()) {
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
}

export function assertCurrentTemsMergeAuthority(repository, charterPath = sourceCharter, deployedPath = deployedCharter, pr, head, evidencePath) {
  if (repository !== TEMS_REPOSITORY) return;
  assertTemsMergeAuthority(repository, JSON.parse(readFileSync(charterPath, 'utf8')));
  assertTemsMergeAuthority(repository, JSON.parse(readFileSync(deployedPath, 'utf8')));
  if (!evidencePath) throw new Error('current exact-head TEMS merge protocol evidence is missing or stale');
  assertTemsProtocolEvidence(repository, pr, head, JSON.parse(readFileSync(evidencePath, 'utf8')));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { assertCurrentTemsMergeAuthority(process.argv[2], sourceCharter, deployedCharter, process.argv[3], process.argv[4], process.argv[5]); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
