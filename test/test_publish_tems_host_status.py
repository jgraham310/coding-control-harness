import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/publish-tems-host-status.py"
spec = importlib.util.spec_from_file_location("publish_tems_host_status", SCRIPT)
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class PublisherTests(unittest.TestCase):
    def test_tems_status_targets_tems_head_after_host_proof(self):
        harness_head = "a" * 40
        tems_head = "b" * 40
        calls = []

        def request(method, repository, path, token, payload=None):
            calls.append((method, repository, path, payload))
            if method == "GET":
                return {"state": "open", "head": {"sha": tems_head}}
            return {}

        with patch.object(sys, "argv", [str(SCRIPT), "--tems-pr", "654"]), \
             patch.object(publisher, "command", side_effect=[harness_head, "", "token"]), \
             patch.object(publisher, "request", side_effect=request), \
             patch.object(publisher.subprocess, "run"), \
             patch.object(Path, "read_bytes", return_value=b"receipt"):
            publisher.main()
        posts = [(repo, path, body) for method, repo, path, body in calls if method == "POST"]
        self.assertEqual([body["state"] for _, _, body in posts], ["pending", "success"])
        self.assertTrue(all(repo == publisher.TEMS_REPOSITORY and path == f"statuses/{tems_head}"
                            for repo, path, _ in posts))
        self.assertTrue(all(f"/{harness_head}/" in body["target_url"] for _, _, body in posts))

    def test_changed_target_head_denies_status(self):
        heads = iter(["b" * 40, "c" * 40])
        def request(method, repository, path, token, payload=None):
            if method == "GET":
                return {"state": "open", "head": {"sha": next(heads)}}
            self.fail("status must not be published after target head changes")
        with patch.object(sys, "argv", [str(SCRIPT), "--tems-pr", "654"]), \
             patch.object(publisher, "command", side_effect=["a" * 40, "", "token"]), \
             patch.object(publisher, "request", side_effect=request):
            with self.assertRaisesRegex(RuntimeError, "head changed"):
                publisher.main()


if __name__ == "__main__":
    unittest.main()
