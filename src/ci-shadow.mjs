#!/usr/bin/env node
/** Deterministic, advisory CI impact analysis. Full CI is never selected away. */
import crypto from 'node:crypto';
import fs from 'node:fs';

export const IMPACT_SCHEMA = 'ci_impact_map/v1';
export const LEDGER_SCHEMA = 'ci_shadow_ledger_event/v1';

const highRisk = /(^|\/)(auth|identity|migration|migrations|records|ordinance|release|deploy|production|core)(\/|$)|(^|\/)(Dockerfile|\.github\/workflows\/)/i;
const match = (file, pattern) => pattern.endsWith('/**')
  ? file.startsWith(pattern.slice(0, -3))
  : pattern.endsWith('*') ? file.startsWith(pattern.slice(0, -1)) : file === pattern;

export function buildImpactManifest({ repository, headSha, changedFiles, impactMap }) {
  if (!impactMap || impactMap.schema !== IMPACT_SCHEMA) throw new Error('invalid impact map');
  const files = [...new Set(changedFiles || [])].sort();
  const selected = new Set();
  const unknown = [];
  let risk = 'low';
  for (const file of files) {
    if (highRisk.test(file)) risk = 'high';
    const rules = (impactMap.rules || []).filter((rule) => match(file, rule.path));
    if (!rules.length) unknown.push(file);
    for (const rule of rules) for (const target of rule.targets || []) selected.add(target);
  }
  const fallback = risk === 'high' || unknown.length > 0 || files.length === 0;
  const targets = fallback ? [...new Set(impactMap.fullSuite || [])].sort() : [...selected].sort();
  return {
    schema: 'ci_impact_manifest/v1', repository, headSha, mappingVersion: impactMap.version,
    changedFiles: files, riskClass: risk, unclassifiedFiles: unknown,
    selectedTargets: targets, fullCiRequired: true, mode: 'shadow',
    decision: fallback ? 'full_suite_fallback' : 'advisory_selection',
  };
}

export function ledgerKey(event) {
  return [event.repository, event.headSha, event.workflowRunId, event.jobId].map(String).join(':');
}

export function ingestLedgerEvent(events, event) {
  if (!event || event.schema !== LEDGER_SCHEMA) throw new Error('invalid ledger event');
  const key = ledgerKey(event);
  const index = events.findIndex((entry) => ledgerKey(entry) === key);
  const next = { ...event, key, ingestedAt: event.ingestedAt || new Date(0).toISOString() };
  if (index < 0) return [...events, next];
  // Terminal observations supersede an earlier non-terminal observation; identical delivery is idempotent.
  const old = events[index];
  if (old.status === next.status && old.conclusion === next.conclusion) return events;
  const copy = [...events]; copy[index] = { ...old, ...next }; return copy;
}

export function buildShadowReport({ events = [], manifests = [], now = new Date().toISOString(), staleAfterMs = 60 * 60 * 1000 }) {
  const terminal = events.filter((entry) => ['completed', 'cancelled'].includes(entry.status));
  const incomplete = events.length - terminal.length;
  const stale = events.filter((entry) => !['completed', 'cancelled'].includes(entry.status)
    && Date.parse(now) - Date.parse(entry.observedAt) > staleAfterMs).length;
  const fallback = manifests.filter((entry) => entry.decision === 'full_suite_fallback').length;
  const disagreement = events.filter((entry) => entry.kind === 'comparison' && entry.selectedConclusion !== entry.fullConclusion).length;
  const conservationOk = incomplete === 0;
  const decision = disagreement || stale || !conservationOk ? 'hold'
    : manifests.length >= 50 ? 'eligible_for_review' : 'continue_shadow';
  return { schema: 'ci_shadow_report/v1', generatedAt: now, jobsObserved: events.length,
    jobsTerminal: terminal.length, incompleteJobs: incomplete, staleJobs: stale,
    conservationOk, unclassifiedFallbacks: fallback, selectedFullDisagreements: disagreement,
    decision, fullCiRequired: true };
}

function hash(text) { return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16); }
function cli() {
  const [, , command, input = '-'] = process.argv;
  const payload = JSON.parse(input === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(input, 'utf8'));
  let out;
  if (command === 'manifest') out = buildImpactManifest(payload);
  else if (command === 'report') out = buildShadowReport(payload);
  else if (command === 'ingest') out = ingestLedgerEvent(payload.events || [], payload.event);
  else throw new Error('usage: ci-shadow.mjs manifest|ingest|report <json-file|->');
  process.stdout.write(`${JSON.stringify({ ...out, fingerprint: hash(JSON.stringify(out)) })}\n`);
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) cli();
