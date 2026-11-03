"""Google Gemini helpers for image generation and voice notes.

The API key is optional. Without it these helpers raise ``GoogleUnavailable``
with a human-readable message, so the agent can report an honest failure
instead of crashing with ``AttributeError``.
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
import wave

import liam_keys

API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models"
_RATE_RE = re.compile(r"rate=(\d+)", re.I)


class GoogleUnavailable(RuntimeError):
    """Raised when image/voice generation is not configured."""


def _key() -> str:
    key = str(getattr(liam_keys, "GOOGLE_API_KEY", "") or "").strip()
    if not key:
        raise GoogleUnavailable(
            "image and voice generation are not configured (GOOGLE_API_KEY is missing)"
        )
    return key


def _outbox() -> str:
    base = os.environ.get("LIAM_DATA_DIR") or os.path.join(
        os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "LiamWhatsApp"
    )
    out = os.path.join(base, "outbox")
    os.makedirs(out, exist_ok=True)
    try:
        os.chmod(out, 0o700)
    except OSError:
        pass
    return out


def _unique(suffix: str) -> str:
    fd, path = tempfile.mkstemp(prefix="liam_", suffix=suffix, dir=_outbox())
    os.close(fd)
    return path


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def _post(model: str, payload: dict, timeout: int = 90) -> dict:
    url = f"{API_ROOT}/{model}:generateContent?key={_key()}"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read(200).decode("utf-8", "replace").replace("\n", " ")[:160]
        except Exception:
            pass
        raise RuntimeError(f"Google API HTTP {exc.code}: {detail}".strip()) from exc
    except Exception as exc:  # network, TLS, timeout, JSON
        raise RuntimeError(f"Google API failed: {type(exc).__name__}") from exc
    if isinstance(body, dict) and body.get("error"):
        raise RuntimeError("Google API returned an error")
    if not isinstance(body, dict):
        raise RuntimeError("Google API returned an unexpected response")
    return body


def _inline_part(body: dict) -> dict:
    candidates = body.get("candidates") or []
    if not candidates or not isinstance(candidates[0], dict):
        raise RuntimeError("Google API returned no candidates")
    content = candidates[0].get("content") or {}
    parts = content.get("parts") or []
    for part in reversed(parts):
        if not isinstance(part, dict):
            continue
        inline = part.get("inlineData") or part.get("inline_data")
        if isinstance(inline, dict) and inline.get("data"):
            return inline
    raise RuntimeError("Google API returned no media")


def generate_image(prompt: str) -> str:
    """Generate one image and return the path of a temporary PNG file."""
    body = _post(
        liam_keys.GOOGLE_IMAGE_MODEL,
        {
            "contents": [{"parts": [{"text": str(prompt or "")}]}],
            "generationConfig": {"responseModalities": ["IMAGE", "TEXT"]},
        },
    )
    inline = _inline_part(body)
    try:
        raw = base64.b64decode(inline["data"])
    except Exception as exc:
        raise RuntimeError("Google API returned invalid image data") from exc
    if not raw:
        raise RuntimeError("Google API returned an empty image")
    path = _unique(".png")
    with open(path, "wb") as handle:
        handle.write(raw)
    return path


def _write_audio(raw: bytes, mime: str) -> tuple[str, str]:
    """Write PCM or already-encoded audio, returning (path, real mimetype)."""
    lowered = mime.lower()
    if "l16" in lowered or "pcm" in lowered:
        match = _RATE_RE.search(mime)
        rate = int(match.group(1)) if match else 24000
        path = _unique(".wav")
        with wave.open(path, "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(rate)
            handle.writeframes(raw)
        return path, "audio/wav"
    if "wav" in lowered:
        path = _unique(".wav")
        with open(path, "wb") as handle:
            handle.write(raw)
        return path, "audio/wav"
    if "mpeg" in lowered or "mp3" in lowered:
        path = _unique(".mp3")
        with open(path, "wb") as handle:
            handle.write(raw)
        return path, "audio/mpeg"
    if "ogg" in lowered or "opus" in lowered:
        path = _unique(".ogg")
        with open(path, "wb") as handle:
            handle.write(raw)
        return path, "audio/ogg"
    raise RuntimeError(f"Google API returned unsupported audio type: {mime or 'unknown'}")


def _to_ogg(path: str, mime: str) -> tuple[str, str] | None:
    """Convert to OGG/Opus when ffmpeg exists (WhatsApp's preferred voice format)."""
    if mime == "audio/ogg":
        return path, mime
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return None
    out = _unique(".ogg")
    try:
        result = subprocess.run(
            [ffmpeg, "-y", "-i", path, "-c:a", "libopus", "-b:a", "32k", out],
            capture_output=True,
            timeout=120,
            check=False,
        )
        if result.returncode == 0 and os.path.getsize(out) > 0:
            _remove(path)
            return out, "audio/ogg"
    except (OSError, subprocess.SubprocessError):
        pass
    _remove(out)
    return None


def synth_voice(text: str) -> tuple[str, str]:
    """Synthesize a voice note and return (path, mimetype).

    Gemini TTS returns raw PCM; it is wrapped in a real WAV container. If
    ffmpeg is available it is converted to OGG/Opus, which WhatsApp treats as
    a proper voice note. Without ffmpeg the WAV is still valid audio.
    """
    body = _post(
        liam_keys.GOOGLE_TTS_MODEL,
        {
            "contents": [{"parts": [{"text": str(text or "")}]}],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {
                        "prebuiltVoiceConfig": {"voiceName": "Kore"}
                    }
                },
            },
        },
    )
    inline = _inline_part(body)
    try:
        raw = base64.b64decode(inline["data"])
    except Exception as exc:
        raise RuntimeError("Google API returned invalid audio data") from exc
    if not raw:
        raise RuntimeError("Google API returned empty audio")
    mime = str(inline.get("mimeType") or inline.get("mime_type") or "")
    path, real_mime = _write_audio(raw, mime)
    converted = _to_ogg(path, real_mime)
    if converted:
        return converted
    return path, real_mime
