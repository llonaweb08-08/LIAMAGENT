"""Free voice-note synthesis using Microsoft Edge's neural voices.

``edge-tts`` needs no API key and has no daily quota, so voice notes keep
working on a free host. Two voices are configured:

* voice 1 - Ezinne (Nigerian English, female) - the default
* voice 2 - Sonia (British English, female)

The chosen voice is stored in the memory database (which Supabase backs up),
so a restart keeps it. Synthesis returns an OGG/Opus file (WhatsApp's native
voice-note format) when ``ffmpeg`` is on ``PATH``, and falls back to MP3
otherwise.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sqlite3
import subprocess
import tempfile
from contextlib import closing

# Voice number -> the Microsoft neural voice that speaks it. Keep this small
# and explicit; the agent exposes these numbers to the owner.
VOICES = {
    "1": {"label": "Ezinne", "voice": "en-NG-EzinneNeural",
          "description": "Nigerian English, female"},
    "2": {"label": "Sonia", "voice": "en-GB-SoniaNeural",
          "description": "British English, female"},
}
DEFAULT_VOICE = "1"
# edge-tts splits long text itself, but a voice note nobody will listen to is
# pointless, so cap what one note can say.
MAX_CHARS = 4000


class VoiceUnavailable(RuntimeError):
    """Raised when a voice note could not be produced."""


def _data_dir() -> str:
    return os.environ.get("LIAM_DATA_DIR") or os.path.join(
        os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "LiamWhatsApp")


def voice_file() -> str:
    return os.path.join(_data_dir(), "voice_choice")


def _db_path() -> str:
    # The canonical memory database is liam_agent.memory.DB (LIAM_DB, else the
    # repository base directory). Read it lazily so voice settings follow the
    # same database the agent uses instead of a second DATA_DIR copy.
    try:
        from liam_agent.memory import DB
        return DB
    except Exception:
        return os.environ.get("LIAM_DB") or os.path.join(_data_dir(), "liam_memory.db")


def _connect():
    conn = sqlite3.connect(_db_path(), timeout=10)
    conn.execute("PRAGMA busy_timeout=10000")
    conn.execute("CREATE TABLE IF NOT EXISTS settings("
                 "name TEXT PRIMARY KEY, value TEXT NOT NULL)")
    return conn


def _outbox() -> str:
    out = os.path.join(_data_dir(), "outbox")
    os.makedirs(out, exist_ok=True)
    try:
        os.chmod(out, 0o700)
    except OSError:
        pass
    return out


def normalize_choice(value) -> str | None:
    """Map free text ("Sonia", "voice 2", "2") to a voice number, or None."""
    key = str(value or "").strip().lower()
    if not key:
        return None
    if key in VOICES:
        return key
    for number, info in VOICES.items():
        if info["label"].lower() in key or info["voice"].lower() in key:
            return number
    if "sonia" in key or "british" in key or "voice 2" in key or "voice2" in key:
        return "2"
    if ("ezinne" in key or "nigerian" in key or "voice 1" in key
            or "voice1" in key or "default" in key):
        return "1"
    return None


def _read_file() -> str | None:
    try:
        with open(voice_file(), encoding="utf-8") as handle:
            key = handle.read().strip()
    except OSError:
        return None
    return key if key in VOICES else None


def _write_file(key: str) -> None:
    from liam_agent.runtime import _atomic_write_text
    _atomic_write_text(voice_file(), key)


def get_voice() -> str:
    # The memory database rides to Supabase with every backup, so the chosen
    # voice survives a Render restart. The small file is only a fallback for a
    # host where the database cannot be opened.
    try:
        with closing(_connect()) as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE name='voice'").fetchone()
        if row and str(row[0]) in VOICES:
            return str(row[0])
    except sqlite3.Error:
        pass
    return _read_file() or DEFAULT_VOICE


def set_voice(value) -> str | None:
    """Persist the chosen voice. Returns the voice number, or None if unknown."""
    key = normalize_choice(value)
    if key is None:
        return None
    try:
        with closing(_connect()) as conn:
            conn.execute(
                "INSERT INTO settings(name, value) VALUES('voice', ?) "
                "ON CONFLICT(name) DO UPDATE SET value=excluded.value", (key,))
            conn.commit()
    except sqlite3.Error:
        pass
    try:
        _write_file(key)
    except OSError:
        pass
    return key


def describe() -> str:
    key = get_voice()
    info = VOICES[key]
    return f"voice {key} - {info['label']} ({info['description']})"


def _to_ogg(path: str) -> str | None:
    """Convert to OGG/Opus when ffmpeg exists (WhatsApp's voice-note format)."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return None
    out = path + ".ogg"
    try:
        result = subprocess.run(
            [ffmpeg, "-y", "-i", path, "-c:a", "libopus", "-b:a", "32k", out],
            capture_output=True,
            timeout=120,
            check=False,
        )
        if result.returncode == 0 and os.path.getsize(out) > 0:
            try:
                os.remove(path)
            except OSError:
                pass
            return out
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        os.remove(out)
    except OSError:
        pass
    return None


async def _save(text: str, voice: str, out: str) -> None:
    # Imported here so a host without edge-tts can still import this module and
    # report an honest failure instead of crashing at startup.
    import edge_tts
    await edge_tts.Communicate(text, voice).save(out)


def synth(text: str, choice=None) -> tuple[str, str]:
    """Synthesize ``text`` and return ``(path, mimetype)`` for a voice note."""
    value = str(text or "").strip()
    if not value:
        raise VoiceUnavailable("there is nothing to say")
    value = value[:MAX_CHARS]
    key = normalize_choice(choice) or get_voice()
    voice = VOICES[key]["voice"]

    fd, mp3 = tempfile.mkstemp(prefix="liam_", suffix=".mp3", dir=_outbox())
    os.close(fd)
    try:
        asyncio.run(_save(value, voice, mp3))
    except Exception as exc:
        try:
            os.remove(mp3)
        except OSError:
            pass
        raise VoiceUnavailable(
            f"voice synthesis failed ({type(exc).__name__})") from exc
    if not os.path.exists(mp3) or os.path.getsize(mp3) <= 0:
        try:
            os.remove(mp3)
        except OSError:
            pass
        raise VoiceUnavailable("voice synthesis produced no audio")
    converted = _to_ogg(mp3)
    if converted:
        return converted, "audio/ogg"
    return mp3, "audio/mpeg"
