from __future__ import annotations

import json
import os
import socket
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import liam_keys

from ._compat import agent_mod
from .memory import _clean_reply
from .runtime import BASE_DIR, DATA_DIR, _atomic_write_text, _log

BRAIN_STATE = os.path.join(DATA_DIR, "brain_state")
LEGACY_BRAIN_STATE = os.path.join(BASE_DIR, ".brain_state")
BRAINS = {
    "moonmath":  {"base": liam_keys.MOON_BASE,  "model": liam_keys.MOON_MODEL,    "keys": list(liam_keys.MOON_KEYS), "label": "MoonMath DeepSeek"},
    "unorouter": {"base": liam_keys.UNO_BASE,   "model": liam_keys.UNO_MODELS[0], "keys": list(liam_keys.UNO_KEYS),  "label": "Unorouter"},
    "agnes":     {"base": liam_keys.AGNES_BASE, "model": liam_keys.AGNES_MODEL,   "keys": [liam_keys.AGNES_KEY],     "label": "Agnes"},
    "hcn":       {"base": liam_keys.HCN_BASE,   "model": liam_keys.HCN_MODEL,     "keys": [liam_keys.HCN_KEY],       "label": "HCNSec DeepSeek"},
}
_BRAIN_ALIASES = {
    "moonmath": "moonmath", "moon": "moonmath", "deepseek": "moonmath", "deepseek v4": "moonmath",
    "agnes": "agnes", "ag": "agnes", "agnes 3": "agnes",
    "unorouter": "unorouter", "uno": "unorouter", "router": "unorouter",
    "hcn": "hcn", "hcnsec": "hcn", "hcn sec": "hcn",
    "huggingface": "hcn", "hugging face": "hcn", "hf": "hcn",
    "hermes": "hcn", "8b": "hcn", "qwen": "hcn",
}


def _normalize_brain(value):
    s = str(value or "").strip().lower().replace("_", " ").replace("-", " ")
    s = " ".join(s.split())
    return _BRAIN_ALIASES.get(s) or (s if s in BRAINS else None)


def get_brain():
    raw = ""
    for path in (BRAIN_STATE, LEGACY_BRAIN_STATE):
        try:
            with open(path, encoding="utf-8") as handle:
                raw = handle.read().strip()
            break
        except OSError:
            continue
    return _normalize_brain(raw) or "moonmath"


def set_brain(brain):
    b = _normalize_brain(brain)
    if not b:
        raise ValueError(f"unknown brain: {brain}")
    _atomic_write_text(BRAIN_STATE, b)
    return b


def switch_brain(brain, sender=None):
    a = agent_mod()
    if not a._is_owner(sender):
        return "only the owner can switch brains"
    try:
        b = set_brain(brain)
    except ValueError:
        return f"unknown brain '{brain}' - pick moonmath, unorouter, agnes or hcn"
    return f"switched to {b}"


def _probe(base, model, key, timeout=8):
    if not key:
        return False, "no key configured"
    try:
        req = urllib.request.Request(base.rstrip("/") + "/chat/completions",
            data=json.dumps({"model": model, "messages": [{"role": "user", "content": "ok"}], "max_tokens": 5}).encode(),
            headers={
                "Authorization": "Bearer " + key,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": liam_keys.BROWSER_UA,
            })
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = json.loads(r.read() or b"{}")
        if isinstance(body, dict) and body.get("error"):
            return False, "provider error"
        if not isinstance(body, dict) or not body.get("choices"):
            return False, "no choices"
        return True, ""
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:
        return False, type(e).__name__


