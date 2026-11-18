from __future__ import annotations

# ruff: noqa: F401, E402
# Compatibility facade: implementation lives in liam_agent/* modules.
# Keep this file as the stable entrypoint and patch/import surface.

import base64
import ipaddress
import json
import mimetypes
import os
import random
import re
import shlex
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import types
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing

import liam_google
import liam_keys
import liam_voice
import whatsapp_liam as wa

# --- runtime/bootstrap (mirrors original import-time side effects) ---
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("LIAM_DATA_DIR") or os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "LiamWhatsApp")
OUTBOX_DIR = os.path.join(DATA_DIR, "outbox")
for _directory in (DATA_DIR, OUTBOX_DIR):
    try:
        os.makedirs(_directory, exist_ok=True)
        os.chmod(_directory, 0o700)
    except OSError:
        pass

# Load split implementation (also performs DB init and config/people load).
from liam_agent import brains, integrations, loop, memory, people, registry, runtime, state, web
from liam_agent.brains import (
    ATTEMPT_TIMEOUT, BRAIN_STATE, BRAINS, CALL_BUDGET, FALLBACK_ORDER,
    LEGACY_BRAIN_STATE, MAX_ATTEMPTS, OFFLINE, PREFERRED_KEY_STATE, QUOTA_COOLDOWN,
    _BRAIN_ALIASES, _attempt_plan, _clear_exhausted, _exhaust_key, _exhausted_at,
    _get_preferred_key, _http_post, _is_transient, _key_exhausted, _mark_exhausted,
    _normalize_brain, _normalize_message, _probe, _set_preferred_key, call_model,
    check_key, check_status, check_tokens, get_brain, set_brain, switch_brain,
)
from liam_agent.integrations import (
    AUTO_PROGRESS_TOOLS, SLOW_TOOLS, VPS_BROWSER_DIR, VPS_PYLIB_DIR, _SCREENSHOT_SCRIPT, _VPS_ENV,
    _auto_progress_text, _browser_script_text, _emit_progress, _local_image_data_url,
    _remote_browser_task, _remote_screenshot, _vps_browser_enabled, _vps_browser_note,
    _vps_ok, _vps_stage, analyze_image, browser_task, leave_group, permission,
    report_progress, screenshot, send_dm, send_image, send_voice, stop_task, switch_voice,
    vps_exec,
)
from liam_agent.loop import (
    _clear_stop, _history_add, _history_get, _parse_args, _stop_requested, _system_prompt,
    main, run_agent,
)
from liam_agent.memory import (
    DB, _SCHEMA, _THINK_RE, _THINK_TAG_RE, _THINK_UNCLOSED_RE, _clean_fact, _clean_reply,
    _connect, _facts, _init_db, clear_active_task, clear_memory, get_active_task,
    load_chat_history, recall, recall_all, remember, save_chat_history, set_active_task,
)
from liam_agent.people import (
    ADMS, CONFIG_PATH, OWNERS, PETNAMES, _is_admin, _is_owner, _load_people, _norm_user,
    _people_block, _person_phone, _resolve_memory_user,
)
from liam_agent.registry import (
    FALLBACK_TEXT, OWNER_ONLY_TOOLS, PROMPT, SCHEMAS, TOOLS, _brain_block, _email_block,
    _schema_names, _schemas_for, _tool_names, _tools_for,
)
from liam_agent.runtime import (
    FILE_READ_MAX, HISTORY_MESSAGES, HISTORY_TURNS, MAX_STEPS, MAX_TOOL_CALLS,
    SHELL_OUTPUT_MAX, TOOL_RESULT_MAX, _atomic_write_text, _env_int, _log, _safe_remove,
    _unique_file,
)
from liam_agent.state import _clamp_timeout, _remaining_budget
from liam_agent.web import (
    _BLOCKED_HOST_SUFFIXES, _SafeRedirectHandler, _SafeUrl, _build_opener,
    _ddg_clean_title, _ddg_parse_html, _ddg_parse_lite, _ddg_target, _generous_timeout,
    _http_json, _open_url, _pinned_connection, _safe_url, _search_brave,
    _search_duckduckgo, _search_serper, _search_tavily, create_tool, email_read,
    file_read, file_write, shell_exec, web_fetch, web_search,
)

# Shared turn state lives only in liam_agent.state. Forward facade reads and
# writes there so agent.X and state.X can never drift apart.
class _FacadeModule(types.ModuleType):
    _STATE_NAMES = frozenset({
        "_HISTORY", "_LAST_TRACE", "_DEADLINE", "_LAST_PROGRESS_AT",
        "_LAST_PROGRESS_TEXT", "_LAST_PROGRESS_EMIT_AT", "_PROGRESS_COUNT",
        "_EXHAUSTED", "_vps_browser_retry_at", "_REQUEST_ID",
        "_STOP_BASELINE", "_STOP_TOKEN",
    })

    def __getattr__(self, name):
        if name in self._STATE_NAMES:
            return getattr(state, name)
        raise AttributeError(f"module {self.__name__!r} has no attribute {name!r}")

    def __setattr__(self, name, value):
        if name in self._STATE_NAMES:
            setattr(state, name, value)
            return
        super().__setattr__(name, value)


sys.modules[__name__].__class__ = _FacadeModule


if __name__ == "__main__":
    main()
