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
import contextlib
import io
import json
import os

import agent


def probe_key(brain: str, key: str, timeout: float) -> tuple[bool, str]:
    """Return (ok, reason) for one key of one brain."""
    p = agent.BRAINS[brain]
    return agent._probe(p["base"], p["model"], key, timeout=timeout)


def probe(name: str, timeout: float = 8.0) -> tuple[bool, str]:
    """Return (ok, reason) for one brain, reporting every failed key by index."""
    brain = agent.BRAINS[name]
    reasons: list[str] = []
    for index, key in enumerate(brain["keys"]):
        if not key:
            reasons.append(f"key[{index}]: empty slot")
            continue
        ok, why = probe_key(name, key, timeout)
        if ok:
            return True, ""
        reasons.append(f"key[{index}]: {why or 'unreachable'}")
    return False, "; ".join(reasons) if reasons else "no key configured"


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
    parser.add_argument("--browser", metavar="URL",
                        help="run the real browser_task tool against URL and print JSON")
    parser.add_argument("--voice", metavar="TEXT", nargs="?",
                        const="Liam here. Voice notes are working.",
                        help="synthesize a voice note with the free engine and print JSON")
    args = parser.parse_args(argv)

    if args.voice is not None:
        # Exercise the real voice engine (edge-tts -> ffmpeg) without sending a
        # WhatsApp message. The temporary audio is deleted before we return.
        import liam_voice
        result = {"ok": True, "voice": liam_voice.describe()}
        path = ""
        try:
            path, mime = liam_voice.synth(args.voice)
            result["mimetype"] = mime
            result["bytes"] = os.path.getsize(path)
        except Exception as e:
            result["ok"] = False
            result["error"] = f"{type(e).__name__}: {e}"
        finally:
            if path:
                try:
                    os.remove(path)
                except OSError:
                    pass
        print(json.dumps(result))
        return 0 if result["ok"] else 1

    if args.browser:
        # Exercise the production browser tool exactly as a chat turn would,
        # including any VM offload. Capture stray prints so stdout stays JSON.
        script = (
            "page.goto(%r)\n"
            "print('TITLE', page.title())\n"
            "print('URL', page.url)\n" % args.browser
        )
        buffer = io.StringIO()
        try:
            with contextlib.redirect_stdout(buffer):
                out = agent.browser_task(script)
            print(json.dumps({"ok": True, "out": str(out)[:2000]}))
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        return 0

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