def check_status():
    a = agent_mod()
    def probe(name, key):
        p = a.BRAINS[name]
        return (name,) + a._probe(p["base"], p["model"], key)
    first = {name: (p["keys"][0] if p["keys"] else "") for name, p in a.BRAINS.items()}
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = {n: (ok, why) for n, ok, why in ex.map(lambda kv: probe(*kv), first.items())}
    retry = [(n, k) for n, p in a.BRAINS.items() if not results[n][0] for k in p["keys"][1:]]
    if retry:
        with ThreadPoolExecutor(max_workers=8) as ex:
            for n, ok, _why in ex.map(lambda nk: probe(*nk), retry):
                if ok and not results[n][0]:
                    results[n] = (True, "")
    return " | ".join(
        f"{a.BRAINS[n]['label']}: " + ("✅" if ok else f"❌ {why or 'unreachable'}")
        for n, (ok, why) in results.items())


def check_tokens():
    a = agent_mod()
    lines = [f"Current brain: {get_brain()} ({a.BRAINS[get_brain()]['model']})",
             "Provider quotas are not exposed to this agent, so exact remaining requests are unknown."]
    for name, p in a.BRAINS.items():
        lines.append(f"- {p['label']}: {len([k for k in p['keys'] if k])} configured key slot(s), model {p['model']}")
    return "\n".join(lines)


def _exhaust_key(brain, key, model=None):
    return (str(brain), str(key or ""), str(model or ""))


def _exhausted_at(brain, key, model=None):
    a = agent_mod()
    k = _exhaust_key(brain, key, model)
    expiry = a._EXHAUSTED.get(k)
    if not expiry:
        return False
    if time.time() > expiry:
        a._EXHAUSTED.pop(k, None)
        return False
    return True


def _key_exhausted(brain, key, model=None):
    if _exhausted_at(brain, key, model):
        return True
    return model is not None and _exhausted_at(brain, key, None)


def _mark_exhausted(brain, key, model=None, ttl=86400):
    a = agent_mod()
    a._EXHAUSTED[_exhaust_key(brain, key, model)] = time.time() + max(30, float(ttl))
    while len(a._EXHAUSTED) > 2000:
        try:
            del a._EXHAUSTED[next(iter(a._EXHAUSTED))]
        except Exception:
            break


ATTEMPT_TIMEOUT = 35
CALL_BUDGET = 70
MAX_ATTEMPTS = 8
FALLBACK_ORDER = ["moonmath", "agnes", "hcn"]
BRAIN_TIMEOUT = {"moonmath": 20, "agnes": 30, "hcn": 20}
OFFLINE = os.environ.get("LIAM_OFFLINE") == "1"


def _is_offline():
    try:
        return bool(agent_mod().OFFLINE)
    except Exception:
        return OFFLINE


def _is_transient(status):
    return status is None or status in (408, 409, 425, 429, 500, 502, 503, 504)


def _normalize_message(m):
    """Return a clean assistant message; content is always a string, never None."""
    content = m.get("content")
    if content is None:
        content = ""
    elif not isinstance(content, str):
        content = json.dumps(content, ensure_ascii=False)
    content = _clean_reply(content)
    out = {"role": "assistant", "content": content}
    calls = m.get("tool_calls")
    if isinstance(calls, list) and calls:
        norm = []
        for i, tc in enumerate(calls):
            if not isinstance(tc, dict):
                continue
            fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
            name = str(fn.get("name") or "").strip()
            if not name:
                continue
            raw = fn.get("arguments")
            if isinstance(raw, dict):
                raw = json.dumps(raw, ensure_ascii=False)
            elif raw is None:
                raw = ""
            else:
                raw = str(raw)
            norm.append({
                "id": str(tc.get("id") or f"call_{i}_{int(time.time() * 1000)}"),
                "type": "function",
                "function": {"name": name, "arguments": raw},
            })
        if norm:
            out["tool_calls"] = norm
    return out


def _http_post(base, model, key, messages, tools, timeout):
    payload = {"model": model, "messages": messages, "temperature": 0.5, "max_tokens": 1200}
    if tools:
        payload["tools"] = tools
    req = urllib.request.Request(
        base + "/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": liam_keys.BROWSER_UA,
            "HTTP-Referer": "https://liam.local",
            "X-Title": "Liam",
        })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = json.loads(r.read().decode("utf-8", "replace"))
    choices = body.get("choices") or []
    if not choices or not isinstance(choices[0].get("message"), dict):
        raise ValueError("provider returned no message")
    return _normalize_message(choices[0]["message"])


