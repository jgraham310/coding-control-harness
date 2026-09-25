import assert from "node:assert/strict";
import { needsExactHeadReview, reconcileReviewedOpenPullRequests } from "./exact-head-review-dispatch.mjs";

const head = "a".repeat(40);
assert.equal(needsExactHeadReview({ head, requestedHead: null, reviews: [{ user: { login: "chatgpt-codex-connector[bot]" }, commit_id: "b".repeat(40) }] }), true, "a new head invalidates prior Codex review");
assert.equal(needsExactHeadReview({ head, requestedHead: head, requestedAt: "2026-09-25T12:00:00Z", now: Date.parse("2026-09-25T12:05:00Z"), reviews: [] }), false, "a recently requested review is not duplicated");
assert.equal(needsExactHeadReview({ head, requestedHead: head, requestedAt: "2026-09-25T12:00:00Z", now: Date.parse("2026-09-25T12:16:00Z"), reviews: [] }), true, "an unobserved review request expires and retries");
assert.equal(needsExactHeadReview({ head, requestedHead: head, reviews: [{ user: { login: "chatgpt-codex-connector[bot]" }, commit_id: head }] }), false, "a completed exact-head review satisfies the gate");
assert.equal(needsExactHeadReview({ head, requestedHead: null, reviews: [], comments: [{ body: `<!-- codex-pull-request-review-summary --> Review Running ${head.slice(0, 7)}` }] }), false, "an externally requested exact-head review is not duplicated");
const calls = [];
const client = (args) => {
  calls.push(args);
  if (args[0] === "pr" && args[1] === "list") return [{ number: 9, isDraft: false }, { number: 10, isDraft: false }];
  if (args[0] === "api" && String(args[1]).endsWith("/reviews")) return String(args[1]).includes("/9/") ? [{ user: { login: "chatgpt-codex-connector[bot]" }, commit_id: "old" }] : [];
  if (args.includes("headRefOid,isDraft,state")) return { state: "OPEN", isDraft: false, headRefOid: head };
  if (args[0] === "api" && String(args[1]).endsWith("/comments")) return [];
  return { state: "OPEN", isDraft: false, headRefOid: head };
};
const state = { pullRequests: {} };
const requested = [];
reconcileReviewedOpenPullRequests({ repo: "owner/repo", state, client, requestReview: () => requested.push("requested") });
assert.deepEqual(requested, ["requested"], "only previously reviewed PRs are re-reviewed after a head change");
const pendingState = { pullRequests: { "owner/repo#9": { requestedHead: head, requestedAt: new Date().toISOString() } } };
const pending = reconcileReviewedOpenPullRequests({ repo: "owner/repo", state: pendingState, client, requestReview: () => requested.push("duplicate") });
assert.equal(pending[0].action, "review-pending");
assert.equal(pendingState.pullRequests["owner/repo#9"].reviewedHead, undefined, "a request is not a completed review receipt");
assert.deepEqual(requested, ["requested"]);
console.log("exact-head review dispatcher tests: passed");
