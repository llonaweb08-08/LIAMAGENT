from __future__ import annotations

import os
import re
import sqlite3
import time
from contextlib import closing

from .runtime import BASE_DIR, _log
from .people import _norm_user

# ---------------- memory / SQLite ----------------
DB = os.environ.get("LIAM_DB") or os.path.join(BASE_DIR, "liam_memory.db")
_SCHEMA = """CREATE TABLE IF NOT EXISTS mem(
    user TEXT NOT NULL,
    fact TEXT NOT NULL,
    created REAL NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT 'personal',
    UNIQUE(user, fact, scope)
)"""

_HISTORY_SCHEMA = """CREATE TABLE IF NOT EXISTS chat_history(
    chat TEXT PRIMARY KEY,
    messages TEXT NOT NULL DEFAULT '[]',
    updated REAL NOT NULL DEFAULT 0
)"""


def _connect():
    c = sqlite3.connect(DB, timeout=10)
    c.execute("PRAGMA busy_timeout=10000")
    return c


def _init_db():
    with closing(_connect()) as c:
        try:
            c.execute("PRAGMA journal_mode=WAL")
        except sqlite3.Error:
            pass
        c.execute(_SCHEMA)
        c.execute(_HISTORY_SCHEMA)
        cols = {r[1] for r in c.execute("PRAGMA table_info(mem)")}
        if "created" not in cols:
            c.execute("ALTER TABLE mem ADD COLUMN created REAL NOT NULL DEFAULT 0")
        if "source" not in cols:
            c.execute("ALTER TABLE mem ADD COLUMN source TEXT NOT NULL DEFAULT ''")
        if "scope" not in cols:
            c.execute("ALTER TABLE mem ADD COLUMN scope TEXT NOT NULL DEFAULT 'personal'")
        c.commit()


_init_db()


def _clean_fact(fact, limit=500):
    s = "".join(ch for ch in str(fact or "") if ch.isprintable() or ch in "\n\t")
    return " ".join(s.split())[:limit]


_THINK_RE = re.compile(r"<(?:think(?:ing)?|reasoning|analysis|scratchpad|thought)>.*?</(?:think(?:ing)?|reasoning|analysis|scratchpad|thought)>", re.S | re.I)
_THINK_TAG_RE = re.compile(r"</?(?:think(?:ing)?|reasoning|analysis|scratchpad|thought)>", re.I)
_THINK_UNCLOSED_RE = re.compile(r"<(?:think(?:ing)?|reasoning|analysis|scratchpad|thought)>.*", re.S | re.I)


