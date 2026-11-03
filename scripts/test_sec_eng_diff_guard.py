"""Exercise the guard against temporary, synthetic Git commits only."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

GUARD = Path(__file__).with_name("sec_eng_diff_guard.py").resolve()


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.run_git("init", "-q")
        self.write("README.md", "initial\n")
        self.base = self.commit()

    def tearDown(self):
        self.temp.cleanup()

    def run_git(self, *args):
        return subprocess.run(["git", "-c", "user.name=CI Test", "-c", "user.email=test@example.invalid", *args],
                              cwd=self.root, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.decode().strip()

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def commit(self):
        self.run_git("add", "-A")
        self.run_git("commit", "-qm", "synthetic")
        return self.run_git("rev-parse", "HEAD")

    def scan(self, base, head):
        env = dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
        return subprocess.run([sys.executable, str(GUARD), base, head], cwd=self.root, env=env,
                              capture_output=True, text=True)

    def resolve(self, event, head, before, pr_base, ref, default_branch="main"):
        env = dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
        return subprocess.run([sys.executable, str(GUARD), "--resolve-base", event, head, before,
                               pr_base, ref, default_branch], cwd=self.root, env=env,
                              capture_output=True, text=True)

    def test_added_match_reports_category_without_value(self):
        token = "ghp_" + "a" * 36
        self.write("backend/example.py", "value = '" + token + "'\n")
        result = self.scan(self.base, self.commit())
        self.assertEqual(result.returncode, 1)
        self.assertIn("github-token", result.stdout)
        self.assertNotIn(token, result.stdout + result.stderr)

    def test_rename_is_scanned_as_add_and_deleted_file_is_not_read(self):
        token = "sk-" + "a" * 40
        self.write("backend/old.py", token + "\n")
        first = self.commit()
        self.run_git("mv", "backend/old.py", "backend/new.py")
        result = self.scan(first, self.commit())
        self.assertEqual(result.returncode, 1)
        self.assertIn("provider-token", result.stdout)
        self.assertNotIn(token, result.stdout)

    def test_private_path_rejected_without_reading_value(self):
        self.write("backend/private.env", "private-value\n")
        result = self.scan(self.base, self.commit())
        self.assertEqual(result.returncode, 1)
        self.assertIn("private path", result.stdout)
        self.assertNotIn("private-value", result.stdout + result.stderr)

    def test_deleted_private_path_is_allowed(self):
        self.write("backend/private.env", "private-value\n")
        first = self.commit()
        (self.root / "backend/private.env").unlink()
        self.assertEqual(self.scan(first, self.commit()).returncode, 0)

    def test_unchanged_private_file_blocks_candidate_tree(self):
        self.write("backend/.env", "private-value\n")
        first = self.commit()
        self.write("backend/example.py", "safe = True\n")
        result = self.scan(first, self.commit())
        self.assertEqual(result.returncode, 1)
        self.assertIn("private path in candidate tree", result.stdout)
        self.assertNotIn("private-value", result.stdout + result.stderr)

    def test_exact_public_templates_and_deployment_text_are_scanned(self):
        token = "ghp_" + "a" * 36
        paths = ["deploy/beta/beta.env.example", "deploy/beta/offsite.env.example",
                 "deploy/beta/wenyan-beta-ops-health.env.example", "deploy/beta/wenyan-beta-ops-onfailure.conf.example",
                 "deploy/beta/example.conf", "deploy/beta/example.service", "deploy/beta/example.timer",
                 "backend/scripts/harness_single_call_guard.cjs", "frontend/tests/example.browser.cjs"]
        for path in paths:
            self.write(path, "value = '" + token + "'\n")
        result = self.scan(self.base, self.commit())
        self.assertEqual(result.returncode, 1)
        for path in paths:
            self.assertIn(f"{path!r}:1: github-token", result.stdout)
        self.assertEqual(result.stdout.count("github-token"), len(paths))
        self.assertNotIn(token, result.stdout + result.stderr)

    def test_other_env_examples_and_real_env_remain_private(self):
        self.write("deploy/beta/other.env.example", "private-value\n")
        self.write("deploy/beta/offsite.env", "private-value\n")
        result = self.scan(self.base, self.commit())
        self.assertEqual(result.returncode, 1)
        self.assertIn("other.env.example", result.stdout)
        self.assertIn("offsite.env", result.stdout)
        self.assertNotIn("private-value", result.stdout + result.stderr)

    def test_clean_diff_and_missing_baselines(self):
        self.write("frontend/test.ts", "export const value = 1;\n")
        head = self.commit()
        self.assertEqual(self.scan(self.base, head).returncode, 0)
        self.assertEqual(self.scan("0" * 40, head).returncode, 2)
        self.assertEqual(self.scan("f" * 40, head).returncode, 2)

    def test_new_branch_uses_common_ancestor_and_scans_all_commits(self):
        self.run_git("update-ref", "refs/remotes/origin/main", self.base)
        self.run_git("checkout", "-qb", "feature")
        token = "ghp_" + "a" * 36
        self.write("backend/first.py", token + "\n")
        first = self.commit()
        self.write("backend/second.py", "safe = True\n")
        head = self.commit()
        result = self.resolve("push", head, "0" * 40, "", "refs/heads/feature")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), self.base)
        self.assertNotEqual(result.stdout.strip(), first)
        self.assertEqual(self.scan(result.stdout.strip(), head).returncode, 1)

    def test_new_branch_without_common_ancestor_fails(self):
        self.run_git("update-ref", "refs/remotes/origin/main", self.base)
        self.run_git("checkout", "--orphan", "unrelated")
        self.write("README.md", "unrelated\n")
        head = self.commit()
        self.assertEqual(self.resolve("push", head, "0" * 40, "", "refs/heads/unrelated").returncode, 2)

    def test_push_and_pr_use_event_baselines(self):
        self.write("backend/one.py", "one = 1\n")
        first = self.commit()
        self.write("backend/two.py", "two = 2\n")
        head = self.commit()
        pushed = self.resolve("push", head, first, "", "refs/heads/feature")
        pr = self.resolve("pull_request", head, "", self.base, "refs/pull/1/merge")
        self.assertEqual((pushed.returncode, pushed.stdout.strip()), (0, first))
        self.assertEqual((pr.returncode, pr.stdout.strip()), (0, self.base))
        self.assertEqual(self.resolve("pull_request", first, "", head, "refs/pull/1/merge").returncode, 2)

    def test_unavailable_default_initialization_and_tags_fail_closed(self):
        zero = "0" * 40
        self.assertEqual(self.resolve("push", self.base, zero, "", "refs/heads/feature").returncode, 2)
        self.run_git("update-ref", "refs/remotes/origin/main", self.base)
        self.assertEqual(self.resolve("push", self.base, zero, "", "refs/heads/main").returncode, 2)
        self.assertEqual(self.resolve("push", self.base, zero, "", "refs/tags/v1").returncode, 2)


if __name__ == "__main__":
    unittest.main()
