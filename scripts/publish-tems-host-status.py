#!/usr/bin/env python3
"""Run canonical-host TEMS integration and publish an exact-head GitHub status."""
import hashlib
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

REPOSITORY = "jgraham310/coding-control-harness"
CONTEXT = "tems/canonical-host-integration"
ROOT = Path(__file__).resolve().parents[1]
RECEIPT = ROOT / "test/fixtures/tems-host-integration-receipt.json"


def command(*args):
    return subprocess.run(args, cwd=ROOT, text=True, capture_output=True, check=True).stdout.strip()


def request(method, path, token, payload=None):
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPOSITORY}/{path}", data=body, method=method,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28"})
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.load(response)


def main():
    if len(sys.argv) != 2 or not sys.argv[1].isdigit() or int(sys.argv[1]) < 1:
        raise SystemExit("usage: publish-tems-host-status.py PR_NUMBER")
    pr = int(sys.argv[1])
    head = command("git", "rev-parse", "HEAD")
    if command("git", "status", "--porcelain"):
        raise RuntimeError("candidate worktree must be clean")
    token = command("gh", "auth", "token")
    pull = request("GET", f"pulls/{pr}", token)
    if pull["head"]["sha"] != head or pull["state"] != "open":
        raise RuntimeError("PR is not open at the checked-out exact head")

    target = f"https://github.com/{REPOSITORY}/blob/{head}/test/fixtures/tems-host-integration-receipt.json"
    def publish(state, description):
        request("POST", f"statuses/{head}", token,
                {"state": state, "context": CONTEXT, "description": description[:140], "target_url": target})

    publish("pending", "Canonical-host gate running at exact head")
    try:
        subprocess.run(["node", "test/live-portfolio-merge-runner.host.test.mjs"], cwd=ROOT, check=True)
        subprocess.run(["node", "test/host-integration-receipt.mjs", "verify"], cwd=ROOT, check=True)
        digest = hashlib.sha256(RECEIPT.read_bytes()).hexdigest()
        publish("success", f"Live runner and installed gate passed; candidate receipt sha256 {digest[:32]}")
        print(json.dumps({"head": head, "context": CONTEXT, "state": "success", "receipt_sha256": digest}))
    except Exception:
        publish("failure", "Live runner, installed gate, or candidate receipt failed")
        raise


if __name__ == "__main__":
    main()
