from __future__ import annotations

import json
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

_ACTIVE_SCHEMA = """CREATE TABLE IF NOT EXISTS active_task(
    chat TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
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
        c.execute(_ACTIVE_SCHEMA)
        cols = {r[1] for r in c.execute("PRAGMA table_info(mem)")}
        if "created" not in cols:
            c.execute("ALTER TABLE mem ADD COLUMN created REAL NOT NULL DEFAULT 0")
        if "source" not in cols:
            c.execute("ALTER TABLE mem ADD COLUMN source TEXT NOT NULL DEFAULT ''")
        if "scope" not in cols:
            c.execute("ALTER TABLE mem ADD COLUMN scope TEXT NOT NULL DEFAULT 'personal'")
        c.commit()


try:
    _init_db()
except Exception as exc:
    # A corrupt or locked database must not take the whole agent down at import.
    # Every read/write path already degrades to an honest "unavailable" reply.
    _log(f"[memory] init failed: {type(exc).__name__}: {exc}")


def _chat_key(chat):
    """One canonical key per conversation.

    Person JIDs collapse to a bare number, but a WhatsApp group JID (…@g.us)
    must keep its full address: stripping the suffix would merge unrelated
    groups. Read and write paths both use this helper.
    """
    value = str(chat or "").strip()
    if value.lower().endswith("@g.us"):
        return value
    return _norm_user(value)


def _clean_fact(fact, limit=500):
    s = "".join(ch for ch in str(fact or "") if ch.isprintable() or ch in "\n\t")
    return " ".join(s.split())[:limit]


_THINK_OPEN_RE = re.compile(r"<(?:think(?:ing)?|reasoning|analysis|scratchpad|thought)>", re.I)
_THINK_CLOSE_RE = re.compile(r"</(?:think(?:ing)?|reasoning|analysis|scratchpad|thought)>", re.I)
_THINK_TAG_RE = re.compile(r"</?(?:think(?:ing)?|reasoning|analysis|scratchpad|thought)>", re.I)
# Compatibility aliases for older importers; the greedy unclosed rule is gone
# because it deleted every answer that followed an unfinished reasoning tag.
_THINK_RE = _THINK_OPEN_RE
_THINK_UNCLOSED_RE = _THINK_OPEN_RE


def _clean_reply(text):
    """Strip provider reasoning without swallowing the answer after it.

    Some providers truncate their own reasoning and leave an unclosed
    "<think>" tag. The old greedy "strip to end of string" rule removed
    everything after that tag, so "I<think>..." became just "I". Remove a
    closed block completely; for an unclosed block, drop only the tag and
    keep the text that follows as the answer.
    """
    text = str(text or "")
    while True:
        opened = _THINK_OPEN_RE.search(text)
        if not opened:
            break
        closed = _THINK_CLOSE_RE.search(text, opened.end())
        if closed:
            text = text[:opened.start()] + text[closed.end():]
            continue
        text = text[:opened.start()] + text[opened.end():]
        break
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
    chat = _chat_key(chat)
    if not chat:
        return []
    try:
        with closing(_connect()) as c:
            row = c.execute(
                "SELECT messages FROM chat_history WHERE chat=?",
                (chat,)).fetchone()
        if not row:
            return []
        data = json.loads(row[0] or "[]")
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
    chat = _chat_key(chat)
    if not chat:
        return
    try:
        clean = []
        for m in list(messages or [])[-limit:]:
            if isinstance(m, dict) and m.get("role") in ("user", "assistant"):
                clean.append({"role": m["role"], "content": str(m.get("content") or "")[:1200]})
        payload = json.dumps(clean, ensure_ascii=False)
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


def set_active_task(chat, status="running", detail=""):
    """Persist what this chat was doing so a reconnect cannot erase it."""
    chat = _chat_key(chat)
    if not chat:
        return "no chat to attach a task to"
    value = " ".join(str(detail or "").split())[:1200]
    state = str(status or "running").strip()[:80] or "running"
    try:
        with closing(_connect()) as c:
            c.execute(
                "INSERT INTO active_task(chat,status,detail,updated) VALUES(?,?,?,?) "
                "ON CONFLICT(chat) DO UPDATE SET status=excluded.status, "
                "detail=excluded.detail, updated=excluded.updated",
                (chat, state, value, time.time()))
            c.commit()
        return "task saved"
    except Exception as e:
        _log(f"[memory] task write failed: {e}")
        return f"task save failed: {type(e).__name__}"


def get_active_task(chat):
    """Return the last saved task for this chat, or None."""
    chat = _chat_key(chat)
    if not chat:
        return None
    try:
        with closing(_connect()) as c:
            row = c.execute(
                "SELECT status, detail, updated FROM active_task WHERE chat=?",
                (chat,)).fetchone()
        if not row:
            return None
        return {"status": str(row[0] or ""), "detail": str(row[1] or ""),
                "updated": float(row[2] or 0)}
    except Exception as e:
        _log(f"[memory] task read failed: {e}")
        return None


def clear_active_task(chat):
    chat = _chat_key(chat)
    if not chat:
        return "no chat to clear"
    try:
        with closing(_connect()) as c:
            c.execute("DELETE FROM active_task WHERE chat=?", (chat,))
            c.commit()
        return "task cleared"
    except Exception as e:
        _log(f"[memory] task clear failed: {e}")
        return f"task clear failed: {type(e).__name__}"
