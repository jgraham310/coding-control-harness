#!/usr/bin/env node
// Exact-head Codex review dispatcher.  A new PR SHA never inherits review
// evidence from its predecessor; it gets one immediate review request and no
// duplicate request while that review is running.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const needsExactHeadReview = ({ head, reviews, comments = [], requestedHead, requestedAt, now = Date.now() }) => {
  const codexReviews = (reviews || []).filter((review) => /codex/i.test(String(review.user?.login || "")));
  if (codexReviews.some((review) => review.commit_id === head)) return false;
  // A manually requested review has not created a PullRequestReview yet.  The
  // bot's summary is the only durable in-flight receipt, and includes the
  // reviewed SHA; recognize it instead of posting a second request.
  if ((comments || []).some((comment) => /codex-pull-request-review-summary/.test(String(comment.body || ""))
      && String(comment.body || "").includes(head.slice(0, 7)) && /running/i.test(String(comment.body || "")))) return false;
  // A request without a completed review or live in-flight marker expires;
  // never convert it into a false reviewedHead receipt.
  return requestedHead !== head || !requestedAt || now - Date.parse(requestedAt) >= 15 * 60 * 1000;
};

const gh = (args) => JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
const statePath = process.env.EXACT_HEAD_REVIEW_STATE
  || path.resolve(path.dirname(new URL(import.meta.url).pathname), "exact-head-review-state.json");
const readState = () => {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return { schema: 1, pullRequests: {} }; throw error; }
};
const writeState = (state) => {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, statePath);
};

export function reconcile({ repo, number, state, client = gh, requestReview = null }) {
  const pr = client(["pr", "view", String(number), "--repo", repo, "--json", "headRefOid,isDraft,state"]);
  if (pr.state !== "OPEN" || pr.isDraft) return { action: "skipped", reason: "not an open reviewable PR" };
  const reviews = client(["api", `repos/${repo}/pulls/${number}/reviews`]);
  const comments = client(["api", `repos/${repo}/issues/${number}/comments`]);
  const key = `${repo}#${number}`;
  const prior = state.pullRequests[key] || {};
  if (!needsExactHeadReview({ head: pr.headRefOid, reviews, comments, requestedHead: prior.requestedHead, requestedAt: prior.requestedAt })) {
    const reviewed = reviews.some((review) => /codex/i.test(String(review.user?.login || "")) && review.commit_id === pr.headRefOid);
    state.pullRequests[key] = { ...prior, observedHead: pr.headRefOid, ...(reviewed ? { reviewedHead: pr.headRefOid } : {}), observedAt: new Date().toISOString() };
    return { action: reviewed ? "already-reviewed" : "review-pending", head: pr.headRefOid };
  }
  const submit = requestReview || (() => execFileSync("gh", ["pr", "comment", String(number), "--repo", repo, "--body", "@codex review"], { encoding: "utf8" }));
  submit();
  state.pullRequests[key] = { observedHead: pr.headRefOid, requestedHead: pr.headRefOid, requestedAt: new Date().toISOString() };
  return { action: "review-requested", head: pr.headRefOid };
}

export function reconcileReviewedOpenPullRequests({ repo, state, limit = 10, client = gh, requestReview = null }) {
  const pullRequests = client(["pr", "list", "--repo", repo, "--state", "open", "--limit", String(limit), "--json", "number,isDraft"]);
  const results = [];
  for (const pullRequest of pullRequests) {
    if (pullRequest.isDraft) continue;
    const reviews = client(["api", `repos/${repo}/pulls/${pullRequest.number}/reviews`]);
    // The dispatcher owns repairs only after an independent Codex review exists.
    // It does not generate a first review for unrelated PRs.
    if (!reviews.some((review) => /codex/i.test(String(review.user?.login || "")))) continue;
    results.push(reconcile({ repo, number: pullRequest.number, state, client, requestReview }));
  }
  return results;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [first, second, third] = process.argv.slice(2);
  const all = first === "--all";
  const repo = all ? second : first;
  const number = all ? null : second;
  if (!repo || (!all && !number)) throw new Error("usage: exact-head-review-dispatch.mjs [--all] OWNER/REPO [PR_NUMBER]");
  const state = readState();
  const result = all
    ? reconcileReviewedOpenPullRequests({ repo, state, limit: Number(third || 10) })
    : reconcile({ repo, number, state });
  writeState(state);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
