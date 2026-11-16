from __future__ import annotations

import json
import os

from .runtime import BASE_DIR


def _norm_user(user):
    """One canonical key per person: 2347…@c.us, 2347…:12 and 2347… all match."""
    s = str(user or "").strip()
    if "@" in s:
        s = s.split("@", 1)[0]
    if ":" in s:
        s = s.split(":", 1)[0]
    s = s.strip()
    return s if s.isdigit() else s.lower()


from ._compat import agent_mod

CONFIG_PATH = os.path.join(BASE_DIR, "liam_config.json")


def _load_people():
    """Owners and admins live in one JSON file shared with the Node bridge."""
    try:
        path = getattr(agent_mod(), "CONFIG_PATH", CONFIG_PATH)
    except Exception:
        path = CONFIG_PATH
    try:
        with open(path, encoding="utf-8") as handle:
            config = json.load(handle)
    except (OSError, ValueError) as exc:
        raise RuntimeError(f"liam_config.json is missing or invalid: {exc}") from exc
    owners = []
    for value in config.get("owners") or []:
        phone = _norm_user(value)
        if phone.isdigit():
            owners.append(phone)
    admins = {}
    for value, info in (config.get("admins") or {}).items():
        phone = _norm_user(value)
        if not phone.isdigit() or not isinstance(info, dict):
            continue
        calls = [str(name) for name in (info.get("she_calls") or []) if str(name).strip()]
        admins[phone] = {
            "name": str(info.get("name") or phone),
            "is": str(info.get("is") or "a friend"),
            "she_calls": calls or ["you"],
        }
    if not owners:
        raise RuntimeError("liam_config.json must list at least one owner")
    return owners, admins


OWNERS, ADMS = _load_people()
PETNAMES = ["baby", "babe", "darling", "my love", "honey", "sweetheart", "my king"]


def _is_owner(sender: object) -> bool:
    return _norm_user(sender) in OWNERS


def _is_admin(sender: object) -> bool:
    return _norm_user(sender) in ADMS


def _resolve_memory_user(value: object, sender: object) -> str:
    """Map what the model calls a person onto the phone number memory is keyed by."""
    s = _norm_user(value)
    if s.isdigit():
        return s
    if s in ("", "me", "myself", "owner", "the owner", "him"):
        return _norm_user(sender)
    if s in PETNAMES:
        return _norm_user(sender)
    for phone, info in ADMS.items():
        names = {_norm_user(info["name"]), _norm_user(info["is"])}
        names |= {_norm_user(n) for n in info["she_calls"]}
        if s in names:
            return phone
    return _norm_user(sender)


def _person_phone(value: object) -> str:
    """Turn a person's name (as the owner says it) into their WhatsApp number.

    Without this, "DM Temi" hands the literal word "Temi" to WhatsApp, which
    cannot deliver it - Liam looked like she did not have Temi's number."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    digits = "".join(ch for ch in raw if ch.isdigit())
    if digits and len(digits) >= 7 and not any(ch.isalpha() for ch in raw):
        return digits
    s = _norm_user(raw)
    for phone, info in ADMS.items():
        names = {_norm_user(info.get("name")), _norm_user(info.get("is"))}
        names |= {_norm_user(n) for n in (info.get("she_calls") or [])}
        if s in names:
            return phone
    return ""


def _people_block(sender_is_owner: bool) -> str:
    """Tell the owner's Liam the numbers of the people she is allowed to DM.

    Only the owner sees this: send_dm and the other send tools are owner-only,
    and phone numbers must never be shown to members."""
    if not sender_is_owner:
        return ""
    lines = ["", "PEOPLE YOU KNOW (their WhatsApp numbers, for send_dm only - never show a number to anyone, ever):"]
    for phone, info in ADMS.items():
        lines.append(f"- {info.get('name')} ({info.get('is')}) is {phone}")
    lines.append("- the owner is the person you are already talking to")
    return "\n".join(lines)