def _attempt_plan(brain):
    a = agent_mod()
    p = a.BRAINS[brain]
    keys = [k for k in p["keys"] if k]
    if brain == "moonmath":
        plan = []
        for model in (liam_keys.MOON_MODEL, liam_keys.MOON_FALLBACK):
            if not model:
                continue
            for k in keys:
                if a._key_exhausted("moonmath", k, model):
                    continue
                plan.append(("moonmath", model, k))
        seen = set(); out = []
        for item in plan:
            if item in seen: continue
            seen.add(item); out.append(item)
        return out
    if brain == "unorouter":
        if not keys:
            return []
        plan = []
        for i, m in enumerate(liam_keys.UNO_MODELS):
            key = keys[i % len(keys)] if keys else ""
            if a._key_exhausted("unorouter", key, m):
                continue
            plan.append((brain, m, key))
        return plan
    return [(brain, p["model"], k) for k in keys[:3]
            if not a._key_exhausted(brain, k, p["model"])]


def call_model(messages, sender, brain=None, tools=None, budget=None):
    a = agent_mod()
    if _is_offline():
        return {"role": "assistant", "content": "offline test reply", "_brain": "offline"}
    brain = a._normalize_brain(brain) or a.get_brain()
    admin_only = a._is_admin(sender) and not a._is_owner(sender)
    if admin_only:
        brain = "agnes"
    order = [brain] if admin_only else [brain] + [b for b in FALLBACK_ORDER if b != brain]

    seconds = CALL_BUDGET if not budget else max(3, min(CALL_BUDGET, float(budget)))
    deadline = time.monotonic() + seconds
    attempts = 0
    last_err = "no provider attempted"

    for name in order:
        for b, model, key in a._attempt_plan(name):
            if attempts >= MAX_ATTEMPTS or time.monotonic() >= deadline - 1:
                break
            attempts += 1
            use_tools = bool(tools)
            for retry in (0, 1):
                remaining = deadline - time.monotonic()
                if remaining <= 1:
                    break
                try:
                    out = a._http_post(a.BRAINS[b]["base"].rstrip("/"), model, key, messages,
                                       tools if use_tools else None,
                                       min(BRAIN_TIMEOUT.get(b, ATTEMPT_TIMEOUT), remaining))
                    out["_brain"] = b
                    out["_model"] = model
                    return out
                except urllib.error.HTTPError as e:
                    status = e.code
                    try: detail = e.read(200).decode("utf-8", "replace").replace("\n", " ")[:160]
                    except Exception: detail = ""
                    last_err = f"{b}/{model} HTTP {status}"
                    _log(f"[brain] {last_err} {detail}")
                    if status == 429:
                        a._mark_exhausted(b, key, model)
                        if b == "unorouter":
                            a._mark_exhausted(b, key, None)
                        break
                    elif status == 402:
                        a._mark_exhausted(b, key, model, ttl=1800)
                        break
                    if status == 400 and use_tools:
                        use_tools = False
                        continue
                    if _is_transient(status) and retry == 0 and deadline - time.monotonic() > 3:
                        time.sleep(0.8)
                        continue
                    break
                except Exception as e:
                    last_err = f"{b}/{model} {type(e).__name__}: {str(e)[:80]}"
                    _log(f"[brain] {last_err}")
                    timed_out = isinstance(e, (socket.timeout, TimeoutError))
                    if not timed_out and retry == 0 and deadline - time.monotonic() > 3:
                        time.sleep(0.5)
                        continue
                    break
        if attempts >= MAX_ATTEMPTS or time.monotonic() >= deadline - 1:
            break

    _log(f"[brain] all providers failed ({last_err})")
    return {"role": "assistant", "content": a.FALLBACK_TEXT, "_brain": "none"}
