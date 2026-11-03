"""Client for the WhatsApp bridge's authenticated local tool endpoint.

Only the bridge holds the token, so the endpoint cannot be triggered by a
web page. Errors are raised as ``ToolError`` with a safe, human-readable
message; raw HTTP bodies and stack traces never reach the model.
"""

from __future__ import annotations

import os
import tempfile

import requests

import liam_google

BRIDGE_URL = os.environ.get("LIAM_BRIDGE_URL", "http://127.0.0.1:5678")

DATA_DIR = os.environ.get("LIAM_DATA_DIR") or os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "LiamWhatsApp"
)
TOKEN_FILE = os.path.join(DATA_DIR, "tool_token")
STOP_FILE = os.path.join(DATA_DIR, "stop_flag")
LEGACY_STOP_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".stop")


class ToolError(RuntimeError):
    """A tool action failed; the message is safe to show to the model."""


def _token() -> str:
    try:
        with open(TOKEN_FILE, encoding="utf-8") as handle:
            token = handle.read().strip()
    except OSError as exc:
        raise ToolError("the WhatsApp bridge is not running") from exc
    if not token:
        raise ToolError("the WhatsApp bridge is not running")
    return token


def _post(action: str, timeout: float = 60, **kwargs) -> str:
    try:
        response = requests.post(
            BRIDGE_URL,
            json={"action": action, **kwargs},
            headers={"Authorization": "Bearer " + _token()},
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise ToolError("the WhatsApp bridge is not reachable") from exc

    try:
        data = response.json()
    except ValueError:
        data = {}
    if not isinstance(data, dict):
        data = {}

    message = str(data.get("msg") or "").strip()
    if not response.ok or data.get("ok") is False:
        raise ToolError(message or "the WhatsApp action failed")
    return message or "ok"


def send_message(to: str, text: str) -> str:
    return _post("send", to=to, text=text)


def send_image(to: str, path: str) -> str:
    return _post("image", to=to, path=path, timeout=120)


def send_voice(to: str, text: str) -> str:
    path, mimetype = liam_google.synth_voice(text)
    try:
        return _post("voice", to=to, path=path, mimetype=mimetype, timeout=120)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def leave_group(jid: str) -> str:
    return _post("leave", jid=jid)


def permission(jid: str, who: str, allow: bool) -> str:
    return _post("permission", jid=jid, who=who, allow=bool(allow))


def stop() -> str:
    return _post("stop")


def _atomic_write(path: str, value: str) -> None:
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".liam_", dir=directory, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.remove(temporary)
        except OSError:
            pass


def set_stop(value: bool) -> None:
    _atomic_write(STOP_FILE, "1" if value else "0")


def get_stop() -> bool:
    for path in (STOP_FILE, LEGACY_STOP_FILE):
        try:
            with open(path, encoding="utf-8") as handle:
                return handle.read().strip() == "1"
        except OSError:
            continue
    return False
