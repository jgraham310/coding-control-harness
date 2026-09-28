#!/usr/bin/env python3
"""Run canonical-host TEMS integration and publish an exact-head GitHub status."""
import hashlib
import argparse
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

HARNESS_REPOSITORY = "jgraham310/coding-control-harness"
TEMS_REPOSITORY = "jgraham310/tems"
CONTEXT = "tems/canonical-host-integration"
ROOT = Path(__file__).resolve().parents[1]
RECEIPT = ROOT / "test/fixtures/tems-host-integration-receipt.json"


def command(*args):
    return subprocess.run(args, cwd=ROOT, text=True, capture_output=True, check=True).stdout.strip()


def request(method, repository, path, token, payload=None):
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repository}/{path}", data=body, method=method,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28"})
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--harness-pr", type=int)
    target.add_argument("--tems-pr", type=int)
    args = parser.parse_args()
    pr = args.tems_pr if args.tems_pr is not None else args.harness_pr
    if pr < 1:
        parser.error("PR number must be positive")
    repository = TEMS_REPOSITORY if args.tems_pr is not None else HARNESS_REPOSITORY
    harness_head = command("git", "rev-parse", "HEAD")
    if command("git", "status", "--porcelain"):
        raise RuntimeError("candidate worktree must be clean")
    token = command("gh", "auth", "token")
    pull = request("GET", repository, f"pulls/{pr}", token)
    head = pull["head"]["sha"]
    if pull["state"] != "open" or (repository == HARNESS_REPOSITORY and head != harness_head):
        raise RuntimeError("PR is not open at the expected exact head")

    target = f"https://github.com/{HARNESS_REPOSITORY}/blob/{harness_head}/test/fixtures/tems-host-integration-receipt.json"
    def publish(state, description):
        current = request("GET", repository, f"pulls/{pr}", token)
        if current["state"] != "open" or current["head"]["sha"] != head:
            raise RuntimeError("PR head changed during canonical-host verification")
        request("POST", repository, f"statuses/{head}", token,
                {"state": state, "context": CONTEXT, "description": description[:140], "target_url": target})

    publish("pending", "Canonical-host gate running at exact head")
    try:
        subprocess.run(["node", "test/live-portfolio-merge-runner.host.test.mjs"], cwd=ROOT, check=True)
        subprocess.run(["node", "test/host-integration-receipt.mjs", "verify"], cwd=ROOT, check=True)
        digest = hashlib.sha256(RECEIPT.read_bytes()).hexdigest()
        publish("success", f"Live runner and installed gate passed; candidate receipt sha256 {digest[:32]}")
        print(json.dumps({"repository": repository, "head": head, "harness_head": harness_head,
                          "context": CONTEXT, "state": "success", "receipt_sha256": digest}))
    except Exception:
        publish("failure", "Live runner, installed gate, or candidate receipt failed")
        raise


if __name__ == "__main__":
    main()
