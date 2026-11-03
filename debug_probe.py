"""Probe the configured LLM providers without ever printing a key.

Usage:
    python debug_probe.py                 # probe every configured brain
    python debug_probe.py agnes hermes    # probe selected brains
    python debug_probe.py --json          # machine-readable output

This script reuses the production probe (``agent._probe``) so it cannot drift
away from the models and endpoints the agent really uses.
"""

from __future__ import annotations

import argparse
import json

import agent


def probe(name: str, timeout: float = 8.0) -> tuple[bool, str]:
    """Return (ok, reason) for one brain, trying each configured key in order."""
    brain = agent.BRAINS[name]
    reasons: list[str] = []
    for key in brain["keys"]:
        ok, why = agent._probe(brain["base"], brain["model"], key, timeout=timeout)
        if ok:
            return True, ""
        reasons.append(why or "unreachable")
    return False, reasons[0] if reasons else "no key configured"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Probe Liam's configured brain providers.")
    parser.add_argument("brains", nargs="*", help="brain names to probe (default: all)")
    parser.add_argument("--timeout", type=float, default=8.0, help="seconds per request (default: 8)")
    parser.add_argument("--json", action="store_true", dest="as_json", help="print JSON")
    args = parser.parse_args(argv)

    names = args.brains or list(agent.BRAINS)
    unknown = [name for name in names if name not in agent.BRAINS]
    if unknown:
        parser.error("unknown brain(s): " + ", ".join(unknown))

    results = {name: probe(name, args.timeout) for name in names}
    if args.as_json:
        print(json.dumps(
            {name: {"ok": ok, "reason": why} for name, (ok, why) in results.items()},
            indent=2,
        ))
    else:
        for name, (ok, why) in results.items():
            state = "OK" if ok else f"FAIL -> {why or 'unreachable'}"
            print(f"{name:12} {state}")
    return 0 if all(ok for ok, _ in results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
