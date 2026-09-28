#!/usr/bin/env node
/** Fail-closed exact-head CivicLine merge transport. No production operation. */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const REPO = 'jgraham310/local-government';
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const defaultSource = '/Users/jasongraham/.openclaw/repos/henry-operating-system/agents/civicline-cto/CHARTER.json';
const defaultLive = '/Users/jasongraham/.openclaw/workspace-civicline-cto/CHARTER.json';
const defaultState = '/Users/jasongraham/.openclaw/workspace-cos/ops/execution-harness/work-state.json';
const read = file => JSON.parse(fs.readFileSync(file,'utf8'));
function command(args, runner=spawnSync) {
  const result=runner('gh',args,{encoding:'utf8',timeout:30000});
  if (result.status !== 0) throw new Error(`GitHub read or merge failed: ${(result.stderr || result.stdout || '').trim().slice(0,500)}`);
  return (result.stdout || '').trim();
}
export function charterValid(c) {
  return c?.agentId==='civicline-cto' && c.mode==='routine' && c.repositories?.includes(REPO) &&
    c.autonomousOperations?.includes('merge_green_pr') && c.protocolRequired?.includes('merge_green_pr') &&
    c.boundedAuthority?.merge===true && c.boundedAuthority?.production===false &&
    c.boundedAuthority?.customerData===false && !c.boundedAuthority?.prohibitedOperations?.includes('merge_green_pr');
}
export function evaluateMerge({source,live,state,pr,checks,proof,p2Issue,reviews,threads,browserReceipt,browserDigest,deploymentReceipt,deploymentDigest},now=Date.now()) {
  const record=state?.records?.['cto:civicline'];
  if (!charterValid(source) || !charterValid(live) || record?.status!=='active' ||
      !record.authorityBoundary?.allowedActions?.includes('merge_green_pr') ||
      !record.evidenceRefs?.includes('civicline-merge-staging-grant-20260928') ||
      !state.evidence?.['civicline-merge-staging-grant-20260928']) return {allowed:false,reason:'authority_or_workstate'};
  const head=pr?.head?.sha, base=pr?.base?.sha;
  if (pr?.state!=='open' || pr.draft!==false || pr.mergeable!==true || !SHA.test(head??'') || !SHA.test(base??'') ||
      proof?.repository!==REPO || proof.pr!==pr.number || proof.head!==head || proof.base!==base) return {allowed:false,reason:'stale_or_invalid_head'};
  if (!Array.isArray(checks) || checks.length===0 || checks.some(c=>c.bucket!=='pass')) return {allowed:false,reason:'exact_head_ci'};
  const review=proof.review, acceptance=proof.acceptance;
  if (review?.head!==head || review.independent!==true || !review.url?.startsWith('https://github.com/') ||
      !Array.isArray(review.findings) || !Number.isFinite(Date.parse(review.observedAt)) ||
      Date.parse(review.observedAt)>now || now-Date.parse(review.observedAt)>30*60*1000) return {allowed:false,reason:'exact_head_review'};
  const reviewerReviews=Array.isArray(reviews) ? reviews.filter(r=>r.user?.login===review.reviewer)
    .sort((a,b)=>Date.parse(b.submitted_at)-Date.parse(a.submitted_at)) : [];
  if (!Array.isArray(reviews) || reviews.length>=100 || !reviewerReviews.some((r,index)=>
    index===0 &&
    r.state==='APPROVED' && r.commit_id===head && r.html_url===review.url &&
    r.user?.login && r.user.login===review.reviewer && r.user.login!==pr.user?.login &&
    Number.isFinite(Date.parse(r.submitted_at)) && Date.parse(r.submitted_at)<=now &&
    now-Date.parse(r.submitted_at)<=30*60*1000)) return {allowed:false,reason:'exact_head_review'};
  if (!threads || !Array.isArray(threads.nodes) || threads.pageInfo?.hasNextPage!==false ||
      threads.nodes.some(t=>t.isResolved!==true)) return {allowed:false,reason:'unresolved_review_threads'};
  if (review.findings.some(f=>!['P0','P1','P2','P3'].includes(f.severity) || ['P0','P1'].includes(f.severity))) return {allowed:false,reason:'blocking_review_finding'};
  const browserRef=acceptance?.browserEvidenceRef;
  const browserEvidence=browserRef && record.evidenceRefs?.includes(browserRef) && state.evidence?.[browserRef];
  const deploymentRef=acceptance?.deploymentEvidenceRef;
  const deploymentEvidence=deploymentRef && deploymentRef===record.currentDeploymentEvidenceRef &&
    record.evidenceRefs?.includes(deploymentRef) && state.evidence?.[deploymentRef];
  if (acceptance?.issueDerived!==true || acceptance?.negativeControls!==true || acceptance?.deterministicTests!==true ||
      acceptance?.head!==head || acceptance.browserRequired!==true ||
      acceptance.browserTerminalOutcome!=='PASS' || acceptance.browserHead!==head ||
      browserEvidence?.status!=='verified' || browserEvidence.artifact!==`sha256:${browserDigest}` ||
      deploymentEvidence?.status!=='verified' || deploymentEvidence.artifact!==`sha256:${deploymentDigest}` ||
      deploymentReceipt?.head!==head || !DIGEST.test(deploymentReceipt?.imageDigest??'') ||
      typeof deploymentReceipt?.servingRevision!=='string' || !deploymentReceipt.servingRevision.trim() ||
      browserReceipt?.head!==head || browserReceipt?.terminalOutcome!=='PASS' ||
      browserReceipt.imageDigest!==deploymentReceipt.imageDigest ||
      browserReceipt.servingRevision!==deploymentReceipt.servingRevision) return {allowed:false,reason:'acceptance_proof'};
  const p2=review.findings.filter(f=>f.severity==='P2');
  if (p2.some(f=>f.blocksAcceptance || f.securityOrTenantRisk || f.dataLossRisk || f.rollbackRisk)) return {allowed:false,reason:'launch_critical_p2'};
  if (p2.length && (proof.p2Disposition?.head!==head ||
      !Number.isInteger(proof.p2Disposition.issue) || p2Issue?.number!==proof.p2Disposition.issue ||
      p2Issue.state!=='open' || p2.some(f=>!proof.p2Disposition.findingIds?.includes(f.id) || !p2Issue.body?.includes(f.id)) ||
      !p2Issue.body?.includes(head) || !p2Issue.body?.includes(review.url) || !p2Issue.body?.includes('Acceptance test:') ||
      !p2Issue.body?.includes('Owner:') || !p2Issue.body?.includes('Blocking-risk exclusion:'))) return {allowed:false,reason:'p2_follow_up_missing'};
  return {allowed:true,reason:'exact_head_p2_policy_satisfied',head};
}
export function checkCurrent(prNumber,proofFile,{sourceFile=defaultSource,liveFile=defaultLive,stateFile=defaultState,runner=spawnSync,now=Date.now()}={}) {
  if (!Number.isInteger(prNumber)||prNumber<1) throw new Error('invalid PR number');
  const source=read(sourceFile),live=read(liveFile),state=read(stateFile),proof=read(proofFile);
  if (!charterValid(source)||!charterValid(live)||
      !state.records?.['cto:civicline']?.authorityBoundary?.allowedActions?.includes('merge_green_pr')||
      !state.records['cto:civicline'].evidenceRefs?.includes('civicline-merge-staging-grant-20260928')) return {allowed:false,reason:'authority_or_workstate'};
  const pr=JSON.parse(command(['api',`repos/${REPO}/pulls/${prNumber}`],runner));
  const checks=JSON.parse(command(['pr','checks',String(prNumber),'-R',REPO,'--json','name,bucket'],runner));
  const reviews=JSON.parse(command(['api',`repos/${REPO}/pulls/${prNumber}/reviews?per_page=100`],runner));
  const query='query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}pageInfo{hasNextPage}}}}}';
  const threadResponse=JSON.parse(command(['api','graphql','-f',`query=${query}`,'-F','owner=jgraham310','-F','repo=local-government','-F',`number=${prNumber}`],runner));
  const threads=threadResponse?.errors ? null : threadResponse?.data?.repository?.pullRequest?.reviewThreads;
  const browserBytes=fs.readFileSync(proof?.acceptance?.browserReceiptPath ?? '');
  const browserDigest=createHash('sha256').update(browserBytes).digest('hex');
  const browserReceipt=JSON.parse(browserBytes);
  const deploymentBytes=fs.readFileSync(proof?.acceptance?.deploymentReceiptPath ?? '');
  const deploymentDigest=createHash('sha256').update(deploymentBytes).digest('hex');
  const deploymentReceipt=JSON.parse(deploymentBytes);
  const p2Issue=proof?.p2Disposition?.issue ? JSON.parse(command(['api',`repos/${REPO}/issues/${proof.p2Disposition.issue}`],runner)) : null;
  return evaluateMerge({source,live,state,pr,checks,proof,p2Issue,reviews,threads,browserReceipt,browserDigest,deploymentReceipt,deploymentDigest},now);
}
function main() {
  const [mode,number,proofFile]=process.argv.slice(2);
  if (!['check','merge'].includes(mode)||!proofFile) throw new Error('usage: civicline-merge-authority.mjs <check|merge> <PR> <proof.json>');
  const verdict=checkCurrent(Number(number),proofFile);
  if (!verdict.allowed) { process.stdout.write(`${JSON.stringify(verdict)}\n`); process.exitCode=2; return; }
  if (mode==='check') { process.stdout.write(`${JSON.stringify(verdict)}\n`); return; }
  // GitHub enforces exact head at the mutation boundary, including races after the readback.
  command(['pr','merge',String(number),'-R',REPO,'--squash','--match-head-commit',verdict.head]);
  process.stdout.write(`${JSON.stringify({status:'merge_command_succeeded',pr:Number(number),head:verdict.head})}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { main(); } catch(e) { process.stderr.write(`${e.message}\n`); process.exitCode=2; }
}
