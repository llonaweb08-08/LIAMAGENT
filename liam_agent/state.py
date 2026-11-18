from __future__ import annotations

import time

from ._compat import agent_mod
from .runtime import _log

# Mutable runtime state shared across modules and exposed on the agent facade.
# agent.py forwards reads and writes here, so these are the single source of
# truth for turn state (see PY-22/PY-47).
_HISTORY = {}
_LAST_TRACE = {}
_DEADLINE = None
_LAST_PROGRESS_AT = 0.0
_LAST_PROGRESS_TEXT = ""
_LAST_PROGRESS_EMIT_AT = 0.0
_PROGRESS_COUNT = 0
_EXHAUSTED = {}
_vps_browser_retry_at = 0.0
# BR-10: request id supplied by the bridge, echoed in every progress line.
_REQUEST_ID = None
# PY-31: per-turn stop context. Legacy stop_flag files only hold "0"/"1", so
# the turn records what it saw at start and watches for a later change.
_STOP_BASELINE = ("", 0.0)   # (file content, mtime_ns) at turn start
_STOP_TOKEN = None           # optional token supplied in the bridge payload


def _sync_deadline_from_agent():
    global _DEADLINE
    try:
        _DEADLINE = agent_mod()._DEADLINE
    except KeyError:
        # No facade module yet (standalone use): keep the local deadline.
        return
    except Exception as exc:
        _log(f"[state] deadline sync failed: {type(exc).__name__}: {exc}")


def _remaining_budget():
    """Seconds left in the current turn, or None when no turn is running."""
    _sync_deadline_from_agent()
    if _DEADLINE is None:
        return None
    return _DEADLINE - time.monotonic()


def _clamp_timeout(default):
    """Never let one tool outlive the turn budget.

    Once the deadline has passed the smallest legal timeout is returned; giving
    an expired turn two extra seconds only lets a dead tool linger.
    """
    value = float(default)
    left = _remaining_budget()
    if left is not None:
        if left <= 0:
            return 1.0
        value = min(value, left)
    return max(1.0, value)
