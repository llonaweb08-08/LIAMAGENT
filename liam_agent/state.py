from __future__ import annotations

from ._compat import agent_mod

# Mutable runtime state shared across modules and exposed on the agent facade.
_HISTORY = {}
_LAST_TRACE = {}
_DEADLINE = None
_LAST_PROGRESS_AT = 0.0
_LAST_PROGRESS_TEXT = ""
_LAST_PROGRESS_EMIT_AT = 0.0
_EXHAUSTED = {}
_vps_browser_retry_at = 0.0


def _sync_deadline_from_agent():
    global _DEADLINE
    try:
        _DEADLINE = agent_mod()._DEADLINE
    except Exception:
        pass


def _remaining_budget():
    """Seconds left in the current turn, or None when no turn is running."""
    _sync_deadline_from_agent()
    if _DEADLINE is None:
        return None
    import time
    return _DEADLINE - time.monotonic()


def _clamp_timeout(default):
    """Never let one tool outlive the turn budget."""
    value = float(default)
    left = _remaining_budget()
    if left is not None:
        value = min(value, max(2.0, left))
    return max(1.0, value)