def _clean_reply(text):
    """Strip provider reasoning leakage (some models emit <think>...)."""
    text = _THINK_RE.sub("", str(text or ""))
    text = _THINK_UNCLOSED_RE.sub("", text)
    text = _THINK_TAG_RE.sub("", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _facts(user, group="", limit=20):
    """Newest facts for one user, plus global and current-group facts.

    ``None`` means the database itself failed. Group facts are stored under a
    synthetic ``group:<jid>`` scope so they never leak into other groups or DMs.
    """
    group_scope = f"group:{group}" if group else ""
    try:
        with closing(_connect()) as c:
            if group_scope:
                rows = c.execute(
                    "SELECT fact FROM mem WHERE user=? OR scope='global' OR scope=? "
                    "ORDER BY created DESC, rowid DESC LIMIT ?",
                    (_norm_user(user), group_scope, limit)).fetchall()
            else:
                rows = c.execute(
                    "SELECT fact FROM mem WHERE user=? OR scope='global' "
                    "ORDER BY created DESC, rowid DESC LIMIT ?",
                    (_norm_user(user), limit)).fetchall()
        out, seen = [], set()
        for row in rows:
            if row[0] not in seen:
                seen.add(row[0])
                out.append(row[0])
        return out
    except sqlite3.Error as e:
        _log(f"[memory] read failed: {e}")
        return None


def remember(user, fact, source="", scope="personal"):
    user = _norm_user(user)
    fact = _clean_fact(fact)
    if not user or not fact:
        return "nothing to remember - I need both a person and a fact"
    scope = str(scope or "personal").strip() or "personal"
    if scope not in ("personal", "global") and not scope.startswith("group:"):
        scope = "personal"
    try:
        with closing(_connect()) as c:
            cur = c.execute(
                "INSERT OR IGNORE INTO mem(user,fact,created,source,scope) VALUES(?,?,?,?,?)",
                (user, fact, time.time(), _clean_fact(source, 80), scope))
            c.commit()
            added = cur.rowcount > 0
    except sqlite3.Error as e:
        _log(f"[memory] write failed: {e}")
        return "couldn't save that - memory is unavailable right now"
    return f"remembered: {fact}" if added else f"already remembered: {fact}"


def recall(user, group=""):
    facts = _facts(user, group)
    if facts is None:
        return "memory is unavailable right now"
    return "nothing saved yet" if not facts else "you remember: " + " | ".join(facts)


def recall_all(sender=None, group=""):
    from ._compat import agent_mod
    owner = agent_mod()._is_owner(sender)
    group_scope = f"group:{group}" if group else ""
    try:
        with closing(_connect()) as c:
            if owner:
                rows = c.execute(
                    "SELECT user,fact FROM mem ORDER BY user, created DESC, rowid DESC").fetchall()
            elif group_scope:
                rows = c.execute(
                    "SELECT user,fact FROM mem WHERE user=? OR scope='global' OR scope=? "
                    "ORDER BY created DESC, rowid DESC",
                    (_norm_user(sender), group_scope)).fetchall()
            else:
                rows = c.execute(
                    "SELECT user,fact FROM mem WHERE user=? OR scope='global' "
                    "ORDER BY created DESC, rowid DESC",
                    (_norm_user(sender),)).fetchall()
    except sqlite3.Error as e:
        _log(f"[memory] read failed: {e}")
        return "memory is unavailable right now"
    if not rows:
        return "nothing saved yet"
    if not owner:
        out, seen = [], set()
        for _user, fact in rows:
            if fact not in seen:
                seen.add(fact)
                out.append(fact)
        return "everything you remember:\n- " + "\n- ".join(out)
    out, current = [], None
    for user, fact in rows:
        if user != current:
            out.append(f"[{user}]")
            current = user
        out.append(f"- {fact}")
    return "everything you remember:\n" + "\n".join(out)


def clear_memory(user=None, sender=None):
    from ._compat import agent_mod
    owner = agent_mod()._is_owner(sender)
    target = str(user or "").strip()
    if target.lower() in ("me", "myself", "owner", "the owner", "him"):
        target = _norm_user(sender)
    if not owner and not _norm_user(sender):
        return "I couldn't confirm who you are, so I didn't wipe anything"
    try:
        with closing(_connect()) as c:
            if target.upper() in ("", "ALL", "*", "EVERYONE"):
                if not owner:
                    cur = c.execute("DELETE FROM mem WHERE user=?", (_norm_user(sender),))
                    c.commit()
                    return (f"wiped your memory ({cur.rowcount} facts)" if cur.rowcount
                            else "you had nothing saved")
                if not target:
                    return "say which person, or pass user='ALL' to wipe everyone"
                cur = c.execute("DELETE FROM mem")
                c.execute("DELETE FROM chat_history")
                c.commit()
                return (f"wiped everyone's memory ({cur.rowcount} facts)" if cur.rowcount
                        else "memory was already empty")
            target = _norm_user(target)
            if not owner and target != _norm_user(sender):
                return "you can only clear your own memory"
            cur = c.execute("DELETE FROM mem WHERE user=?", (target,))
            c.execute("DELETE FROM chat_history WHERE chat=?", (target,))
            c.commit()
            return (f"memory wiped for {target} ({cur.rowcount} facts)" if cur.rowcount
                    else f"nothing saved for {target}")
    except sqlite3.Error as e:
        _log(f"[memory] delete failed: {e}")
        return "couldn't wipe that - memory is unavailable right now"


def load_chat_history(chat, limit=10):
    chat = _norm_user(chat) or str(chat or "").strip()
    if not chat:
        return []
    try:
        with closing(_connect()) as c:
            row = c.execute(
                "SELECT messages FROM chat_history WHERE chat=?",
                (chat,)).fetchone()
        if not row:
            return []
        data = __import__("json").loads(row[0] or "[]")
        if not isinstance(data, list):
            return []
        clean = []
        for m in data[-limit:]:
            if isinstance(m, dict) and m.get("role") in ("user", "assistant"):
                clean.append({"role": m["role"], "content": str(m.get("content") or "")})
        return clean
    except Exception as e:
        _log(f"[memory] history read failed: {e}")
        return []


def save_chat_history(chat, messages, limit=10):
    chat = _norm_user(chat) or str(chat or "").strip()
    if not chat:
        return
    try:
        clean = []
        for m in list(messages or [])[-limit:]:
            if isinstance(m, dict) and m.get("role") in ("user", "assistant"):
                clean.append({"role": m["role"], "content": str(m.get("content") or "")[:1200]})
        payload = __import__("json").dumps(clean, ensure_ascii=False)
        with closing(_connect()) as c:
            c.execute(
                "INSERT INTO chat_history(chat,messages,updated) VALUES(?,?,?) "
                "ON CONFLICT(chat) DO UPDATE SET messages=excluded.messages, updated=excluded.updated",
                (chat, payload, time.time()))
            c.execute(
                "DELETE FROM chat_history WHERE updated < ?",
                (time.time() - 14 * 24 * 3600,))
            c.commit()
    except Exception as e:
        _log(f"[memory] history write failed: {e}")
