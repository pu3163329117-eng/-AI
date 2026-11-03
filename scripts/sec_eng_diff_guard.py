"""Check added lines in explicitly public source paths without printing values.

This is a narrow leak tripwire, not a complete secret scanner. Run only in a
clean public checkout; neither working-tree contents nor private paths are read.
"""
from __future__ import annotations

import re
import os
import subprocess
import sys
from pathlib import PurePosixPath

ROOTS = {"backend", "frontend", "domain", "storage", "web", "docs", "deploy", "scripts", ".github"}
ROOT_FILES = {"README.md", "README.demo.md", "DEPLOYMENT.md", "AGENTS.md", "server.py", "vercel.json"}
TEXT_EXTENSIONS = {".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".yml", ".yaml", ".md", ".txt", ".html", ".css", ".sh", ".toml", ".conf", ".service", ".timer"}
# Exact public templates included in the existing release tooling allowlist.
# No general exception for .env.example or other private-looking paths.
PUBLIC_TEMPLATES = {
    "deploy/beta/beta.env.example",
    "deploy/beta/offsite.env.example",
    "deploy/beta/wenyan-beta-ops-health.env.example",
    "deploy/beta/wenyan-beta-ops-onfailure.conf.example",
}
PRIVATE_PARTS = {"data", "output", "transcripts", "node_modules", "__pycache__", ".git", ".vercel"}
PRIVATE_EXTENSIONS = {".db", ".sqlite", ".sqlite3", ".pem", ".key", ".p12", ".pfx"}
PATTERNS = {
    "private-key-header": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    "github-token": re.compile(rb"\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{40,})\b"),
    "provider-token": re.compile(rb"\bsk-[A-Za-z0-9]{32,}\b"),
    "aws-access-key": re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
}


def git(*args: str) -> bytes:
    env = dict(os.environ, GIT_LITERAL_PATHSPECS="1")
    result = subprocess.run(["git", *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False, env=env)
    if result.returncode:
        raise ValueError("git command failed or baseline unavailable")
    return result.stdout


def classify(path: str) -> str:
    if path in PUBLIC_TEMPLATES:
        return "text"
    p = PurePosixPath(path)
    parts = p.parts
    if (not parts or p.is_absolute() or any(x in {".", ".."} for x in parts)
            or any(x.lower() in PRIVATE_PARTS for x in parts)
            or any(x.lower().endswith(".env") or ".env." in x.lower() for x in parts)
            or p.suffix.lower() in PRIVATE_EXTENSIONS):
        return "private"
    if not (parts[0] in ROOTS or (len(parts) == 1 and path in ROOT_FILES)):
        return "outside-scope"
    return "text" if p.suffix.lower() in TEXT_EXTENSIONS else "non-text"


def resolve_base(event: str, head: str, before: str, pr_base: str, ref: str, default_branch: str) -> str:
    sha = re.compile(r"[0-9a-fA-F]{40}")
    if not sha.fullmatch(head) or head == "0" * 40:
        raise ValueError("invalid head")
    git("cat-file", "-e", head + "^{commit}")
    if event == "pull_request":
        if not sha.fullmatch(pr_base) or pr_base == "0" * 40:
            raise ValueError("invalid PR base")
        git("cat-file", "-e", pr_base + "^{commit}")
        git("merge-base", "--is-ancestor", pr_base, head)
        return pr_base
    if event != "push" or not ref.startswith("refs/heads/") or not sha.fullmatch(before):
        raise ValueError("unsupported event or ref")
    if before != "0" * 40:
        git("cat-file", "-e", before + "^{commit}")
        return before
    if not default_branch or ref == "refs/heads/" + default_branch:
        raise ValueError("default branch initialization has no trusted base")
    git("check-ref-format", "refs/heads/" + default_branch)
    default_ref = "refs/remotes/origin/" + default_branch
    git("cat-file", "-e", default_ref + "^{commit}")
    bases = git("merge-base", "--all", default_ref, head).decode("ascii").splitlines()
    if len(bases) != 1 or not sha.fullmatch(bases[0]):
        raise ValueError("no unique common ancestor")
    return bases[0]


def main() -> int:
    if len(sys.argv) == 8 and sys.argv[1] == "--resolve-base":
        try:
            print(resolve_base(*sys.argv[2:]))
            return 0
        except (ValueError, UnicodeError, OSError):
            print("FAIL: no verifiable diff baseline", file=sys.stderr)
            return 2
    if len(sys.argv) != 3 or any(not re.fullmatch(r"[0-9a-fA-F]{40}", x) or x == "0" * 40 for x in sys.argv[1:]):
        print("FAIL: provide two nonzero full commit SHAs", file=sys.stderr)
        return 2
    base, head = sys.argv[1:]
    try:
        for revision in (base, head):
            git("cat-file", "-e", revision + "^{commit}")
        # Even unchanged tracked private files would be present in a checkout and
        # could be read by test imports. Inspect names only, before running tests.
        failed = False
        for raw_path in git("ls-tree", "-r", "-z", "--name-only", head).split(b"\0"):
            if raw_path:
                path = raw_path.decode("utf-8")
                if classify(path) == "private":
                    print(f"FAIL: {path!r}: private path in candidate tree")
                    failed = True
        entries = git("diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", base, head, "--").split(b"\0")
        if entries[-1] != b"" or len(entries[:-1]) % 2:
            raise ValueError("unexpected diff format")
        scanned = skipped = 0
        for raw_status, raw_path in zip(entries[0:-1:2], entries[1:-1:2]):
            status = raw_status.decode("ascii")
            path = raw_path.decode("utf-8")
            if status == "D":
                continue
            if status not in {"A", "M", "T"}:
                raise ValueError("unsupported diff status")
            scope = classify(path)
            if scope in {"private", "outside-scope"}:
                print(f"FAIL: {path!r}: {scope} path")
                failed = True
                continue
            if scope == "non-text":
                print(f"SKIP: {path!r}: non-text or unsupported extension")
                skipped += 1
                continue
            patch = git("diff", "--no-ext-diff", "--no-renames", "--text", "--unified=0", base, head, "--", path)
            line_number = 0
            in_hunk = False
            scanned += 1
            for line in patch.splitlines():
                if line.startswith(b"@@ "):
                    match = re.search(rb"\+(\d+)(?:,\d+)?", line)
                    if not match:
                        raise ValueError("unexpected diff hunk")
                    line_number = int(match.group(1))
                    in_hunk = True
                elif in_hunk and line.startswith(b"+"):
                    for category, pattern in PATTERNS.items():
                        if pattern.search(line[1:]):
                            print(f"FAIL: {path!r}:{line_number}: {category}")
                            failed = True
                    line_number += 1
                elif line.startswith(b" "):
                    line_number += 1
        print(f"Checked {scanned} text file(s); skipped {skipped} unsupported file(s). Narrow patterns only.")
        return 1 if failed else 0
    except (ValueError, UnicodeError, OSError):
        print("FAIL: could not safely determine and scan candidate diff", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
