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

def _bridge_url() -> str:
    # Prefer explicit URL; otherwise follow the same container-local port the
    # bridge binds to (Render injects PORT).
    explicit = os.environ.get("LIAM_BRIDGE_URL")
    if explicit:
        return explicit.rstrip("/")
    port = os.environ.get("LIAM_PORT") or os.environ.get("PORT") or "5678"
    return f"http://127.0.0.1:{port}"

BRIDGE_URL = _bridge_url()

DATA_DIR = os.environ.get("LIAM_DATA_DIR") or os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "LiamWhatsApp"
)
TOKEN_FILE = os.path.join(DATA_DIR, "tool_token")
STOP_FILE = os.path.join(DATA_DIR, "stop_flag")


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


def _post(action: str, http_timeout: float = 60, **kwargs) -> str:
    payload = {"action": action}
    # The bridge needs to know who is acting so it can enforce owner-only
    # actions and one-time approvals. Empty values are omitted.
    payload.update({key: value for key, value in kwargs.items() if value is not None})
    try:
        response = requests.post(
            BRIDGE_URL,
            json=payload,
            headers={"Authorization": "Bearer " + _token()},
            timeout=http_timeout,
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


def send_message(to: str, text: str, sender: str | None = None) -> str:
    return _post("send", to=to, text=text, sender=sender)


def send_image(to: str, path: str, sender: str | None = None) -> str:
    return _post("image", to=to, path=path, sender=sender, http_timeout=120)


def send_voice(to: str, text: str, sender: str | None = None) -> str:
    path, mimetype = liam_google.synth_voice(text)
    try:
        return _post(
            "voice", to=to, path=path, mimetype=mimetype, sender=sender,
            http_timeout=120)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def leave_group(jid: str, sender: str | None = None) -> str:
    return _post("leave", jid=jid, sender=sender)


def permission(jid: str, who: str, allow: bool, sender: str | None = None) -> str:
    return _post(
        "permission", jid=jid, who=who, allow=bool(allow), sender=sender)


def stop(sender: str | None = None) -> str:
    return _post("stop", sender=sender)


def vps_exec(command: str, timeout: int = 120, cwd: str = "",
             sender: str | None = None, chat: str | None = None,
             group: bool = False) -> str:
    """Run a command on the InstaBox VM; non-owner calls need approval."""
    try:
        seconds = max(1, min(600, int(timeout or 120)))
    except (TypeError, ValueError):
        seconds = 120
    return _post(
        "vps_exec", command=command, timeout=seconds, cwd=cwd or "",
        sender=sender, chat=chat, group=bool(group),
        http_timeout=max(30, seconds + 30))


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
    try:
        with open(STOP_FILE, encoding="utf-8") as handle:
            return handle.read().strip() == "1"
    except OSError:
        return False
