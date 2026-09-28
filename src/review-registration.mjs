/** Authenticated, exact-head review registrations from GitHub issue comments. */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const verified = new WeakSet();
export function collectCommentPages(fetchPage, { maxPages = 100 } = {}) {
  const comments = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = fetchPage(page);
    if (!Array.isArray(batch)) throw new Error("Invalid GitHub comments response");
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
  throw new Error("Review registration comment scan exceeded page bound");
}
const githubComments = (lane) => {
  const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000 }).trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(token)) throw new Error("GitHub token unavailable");
  return collectCommentPages((page) => {
    const url = `https://api.github.com/repos/${lane.repository}/issues/${lane.issue}/comments?per_page=100&page=${page}`;
    return JSON.parse(execFileSync("curl", ["--fail", "--silent", "--show-error", "--url", url, "-K", "-"], {
      input: `header = "Authorization: Bearer ${token}"\nheader = "Accept: application/vnd.github+json"\n`, encoding: "utf8", timeout: 10000,
    }));
  });
};
const sha = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const registrationPrefix = "independent-review-registration/v1 ";
const trustedAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function isAuthenticatedReviewRegistration(registration, lane) {
  return !!registration && verified.has(registration)
    && registration.laneId === lane.id
    && registration.id === lane.nextAction?.registrationId
    && registration.reviewer === lane.nextAction?.reviewer
    && registration.headSha === lane.headSha
    && registration.actionDigest === sha(lane.nextAction?.argv)
    && registration.githubCommentId !== undefined;
}

export function loadReviewRegistration(lane, { client = githubComments } = {}) {
  if (!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(lane?.repository ?? "") || !Number.isInteger(lane.issue) || !lane.implementerLogin
      || !/^[0-9a-f]{40}$/i.test(lane.headSha ?? "")) return null;
  const comments = client(lane);
  if (!Array.isArray(comments)) return null;
  for (const comment of comments.slice().reverse()) {
    if (!trustedAssociations.has(comment.author_association)) continue;
    const registrar = comment.user?.login;
    if (!registrar) continue;
    const body = String(comment.body ?? "").trim();
    if (!body.startsWith(registrationPrefix)) continue;
    let record;
    try { record = JSON.parse(body.slice(registrationPrefix.length)); } catch { continue; }
    if (record?.schema !== "independent-review-registration/v1" || record.laneId !== lane.id
        || record.id !== lane.nextAction?.registrationId || record.reviewer !== lane.nextAction?.reviewer
        || record.headSha !== lane.headSha || record.actionDigest !== sha(lane.nextAction?.argv)
        || record.implementerLogin !== lane.implementerLogin) continue;
    const registration = Object.freeze({ ...record, registrar, githubCommentId: comment.id });
    verified.add(registration);
    return registration;
  }
  return null;
}
