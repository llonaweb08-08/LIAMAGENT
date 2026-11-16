#!/usr/bin/env python3
"""Scan the repository for likely committed or local plaintext secrets.

This scanner is intentionally high-signal: it reports common secret patterns and
obvious secret assignments without printing secret values. Use it in CI,
pre-commit, and local preflight checks.

Exit codes:
  0 = no findings
  1 = findings detected
  2 = scanner/config error
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

TEXT_EXTS = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".yml", ".yaml", ".md", ".txt",
    ".env", ".toml", ".ini", ".cfg", ".conf", ".sh", ".bat", ".ps1", ".html", ".css",
    ".sql", ".xml", ".dockerfile", "",
}
SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", ".ruff_cache",
    ".pytest_cache", ".mypy_cache", "htmlcov", "dist", "build", ".next",
}
SKIP_FILES = {
    "package-lock.json",  # hashes/URLs, low value and noisy
}
# Files where placeholder/example values are expected.
ALLOWLIST_PATH_PARTS = {
    ".env.example", "README", "docs/", "tests/", "scan_secrets.py",
}

SECRET_PATTERNS = [
    ("private-key-block", re.compile(r"-----BEGIN (?:RSA|EC|DSA|OPENSSH|PGP)? ?PRIVATE KEY-----")),
    ("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z\-_]{35}\b")),
    ("github-token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b")),
    ("slack-token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("openai-like-key", re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")),
    ("huggingface-token", re.compile(r"\bhf_[A-Za-z0-9]{20,}\b")),
    ("supabase-service-key", re.compile(r"\bsb_secret_[A-Za-z0-9_-]{20,}\b")),
]

# Known secret-bearing env/config names. Flag obvious non-empty assignments in
# tracked source/config files (not examples/docs/tests) to catch accidental commits.
SECRET_NAMES = (
    "MOON_KEYS", "UNO_KEYS", "AGNES_KEY", "HCN_KEY", "HF_KEY", "GOOGLE_API_KEY",
    "TAVILY_API_KEY", "BRAVE_API_KEY", "SERPER_API_KEY", "INSTABOX_API_KEY",
    "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY", "LIAM_EMAIL_PASSWORD",
    "LIAM_PAIR_TOKEN",
)
ASSIGN_RE = re.compile(
    r"^\s*(?:export\s+)?(?:" + "|".join(map(re.escape, SECRET_NAMES)) + r")\s*[:=]\s*(.+?)\s*$"
)
PLACEHOLDER_RE = re.compile(
    r"^(?:\"\"|''|\"your[_-].*\"|'your[_-].*'|<.*>|changeme|replace.?me|example|xxx+|none|null|false|0|\[\]|\(\)|sync:\s*false|generateValue:\s*true)$",
    re.IGNORECASE,
)


def _is_text_candidate(path: Path) -> bool:
    if path.name in SKIP_FILES:
        return False
    ext = path.suffix.lower()
    if path.name.lower() == "dockerfile":
        return True
    return ext in TEXT_EXTS


def _should_skip_path(path: Path) -> bool:
    parts = set(path.parts)
    return bool(parts & SKIP_DIRS)


def _allowlisted(path: Path) -> bool:
    rel = path.relative_to(ROOT).as_posix()
    return any(part in rel for part in ALLOWLIST_PATH_PARTS)


def _read_text(path: Path) -> str | None:
    try:
        data = path.read_bytes()
    except OSError:
        return None
    if b"\x00" in data[:4096]:
        return None
    return data.decode("utf-8", errors="replace")


def scan_file(path: Path, include_local: bool) -> list[tuple[str, int, str]]:
    rel = path.relative_to(ROOT).as_posix()
    # liam_secrets.py is gitignored/local by design; flag only when explicitly
    # requested (preflight) so CI on a clean checkout stays clean.
    if rel == "liam_secrets.py" and not include_local:
        return []
    text = _read_text(path)
    if text is None:
        return []
    findings: list[tuple[str, int, str]] = []
    allow = _allowlisted(path)
    for i, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#") and "BEGIN" not in stripped:
            # still scan comments for key blocks
            if "PRIVATE KEY-----" not in stripped:
                continue
        for name, rx in SECRET_PATTERNS:
            if rx.search(line):
                # allow obvious placeholders in docs/examples/tests only
                if allow and "example" in line.lower():
                    continue
                findings.append((rel, i, f"pattern:{name}"))
                break
        else:
            # assignment heuristic (skip docs/examples/tests and liam_secrets.py here;
            # liam_secrets.py presence is handled separately with a clear warning)
            if allow or rel == "liam_secrets.py":
                continue
            m = ASSIGN_RE.match(line)
            if m:
                rhs = m.group(1).strip()
                value = rhs.strip('"').strip("'")
                # Skip safe retrievals/defaults; flag only obvious inline plaintext.
                if value and not PLACEHOLDER_RE.match(rhs):
                    if any(tok in line for tok in ("os.environ", "getenv", "_secret(", "_keys(")):
                        continue
                    if value in ("", "null", "None"):
                        continue
                    findings.append((rel, i, "assignment:secret-name"))
    # Special local-file warning: liam_secrets.py with non-trivial content.
    if rel == "liam_secrets.py" and include_local:
        # look for any quoted value of decent length assigned
        if re.search(r"=\s*[\"'][^\"']{12,}[\"']", text) or re.search(r"=\s*\[[^\]]{12,}\]", text, re.S):
            findings.insert(0, (rel, 1, "local-secret-file:non-empty (gitignored)"))
    return findings


def iter_files(root: Path, include_local: bool):
    # Always consider liam_secrets.py explicitly if present.
    local = root / "liam_secrets.py"
    seen = set()
    if include_local and local.exists():
        seen.add(local.resolve())
        yield local
    for dirpath, dirnames, filenames in os.walk(root):
        dp = Path(dirpath)
        if _should_skip_path(dp):
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not (dp / d).name.startswith(".git")]
        for fn in filenames:
            p = dp / fn
            try:
                rp = p.resolve()
            except OSError:
                continue
            if rp in seen:
                continue
            if _should_skip_path(p):
                continue
            if not _is_text_candidate(p):
                continue
            # skip gitignored runtime/local db/session artifacts by common names
            name = p.name
            if name in ("liam_memory.db", "liam_memory.db-wal", "liam_memory.db-shm"):
                continue
            seen.add(rp)
            yield p


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Scan for likely plaintext secrets.")
    ap.add_argument("--include-local", action="store_true",
                    help="also inspect local gitignored secret files such as liam_secrets.py")
    ap.add_argument("--root", default=str(ROOT), help="repository root to scan")
    args = ap.parse_args(argv)
    root = Path(args.root).resolve()
    if not root.exists():
        print(f"scan error: root not found: {root}", file=sys.stderr)
        return 2
    all_findings = []
    for path in iter_files(root, args.include_local):
        try:
            all_findings.extend(scan_file(path, args.include_local))
        except Exception as e:
            print(f"scan error: {path}: {e}", file=sys.stderr)
            return 2
    # de-dupe
    uniq = []
    seen = set()
    for f in all_findings:
        if f not in seen:
            seen.add(f)
            uniq.append(f)
    if uniq:
        print("Secret scan findings (values redacted):")
        for rel, line, kind in uniq:
            print(f"  - {rel}:{line} [{kind}]")
        print(f"\n{len(uniq)} finding(s). Review and remediate before commit/deploy.")
        print("If a real key was exposed, rotate/revoke it at the provider and remove it from history/backups as appropriate.")
        return 1
    print("Secret scan: no findings.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
