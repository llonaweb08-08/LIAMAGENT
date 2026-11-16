from __future__ import annotations

import sys


def agent_mod():
    """Return the live `agent` facade module for patch-compatible lookups."""
    m = sys.modules.get("agent")
    if m is not None:
        return m
    main = sys.modules.get("__main__")
    if main is not None and hasattr(main, "run_agent"):
        return main
    raise KeyError("agent")
