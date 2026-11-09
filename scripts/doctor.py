#!/usr/bin/env python3
"""Check a Liam install or deployment without printing any secret values.

Examples:
    python scripts/doctor.py
    python scripts/doctor.py --deploy
    python scripts/doctor.py --url https://liam-whatsapp-agent.onrender.com
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import liam_keys  # noqa: E402


def _flag(value: str) -> str:
    return "set" if str(value or "").strip() else "missing"


def _data_dir() -> Path:
    override = os.environ.get("LIAM_DATA_DIR")
    if override:
        return Path(override)
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "LiamWhatsApp"
    return Path.home() / "LiamWhatsApp"


def _db_path() -> Path:
    override = os.environ.get("LIAM_DB")
    return Path(override) if override else ROOT / "liam_memory.db"


def _node_version() -> str:
    node = shutil.which("node")
    if not node:
        return "node not found"
    try:
        return subprocess.run([node, "--version"], capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        return "node version check failed"


def _check_db(path: Path, errors: list[str], warnings: list[str]) -> None:
    if not path.exists():
        warnings.append(f"memory database does not exist yet: {path}")
        return
    try:
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
            status = conn.execute("PRAGMA integrity_check").fetchone()
        if status and status[0] == "ok":
            print(f"  memory db: ok ({path})")
        else:
            errors.append(f"memory database failed integrity_check: {path}")
    except sqlite3.Error as exc:
        errors.append(f"memory database is unreadable ({path}): {exc}")


def _check_health(base: str) -> bool:
    base = base.rstrip("/")
    for path in ("/health", "/ready"):
        try:
            request = urllib.request.Request(base + path, headers={"User-Agent": "liam-doctor"})
            with urllib.request.urlopen(request, timeout=15) as response:
                body = response.read(4000).decode("utf-8", "replace")
                print(f"  {path}: HTTP {response.status} {body[:300]}")
        except Exception as exc:
            print(f"  {path}: unreachable ({type(exc).__name__})")
            if path == "/health":
                return False
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Diagnose a Liam install or deployment.")
    parser.add_argument("--deploy", action="store_true",
                        help="treat missing Supabase persistence as an error")
    parser.add_argument("--url", default=os.environ.get("LIAM_PUBLIC_URL", ""),
                        help="also probe an HTTP deployment (for example https://...onrender.com)")
    args = parser.parse_args(argv)

    errors: list[str] = []
    warnings: list[str] = []

    print("Liam doctor")
    print(f"  repository: {ROOT}")
    print(f"  python: {sys.version.split()[0]}")
    print(f"  node: {_node_version()}")

    try:
        config = json.loads((ROOT / "liam_config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        errors.append(f"liam_config.json is missing or invalid: {exc}")
        config = {}
    owners = [str(v).strip() for v in (config.get("owners") or []) if str(v).strip()]
    admins = config.get("admins") or {}
    if not owners:
        errors.append("liam_config.json has no owners")
    print(f"  owners: {len(owners)} | admins: {len(admins)}")

    data_dir = _data_dir()
    session = data_dir / "liam_session" / "session"
    markers = [
        session / "Default" / "Preferences",
        session / "Default" / "Local Storage" / "leveldb",
        session / "Default" / "IndexedDB",
        session / "Local State",
    ]
    has_session = any(path.exists() for path in markers)
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        probe = data_dir / ".doctor-write-test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        writable = True
    except OSError:
        writable = False
        errors.append(f"data directory is not writable: {data_dir}")
    print(f"  data dir: {data_dir}")
    print(f"  whatsapp profile: {'found' if has_session else 'missing'} | writable: {writable}")
    if not has_session:
        warnings.append("no saved WhatsApp profile: pair with /qr or /pair after deploying")

    _check_db(_db_path(), errors, warnings)

    providers = {
        "MoonMath keys": len([k for k in liam_keys.MOON_KEYS if k]),
        "Unorouter keys": len([k for k in liam_keys.UNO_KEYS if k]),
        "Agnes key": 1 if liam_keys.AGNES_KEY else 0,
        "HCN key": 1 if liam_keys.HCN_KEY else 0,
    }
    print("  model providers: " + ", ".join(f"{name}={count}" for name, count in providers.items()))
    configured = [name for name, count in providers.items() if count]
    if not configured:
        errors.append("no model provider key is configured")

    print(f"  google image/voice: {_flag(liam_keys.GOOGLE_API_KEY)}")
    search = {
        "Tavily": liam_keys.TAVILY_API_KEY,
        "Brave": liam_keys.BRAVE_API_KEY,
        "Serper": liam_keys.SERPER_API_KEY,
    }
    print("  search providers: " + ", ".join(f"{name}={_flag(key)}" for name, key in search.items())
          + " | DuckDuckGo fallback always available")

    supabase = _flag(os.environ.get("SUPABASE_URL")) + "/" + _flag(os.environ.get("SUPABASE_SECRET_KEY"))
    print(f"  supabase persistence: {supabase}")
    if supabase != "set/set":
        message = "Supabase is not configured: Render will lose the WhatsApp session on restart"
        (errors if args.deploy else warnings).append(message)

    instabox = _flag(os.environ.get("INSTABOX_API_KEY")) + "/" + _flag(os.environ.get("INSTABOX_MACHINE_ID"))
    print(f"  instabox shell: {instabox}")

    playwright = importlib.util.find_spec("playwright")
    print(f"  playwright: {'installed' if playwright else 'missing'}")
    if not playwright:
        warnings.append("Playwright is missing; screenshots and browser tasks will fail")

    if args.url:
        print(f"  deployment probe: {args.url}")
        if not _check_health(args.url):
            errors.append(f"deployment /health is unreachable: {args.url}")

    if warnings:
        print("\nWarnings:")
        for warning in warnings:
            print(f"  - {warning}")
    if errors:
        print("\nErrors:")
        for error in errors:
            print(f"  - {error}")
        return 1
    print("\nNo blocking problems found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
