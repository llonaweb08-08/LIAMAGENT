from __future__ import annotations

import os
import sys
import tempfile

# The bridge pipes stdio; without this Windows falls back to cp1252 and any
# emoji in a message or reply kills the process.
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("LIAM_DATA_DIR") or os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "LiamWhatsApp")
OUTBOX_DIR = os.path.join(DATA_DIR, "outbox")
for _directory in (DATA_DIR, OUTBOX_DIR):
    try:
        os.makedirs(_directory, exist_ok=True)
        os.chmod(_directory, 0o700)
    except OSError:
        pass


def _log(msg):
    """Diagnostics go to stderr; stdout is reserved for the JSON bridge protocol."""
    try:
        print(str(msg), file=sys.stderr, flush=True)
    except Exception:
        pass


def _safe_remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def _unique_file(suffix: str) -> str:
    fd, path = tempfile.mkstemp(prefix="liam_", suffix=suffix, dir=OUTBOX_DIR)
    os.close(fd)
    return path


def _env_int(name, default, low=None, high=None):
    """Read an integer env var, clamping it into a safe range."""
    try:
        value = int(os.environ.get(name, default))
    except (TypeError, ValueError):
        value = int(default)
    if low is not None:
        value = max(int(low), value)
    if high is not None:
        value = min(int(high), value)
    return value


def _atomic_write_text(path: str, value: str, mode: int = 0o600) -> None:
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".liam_", dir=directory, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(temporary, mode)
        except OSError:
            pass
        os.replace(temporary, path)
    finally:
        _safe_remove(temporary)


TOOL_RESULT_MAX = 8000
FILE_READ_MAX = 20000
SHELL_OUTPUT_MAX = 4000
MAX_STEPS = 200           # assistant turns per request (the turn budget is the real cap)
MAX_TOOL_CALLS = 500      # tool executions per request (the turn budget is the real cap)
HISTORY_TURNS = 5     # user/assistant pairs of short-term memory per chat
HISTORY_MESSAGES = HISTORY_TURNS * 2
