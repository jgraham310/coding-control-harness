#!/usr/bin/env node
/**
 * Deterministic, fail-closed task routing.
 *
 * This module selects a pre-approved protocol from an inspectable task
 * envelope. It does not invoke a model, run a tool, change permissions, or
 * authorize an action. Unknown and conflicting requests deliberately receive
 * the governed-general protocol.
 */

const PROTOCOLS = Object.freeze({
  governed_general: Object.freeze({
    id: "governed_general",
    authority: "observe_or_draft_only",
    contextBudget: "small",
    checks: ["state_and_authority_check"],
    retries: "none_without_a_named_predicate",
    modelRequired: true,
  }),
  research: Object.freeze({
    id: "research",
    authority: "read_only",
    contextBudget: "source_bounded",
    checks: ["source_capture", "citation_check"],
    retries: "single_source_fetch_retry",
    modelRequired: true,
  }),
  coding: Object.freeze({
    id: "coding",
    authority: "local_workspace_only",
    contextBudget: "repository_bounded",
    checks: ["repository_map", "focused_tests"],
    retries: "single_failing_check_retry",
    modelRequired: true,
  }),
  operations: Object.freeze({
    id: "operations",
    authority: "approved_internal_operations_only",
    contextBudget: "state_bounded",
    checks: ["authoritative_state_check"],
    retries: "single_predicate_retry",
    modelRequired: true,
  }),
  release_verification: Object.freeze({
    id: "release_verification",
    authority: "read_only_verification",
    contextBudget: "release_evidence_bounded",
    checks: ["provenance", "exact_head_ci", "smoke", "rollback_anchor"],
    retries: "single_gate_retry",
    modelRequired: false,
  }),
  jason_gated: Object.freeze({
    id: "jason_gated",
    authority: "jason_only",
    contextBudget: "evidence_bounded",
    checks: ["authority_check"],
    retries: "none",
    modelRequired: false,
  }),
});

const RISK_RULES = Object.freeze([
  { id: "production", pattern: /\b(?:deploy|deployment|production|prod)\b/i, reason: "production_marker" },
  { id: "external_send", pattern: /\b(?:send|email|message|contact|outreach|publish)\b/i, reason: "external_communication_marker" },
  { id: "spend", pattern: /\b(?:spend|purchase|buy|pay|payment|invoice)\b/i, reason: "financial_marker" },
  { id: "permissions", pattern: /\b(?:permission|credential|token|api key|access grant|role change)\b/i, reason: "permission_marker" },
]);

const ROUTE_RULES = Object.freeze([
  { id: "release_verification", pattern: /\b(?:verify|check|validate|smoke|ci|provenance|rollback)\b/i, requiredSignals: ["merged_pr", "release_window"] },
  { id: "research", pattern: /\b(?:paper|research|article|report|study|arxiv|citation|source)\b/i },
  { id: "coding", pattern: /\b(?:code|coding|repository|repo|pull request|\bpr\b|diff|test|bug|implementation)\b/i },
  { id: "operations", pattern: /\b(?:briefing|calendar|schedule|invoice|pipeline|hubspot|operations|ops)\b/i },
]);

function fail(message) { throw new Error(message); }
function normalizedText(value) { return String(value ?? "").trim(); }
function unique(values) { return [...new Set(values)]; }

export function validateTaskEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) fail("Task envelope must be an object.");
  if (typeof envelope.request !== "string" || !envelope.request.trim()) fail("Task envelope requires a non-empty request.");
  for (const key of ["attachments", "signals"]) {
    if (envelope[key] !== undefined && (!Array.isArray(envelope[key]) || !envelope[key].every((value) => typeof value === "string" && value.trim()))) fail(`Task envelope ${key} must be an array of non-empty strings.`);
  }
  if (envelope.repository !== undefined && typeof envelope.repository !== "string") fail("Task envelope repository must be a string.");
  return true;
}

function matchesRisk(text, signals) {
  const marked = RISK_RULES.filter((rule) => rule.pattern.test(text));
  // A caller may supply only these verified state signals; arbitrary signal
  // names are not privileged inputs to the classifier.
  if (signals.includes("production_target")) marked.push({ id: "production", reason: "verified_production_target" });
  if (signals.includes("external_send")) marked.push({ id: "external_send", reason: "verified_external_send" });
  if (signals.includes("spend")) marked.push({ id: "spend", reason: "verified_spend" });
  if (signals.includes("permission_change")) marked.push({ id: "permissions", reason: "verified_permission_change" });
  return marked;
}

/**
 * Returns only a protocol selection and its evidence. Callers remain
 * responsible for enforcing the returned authority and checks.
 */
export function classifyTask(envelope) {
  validateTaskEnvelope(envelope);
  const signals = unique(envelope.signals ?? []);
  const text = [envelope.request, envelope.repository ?? "", ...(envelope.attachments ?? [])].join("\n");
  const risks = matchesRisk(text, signals);
  if (risks.length > 0) {
    return { protocol: PROTOCOLS.jason_gated, reason: unique(risks.map((risk) => risk.reason)), matchedRoutes: [], requiresJason: true };
  }

  const matches = ROUTE_RULES.filter((rule) => rule.pattern.test(text) && (!rule.requiredSignals || rule.requiredSignals.every((signal) => signals.includes(signal))));
  const routeIds = unique(matches.map((match) => match.id));
  // A release candidate is a more specific, verified state than generic code
  // terminology in its request. This is the sole non-risk precedence rule.
  if (routeIds.includes("release_verification")) {
    return { protocol: PROTOCOLS.release_verification, reason: ["matched_release_verification"], matchedRoutes: routeIds, requiresJason: false };
  }
  if (routeIds.length === 1) {
    return { protocol: PROTOCOLS[routeIds[0]], reason: [`matched_${routeIds[0]}`], matchedRoutes: routeIds, requiresJason: false };
  }
  return {
    protocol: PROTOCOLS.governed_general,
    reason: [routeIds.length === 0 ? "no_deterministic_match" : "conflicting_deterministic_matches"],
    matchedRoutes: routeIds,
    requiresJason: false,
  };
}

export { PROTOCOLS };

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2];
  if (!input) fail("Usage: task-classifier.mjs '<task-envelope-json>'");
  process.stdout.write(`${JSON.stringify(classifyTask(JSON.parse(input)), null, 2)}\n`);
}
