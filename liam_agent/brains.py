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
from .runtime import BASE_DIR, DATA_DIR, _atomic_write_text, _env_int, _log

BRAIN_STATE = os.path.join(DATA_DIR, "brain_state")
LEGACY_BRAIN_STATE = os.path.join(BASE_DIR, ".brain_state")
PREFERRED_KEY_STATE = os.path.join(DATA_DIR, "preferred_keys.json")
# MoonMath's free daily allowance resets once a day. Once a key returns 402/429
# we flag it for a full day so the next turn skips it instead of burning the
# turn budget on a key that cannot answer. After 24h it becomes the first key
# tried again (the daily allowance has had time to reset).
QUOTA_COOLDOWN = 86400
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


def _probe(base, model, key, timeout=8, brain=None):
    """Lightweight reachability check.

    ``brain`` lets the caller honour the local quota cooldown, so a key that
    real generation would skip is not reported as usable just because the
    endpoint answers a tiny probe.
    """
    if not key:
        return False, "no key configured"
    a = agent_mod()
    if brain and a._key_exhausted(brain, key, model):
        return False, "quota cooling"
    try:
        req = urllib.request.Request(base.rstrip("/") + "/chat/completions",
            data=json.dumps({"model": model, "messages": [{"role": "user", "content": "ok"}]}).encode(),
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
        if brain and e.code in (402, 429):
            # A daily limit is a property of the key, not of one model. Mark
            # the whole key so probe and generation agree on when it is usable.
            a._mark_exhausted(brain, key, None, ttl=QUOTA_COOLDOWN)
            return False, "quota exhausted"
        return False, f"HTTP {e.code}"
    except Exception as e:
        return False, type(e).__name__


def check_status():
    """Report usable brains, not merely reachable endpoints.

    A key in quota cooldown must not be called alive. A timeout still means
    unreachable, but a 402/429 is reported as a quota problem so the owner
    does not get told the brain is fine while real calls fail.
    """
    a = agent_mod()
    def probe(name, key):
        p = a.BRAINS[name]
        # HCNSec needs ~30s to answer; an 8s probe reports a false timeout.
        timeout = a.ATTEMPT_TIMEOUT
        ok, why = a._probe(p["base"], p["model"], key, timeout=timeout, brain=name)
        return (name, ok, why)
    first = {name: (p["keys"][0] if p["keys"] else "") for name, p in a.BRAINS.items()}
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = {n: (ok, why) for n, ok, why in ex.map(lambda kv: probe(*kv), first.items())}
    retry = [(n, k) for n, p in a.BRAINS.items() if not results[n][0] for k in p["keys"][1:]]
    if retry:
        with ThreadPoolExecutor(max_workers=8) as ex:
            for n, ok, why in ex.map(lambda nk: probe(*nk), retry):
                if ok and not results[n][0]:
                    results[n] = (True, "")
                elif results[n][1] in ("", "quota cooling") and why:
                    results[n] = (False, why)
    parts = []
    for n, (ok, why) in results.items():
        label = a.BRAINS[n]["label"]
        if ok:
            parts.append(f"{label}: ✅ usable")
        elif why in ("quota cooling", "quota exhausted"):
            parts.append(f"{label}: ⚠️ {why}")
        else:
            parts.append(f"{label}: ❌ {why or 'unreachable'}")
    return " | ".join(parts)


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


def _mark_exhausted(brain, key, model=None, ttl=QUOTA_COOLDOWN):
    a = agent_mod()
    a._EXHAUSTED[_exhaust_key(brain, key, model)] = time.time() + max(30, float(ttl))
    while len(a._EXHAUSTED) > 2000:
        try:
            del a._EXHAUSTED[next(iter(a._EXHAUSTED))]
        except Exception:
            break


def _clear_exhausted(brain, key):
    """Forget every cooldown for one key (used when the owner re-checks it)."""
    a = agent_mod()
    for k in [k for k in a._EXHAUSTED if k[0] == str(brain) and k[1] == str(key or "")]:
        a._EXHAUSTED.pop(k, None)


def _load_preferred_keys():
    a = agent_mod()
    path = getattr(a, "PREFERRED_KEY_STATE", PREFERRED_KEY_STATE)
    try:
        with open(path, encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _get_preferred_key(brain):
    try:
        value = _load_preferred_keys().get(brain)
        return int(value) if value is not None and int(value) >= 0 else None
    except (TypeError, ValueError):
        return None


def _set_preferred_key(brain, index):
    a = agent_mod()
    index = int(index)
    data = _load_preferred_keys()
    data[str(brain)] = index
    path = getattr(a, "PREFERRED_KEY_STATE", PREFERRED_KEY_STATE)
    _atomic_write_text(path, json.dumps(data, sort_keys=True))
    return index


def check_key(brain=None, key=1, sender=None):
    """Owner-only: probe one key, and use it first going on if it answers.

    Keys are numbered from 1 in configuration order. Only the number and the
    reason are returned - the key value is never printed or logged. A key that
    answers has its 24h exhaustion flag cleared and becomes the preferred key
    for that brain. A key that fails is flagged for 24 hours so later turns
    skip it without paying the fallback delay again.
    """
    a = agent_mod()
    if not a._is_owner(sender):
        return "only the owner can check keys"
    name = a._normalize_brain(brain) or "moonmath"
    p = a.BRAINS.get(name)
    if not p:
        return f"unknown brain '{brain}'"
    keys = [k for k in p["keys"] if k]
    if not keys:
        return f"{name} has no configured keys"
    raw = str(key).strip().lower()
    if raw in ("all", "*", "every"):
        positions = list(range(len(keys)))
    else:
        try:
            number = int(raw)
        except (TypeError, ValueError):
            return f"give a key number from 1 to {len(keys)} (or 'all')"
        if number == 0:  # tolerate 0-based callers; key 1 is position 0
            number = 1
        if not 1 <= number <= len(keys):
            return f"{name} has {len(keys)} key(s); give a number from 1 to {len(keys)}"
        positions = [number - 1]
    timeout = a.ATTEMPT_TIMEOUT
    results = []
    for pos in positions:
        k = keys[pos]
        ok, why = a._probe(p["base"], p["model"], k, timeout=timeout)
        if ok:
            a._clear_exhausted(name, k)
            a._set_preferred_key(name, pos)
            results.append(f"key {pos + 1}: responding - using it first from now on")
        else:
            a._mark_exhausted(name, k, None, ttl=a.QUOTA_COOLDOWN)
            results.append(f"key {pos + 1}: not responding ({why or 'unreachable'}) "
                           "- flagged for 24 hours")
    return " | ".join(results)


ATTEMPT_TIMEOUT = 35
# One uniform attempt wait for every brain - there is no per-brain timeout.
# The budget must still fit three slow keys, then HCNSec, then Agnes, so it is
# larger than before to keep the last fallback reachable at 35s per attempt.
CALL_BUDGET = _env_int("LIAM_CALL_BUDGET", 210, 30, 900)
MAX_ATTEMPTS = 8
# No hidden provider default. Omitting max_tokens makes each provider apply its
# own small default, which cuts long replies off mid-sentence. This is a high
# ceiling rather than a reply length target; raise it with the env var if a
# provider needs more room.
MAX_OUTPUT_TOKENS = _env_int("LIAM_MAX_OUTPUT_TOKENS", 16384, 1, 131072)
# Requested chain: MoonMath keys 1-3, then HCNSec, then Agnes as the last resort.
FALLBACK_ORDER = ["moonmath", "hcn", "agnes"]
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
    payload = {"model": model, "messages": messages, "temperature": 0.5,
               "max_tokens": MAX_OUTPUT_TOKENS}
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


def _key_order(brain, keys):
    """Key positions in call order: the owner's checked key first, then 1,2,3.

    Exhausted keys are filtered later by _key_exhausted, so a key that is
    cooling down disappears from this plan without any network call. When its
    24h flag expires it automatically returns to the front of the plan again.
    """
    order = list(range(len(keys)))
    preferred = _get_preferred_key(brain)
    if preferred is not None and 0 <= preferred < len(keys):
        order.remove(preferred)
        order.insert(0, preferred)
    return order


def _attempt_plan(brain):
    a = agent_mod()
    p = a.BRAINS[brain]
    keys = [k for k in p["keys"] if k]
    if brain == "moonmath":
        # Keys are the rotation unit: key 1, then 2, then 3, each on the
        # primary model before any key is tried on a fallback model. Keeping
        # every key ahead of the fallback model stops a dead model from eating
        # the budget before key 2 and key 3 have been tried.
        order = _key_order(brain, keys)
        plan = []
        for model in (liam_keys.MOON_MODEL, liam_keys.MOON_FALLBACK):
            if not model:
                continue
            for i in order:
                k = keys[i]
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
        offset = _get_preferred_key(brain) or 0
        plan = []
        for i, m in enumerate(liam_keys.UNO_MODELS):
            key = keys[(offset + i) % len(keys)]
            if a._key_exhausted("unorouter", key, m):
                continue
            plan.append((brain, m, key))
        return plan
    return [(brain, p["model"], keys[i]) for i in _key_order(brain, keys)[:3]
            if not a._key_exhausted(brain, keys[i], p["model"])]


def call_model(messages, sender, brain=None, tools=None, budget=None):
    a = agent_mod()
    if _is_offline():
        return {"role": "assistant", "content": "offline test reply", "_brain": "offline"}
    brain = a._normalize_brain(brain) or a.get_brain()
    admin_only = a._is_admin(sender) and not a._is_owner(sender)
    if admin_only:
        # Agnes is still tried first for admins, but a failed attempt must be
        # allowed to fall through. Hard-pinning admins here is what turned one
        # bad agnes turn into FALLBACK_TEXT while other brains were healthy.
        brain = "agnes"
    order = [brain] + [b for b in FALLBACK_ORDER if b != brain]

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
                                       min(ATTEMPT_TIMEOUT, remaining))
                    out["_brain"] = b
                    out["_model"] = model
                    return out
                except urllib.error.HTTPError as e:
                    status = e.code
                    try: detail = e.read(200).decode("utf-8", "replace").replace("\n", " ")[:160]
                    except Exception: detail = ""
                    last_err = f"{b}/{model} HTTP {status}"
                    _log(f"[brain] {last_err} {detail}")
                    if status in (402, 429):
                        # Both mean "this key has no free allowance left".
                        # Flag the whole key for 24h so the next turn skips it
                        # with no network call instead of paying a fallback
                        # delay on every single message.
                        a._mark_exhausted(b, key, None, ttl=QUOTA_COOLDOWN)
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
