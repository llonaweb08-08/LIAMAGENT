"""Probe the configured LLM providers without ever printing a key.

Usage:
    python debug_probe.py                 # probe every configured brain
    python debug_probe.py agnes hcn       # probe selected brains
    python debug_probe.py --keys          # per-key detail (index + reason only)
    python debug_probe.py moonmath --keys --json

This script reuses the production probe (``agent._probe``) so it cannot drift
away from the models and endpoints the agent really uses. Key *values* are never
printed - only their position (0, 1, 2 ...) and whether each one answered.
"""

from __future__ import annotations

import argparse
import json

import agent


def probe_key(brain: str, key: str, timeout: float) -> tuple[bool, str]:
    """Return (ok, reason) for one key of one brain."""
    p = agent.BRAINS[brain]
    return agent._probe(p["base"], p["model"], key, timeout=timeout)


def probe(name: str, timeout: float = 8.0) -> tuple[bool, str]:
    """Return (ok, reason) for one brain, trying each configured key in order."""
    brain = agent.BRAINS[name]
    reasons: list[str] = []
    for key in brain["keys"]:
        ok, why = probe_key(name, key, timeout)
        if ok:
            return True, ""
        reasons.append(why or "unreachable")
    return False, reasons[0] if reasons else "no key configured"


def per_key(name: str, timeout: float = 8.0) -> list[dict]:
    """Return one row per configured key: index + ok/reason, never the key."""
    rows = []
    for index, key in enumerate(agent.BRAINS[name]["keys"]):
        if not key:
            rows.append({"index": index, "ok": False, "reason": "empty slot"})
            continue
        ok, why = probe_key(name, key, timeout)
        rows.append({"index": index, "ok": ok, "reason": "" if ok else (why or "unreachable")})
    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Probe Liam's configured brain providers.")
    parser.add_argument("brains", nargs="*", help="brain names to probe (default: all)")
    parser.add_argument("--timeout", type=float, default=8.0, help="seconds per request (default: 8)")
    parser.add_argument("--keys", action="store_true",
                        help="report each configured key separately (index + reason only)")
    parser.add_argument("--json", action="store_true", dest="as_json", help="print JSON")
    args = parser.parse_args(argv)

    names = args.brains or list(agent.BRAINS)
    unknown = [name for name in names if name not in agent.BRAINS]
    if unknown:
        parser.error("unknown brain(s): " + ", ".join(unknown))

    if args.keys:
        detail = {name: per_key(name, args.timeout) for name in names}
        if args.as_json:
            print(json.dumps(
                {name: {"ok": any(r["ok"] for r in rows), "keys": rows}
                 for name, rows in detail.items()},
                indent=2,
            ))
        else:
            for name, rows in detail.items():
                print(f"{name}:")
                for row in rows:
                    state = "OK" if row["ok"] else f"FAIL -> {row['reason']}"
                    print(f"  key[{row['index']}] {state}")
        return 0 if all(any(r["ok"] for r in rows) for rows in detail.values()) else 1

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
