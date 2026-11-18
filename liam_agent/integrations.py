from __future__ import annotations

import base64
import binascii
import json
import os
import re
import shlex
import time

import liam_keys

from ._compat import agent_mod
from .people import OWNERS
from .runtime import BASE_DIR, OUTBOX_DIR, _env_int, _log, _safe_remove, _unique_file
from .state import _clamp_timeout, _remaining_budget
from .web import _safe_url

_SCREENSHOT_SCRIPT = r"""
import ipaddress, os, socket, sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

def public_url(url):
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return False
    host = parsed.hostname.lower().rstrip(".")
    if host == "localhost" or host.endswith((".local", ".internal", ".localhost", ".home", ".lan")):
        return False
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except Exception:
        return False
    if not infos:
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(str(info[4][0]).split("%", 1)[0])
        except ValueError:
            return False
        if not ip.is_global:
            return False
    return True

url, out, ua = sys.argv[1], sys.argv[2], sys.argv[3]
_liam_launch = dict(headless=True, args=[
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
])
_liam_exec = os.environ.get("LIAM_CHROMIUM_PATH") or None
if _liam_exec:
    _liam_launch["executable_path"] = _liam_exec
with sync_playwright() as p:
    browser = p.chromium.launch(**_liam_launch)
    try:
        context = browser.new_context(
            viewport={"width": 1366, "height": 900},
            user_agent=ua,
        )
        page = context.new_page()

        def guard(route):
            target = route.request.url
            if target.startswith(("http://", "https://")) and not public_url(target):
                return route.abort()
            return route.continue_()

        page.route("**/*", guard)
        page.goto(url, wait_until="domcontentloaded", timeout=45000)
        if not public_url(page.url):
            raise SystemExit("blocked final URL")
        page.screenshot(path=out, full_page=False)
    finally:
        browser.close()
"""


def send_dm(to, text, sender=None):
    return agent_mod().wa.send_message(to, text, sender=sender)


def send_image(to, prompt, sender=None):
    path = agent_mod().liam_google.generate_image(prompt)
    try:
        return agent_mod().wa.send_image(to, path, sender=sender)
    finally:
        _safe_remove(path)


def send_voice(to, text, sender=None, chat=None, group=False):
    return agent_mod().wa.send_voice(to, text, sender=sender, chat=chat, group=group)


def switch_voice(voice, sender=None):
    """Owner-only: choose which voice speaks the voice notes (persisted)."""
    key = agent_mod().liam_voice.set_voice(voice)
    if key is None:
        return ("I only have voice 1 (Ezinne) and voice 2 (Sonia) - "
                "say 'switch to voice 1' or 'switch to voice 2'")
    return "okay, I'll use " + agent_mod().liam_voice.describe()


def screenshot(to, url, sender=None):
    a = agent_mod()
    safe = _safe_url(url)
    enabled = getattr(a, "_vps_browser_enabled", _vps_browser_enabled)
    remote = getattr(a, "_remote_screenshot", _remote_screenshot)
    note = getattr(a, "_vps_browser_note", _vps_browser_note)
    if enabled():
        try:
            result = remote(to, safe, sender)
            note(True)
            return result
        except Exception as e:
            note(False)
            _log(f"warn: remote screenshot failed, using the local browser: {type(e).__name__}")
    path = _unique_file(".png")
    try:
        # Re-validate immediately before fetching to shrink the DNS-rebinding window.
        _safe_url(safe)
        try:
            result = agent_mod().subprocess.run(
                [agent_mod().sys.executable, "-c", _SCREENSHOT_SCRIPT, safe, path, liam_keys.BROWSER_UA],
                timeout=_clamp_timeout(_env_int("LIAM_SCREENSHOT_TIMEOUT", 900, 20, 1800)),
                capture_output=True, text=False, check=False)
        except agent_mod().subprocess.TimeoutExpired as exc:
            raise RuntimeError("screenshot timed out") from exc
        if result.returncode != 0 or not os.path.exists(path) or os.path.getsize(path) == 0:
            raise RuntimeError("screenshot failed")
        return agent_mod().wa.send_image(to, path, sender=sender)
    finally:
        _safe_remove(path)


def leave_group(jid=None, sender=None):
    if not jid:
        return "I can only leave a group when you ask me inside it"
    return agent_mod().wa.leave_group(jid, sender=sender)


def stop_task(sender=None):
    wa = agent_mod().wa
    try:
        return wa.stop(sender=sender)
    except Exception:
        wa.set_stop(True)
        return "stopping what I was doing right now"


def permission(jid, who, allow, sender=None):
    return agent_mod().wa.permission(jid, who, allow, sender=sender)


def vps_exec(command, timeout=120, cwd="", sender=None, chat="", group=False):
    try:
        seconds = int(timeout or 120)
    except (TypeError, ValueError):
        seconds = 120
    left = _remaining_budget()
    if left is not None and left <= 0:
        return "no time left in this turn to run that"
    if left is not None:
        seconds = max(1, min(seconds, int(left)))
    return agent_mod().wa.vps_exec(
        command, timeout=seconds, cwd=cwd, sender=sender, chat=chat, group=group)


def report_progress(text, sender=None):
    """Send an explicit report to every configured owner, not just the first."""
    a = agent_mod()
    value = str(text or "")
    owners = list(getattr(a, "OWNERS", OWNERS) or [])
    if not owners:
        return "progress report failed: no owners configured"
    sent, failures = 0, []
    for owner in owners:
        try:
            a.wa.send_message(owner, value, sender=sender or owner)
            sent += 1
        except Exception as e:
            failures.append(type(e).__name__)
    if not sent:
        return "progress report failed: " + ", ".join(failures)
    if failures:
        return f"progress sent to {sent} of {len(owners)} owners ({', '.join(failures)})"
    return f"progress sent to {sent} owner(s)"


def _progress_throttled(value, now=None):
    """The single throttle for every progress line (auto heartbeat or explicit).

    Rules, in order: suppress an identical update inside the dedupe window,
    enforce one minimum gap between any two updates, and cap how many updates
    one turn may emit. Returns an honest "not sent ..." reason, or "" to send.
    """
    from . import state
    now = time.monotonic() if now is None else now
    last_text = str(getattr(state, "_LAST_PROGRESS_TEXT", "") or "")
    last_emit = float(getattr(state, "_LAST_PROGRESS_EMIT_AT", 0.0) or 0.0)
    # LIAM_PROGRESS_GAP is the old auto-heartbeat name; accept both.
    gap = _env_int("LIAM_PROGRESS_MIN_GAP",
                   _env_int("LIAM_PROGRESS_GAP", 20, 0, 600), 0, 600)
    dedupe = _env_int("LIAM_PROGRESS_DEDUPE", 120, 10, 3600)
    if value == last_text and (now - last_emit) < dedupe:
        return "not sent (already reported)"
    if (now - last_emit) < gap:
        return "not sent (rate-limited)"
    max_per_turn = _env_int("LIAM_PROGRESS_MAX_PER_TURN", 3, 1, 20)
    count = int(getattr(state, "_PROGRESS_COUNT", 0) or 0)
    if count >= max_per_turn:
        return "not sent (progress limit reached for this turn)"
    return ""


def _emit_progress(text):
    from . import state
    value = " ".join(str(text or "").split()).strip()
    if not value:
        return "nothing to report"
    if len(value) > 1200:
        value = value[:1200].rstrip() + "…"
    now = time.monotonic()
    try:
        reason = _progress_throttled(value, now)
        if reason:
            state._LAST_PROGRESS_AT = now
            return reason
        # BR-10: the bridge only delivers frames whose id matches the turn it
        # is waiting for. Outside a turn there is no id, so send null.
        print(json.dumps({"progress": value, "id": getattr(state, "_REQUEST_ID", None)},
                         ensure_ascii=False), flush=True)
    except Exception:
        return "couldn't send that update"
    state._LAST_PROGRESS_AT = now
    state._LAST_PROGRESS_TEXT = value
    state._LAST_PROGRESS_EMIT_AT = now
    state._PROGRESS_COUNT = int(getattr(state, "_PROGRESS_COUNT", 0) or 0) + 1
    return "sent"


def _target_from_args(args):
    """Pull the real page/site/file out of a tool call for a contextual update."""
    for key in ("url", "path_or_url"):
        value = str((args or {}).get(key) or "").strip()
        if value:
            match = re.match(r"https?://([^/:\s]+)", value, re.I)
            return (match.group(1) if match else value)[:80]
    script = str((args or {}).get("script") or "")
    match = re.search(r"https?://([^/:\s\"'`]+)", script, re.I)
    if match:
        return match.group(1)[:80]
    folder = str((args or {}).get("folder") or "").strip()
    return folder[:80] if folder else ""


def _auto_progress_text(name, args=None):
    """Build a specific update from the tool call, not a fixed canned line."""
    target = _target_from_args(args)
    if name == "screenshot":
        return (f"I'm on {target} - taking the screenshot now." if target
                else "Taking the screenshot now - one moment.")
    if name == "browser_task":
        return (f"I'm on {target} in the browser now - one moment." if target
                else "I'm working in the browser now - one moment.")
    if name == "web_fetch":
        return (f"Fetching {target} now - one moment." if target
                else "Fetching that page now - one moment.")
    if name == "email_read":
        return (f"Checking your {target} folder now - one moment." if target
                else "Checking your inbox now - one moment.")
    if name == "analyze_image":
        return "Looking at that image now - one moment."
    return "Working on it - give me a moment."


# Long tools get a saved task so a reconnect cannot forget them. Only the
# genuinely visible ones post progress: routine shell/vps commands never do.
SLOW_TOOLS = {"browser_task", "screenshot", "vps_exec", "web_fetch",
              "email_read", "analyze_image", "shell_exec"}
AUTO_PROGRESS_TOOLS = {"browser_task", "screenshot", "web_fetch",
                       "email_read", "analyze_image"}

VPS_BROWSER_DIR = os.environ.get("LIAM_VPS_BROWSER_DIR") or "/data/home/liam_browser"
VPS_PYLIB_DIR = os.environ.get("LIAM_VPS_PYLIB_DIR") or "/data/home/liam_pylibs"


def _browser_script_text(script, extensions=True):
    """Wrap an agent-written Playwright snippet into a runnable script."""
    ext_dir = os.path.join(BASE_DIR, "browser_extensions")
    args = ["--disable-blink-features=AutomationControlled",
            "--no-sandbox", "--disable-dev-shm-usage"]
    if extensions and os.path.isdir(ext_dir):
        args += [f"--load-extension={ext_dir}", "--disable-extensions-except=" + ext_dir]
    out = []
    out.append("import os\n")
    out.append("_liam_launch = {'headless': True, 'args': " + repr(args) + "}\n")
    out.append("_liam_exec = os.environ.get('LIAM_CHROMIUM_PATH') or None\n")
    out.append("if _liam_exec:\n")
    out.append("    _liam_launch['executable_path'] = _liam_exec\n")
    out.append("from playwright.sync_api import sync_playwright\n")
    out.append("with sync_playwright() as p:\n")
    out.append("    browser = p.chromium.launch(**_liam_launch)\n")
    out.append("    context = browser.new_context(viewport={'width': 1366, 'height': 900}, "
               "user_agent=os.environ.get('LIAM_USER_AGENT', ''))\n")
    out.append("    page = context.new_page()\n")
    out.append("    page.set_default_timeout(15000)\n")
    out.append("    page.set_default_navigation_timeout(30000)\n")
    out.append("    try:\n")
    for line in str(script or "").splitlines():
        out.append("        " + line + "\n")
    out.append("    except Exception as _liam_exc:\n")
    out.append("        import traceback\n")
    out.append("        print('BROWSER_TASK_ERROR:', type(_liam_exc).__name__, _liam_exc)\n")
    out.append("        traceback.print_exc()\n")
    out.append("    finally:\n")
    out.append("        context.close()\n")
    out.append("        browser.close()\n")
    return "".join(out)


def _vps_browser_enabled():
    """Run Chromium on the InstaBox VM when one is configured."""
    from . import state
    if os.environ.get("LIAM_VPS_BROWSER", "1") == "0":
        return False
    if not os.environ.get("INSTABOX_API_KEY"):
        return False
    return time.time() >= state._vps_browser_retry_at


def _vps_browser_note(ok):
    from . import state
    state._vps_browser_retry_at = 0.0 if ok else time.time() + 600


def _vps_stage(name, text):
    """Upload a script to the VM and return its absolute path there."""
    if len(text) > 40000:
        raise ValueError("script is too large to send to the VM")
    path = VPS_BROWSER_DIR + "/" + name
    agent_mod().vps_exec("mkdir -p " + shlex.quote(VPS_BROWSER_DIR), timeout=30, sender=OWNERS[0])
    agent_mod().wa.vps_upload(path, base64.b64encode(text.encode("utf-8")).decode("ascii"),
                              sender=OWNERS[0])
    return path


def _vps_ok(output):
    match = re.match(r"\s*exit=(-?\d+)", str(output or ""))
    return bool(match) and match.group(1) == "0"


_VPS_ENV = ("export PYTHONPATH=%s; export LIAM_CHROMIUM_PATH=$(command -v chromium "
            "|| command -v chromium-browser || command -v google-chrome "
            "|| command -v google-chrome-stable || true); " % VPS_PYLIB_DIR)


def _remote_browser_task(script):
    path = _vps_stage("task_%s.py" % os.urandom(6).hex(),
                      _browser_script_text(script, extensions=False))
    command = "cd %s && %sLIAM_USER_AGENT=%s python3 %s" % (
        shlex.quote(VPS_BROWSER_DIR), _VPS_ENV,
        shlex.quote(liam_keys.BROWSER_UA), shlex.quote(path))
    output = agent_mod().vps_exec(
        command, timeout=_clamp_timeout(_env_int("LIAM_BROWSER_TIMEOUT", 1800, 10, 3600)),
        sender=OWNERS[0])
    if not _vps_ok(output):
        raise RuntimeError("remote browser task failed")
    return output[:8000]


def _remote_screenshot(to, url, sender):
    script_path = _vps_stage("shot_%s.py" % os.urandom(6).hex(), _SCREENSHOT_SCRIPT)
    remote_png = VPS_BROWSER_DIR + "/shot_%s.png" % os.urandom(6).hex()
    command = "cd %s && %spython3 %s %s %s %s" % (
        shlex.quote(VPS_BROWSER_DIR), _VPS_ENV, shlex.quote(script_path),
        shlex.quote(url), shlex.quote(remote_png), shlex.quote(liam_keys.BROWSER_UA))
    output = agent_mod().vps_exec(
        command, timeout=_clamp_timeout(_env_int("LIAM_SCREENSHOT_TIMEOUT", 900, 20, 1800)),
        sender=OWNERS[0])
    if not _vps_ok(output):
        raise RuntimeError("remote screenshot failed")
    data = agent_mod().wa.vps_download(remote_png, sender=OWNERS[0])
    if not data:
        raise RuntimeError("remote screenshot was empty")
    path = _unique_file(".png")
    try:
        try:
            raw = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise RuntimeError("remote screenshot returned invalid data") from exc
        with open(path, "wb") as handle:
            handle.write(raw)
        if os.path.getsize(path) == 0:
            raise RuntimeError("remote screenshot was empty")
        return agent_mod().wa.send_image(to, path, sender=sender)
    finally:
        _safe_remove(path)


def browser_task(script, sender=None, chat="", group=False):
    a = agent_mod()
    enabled = getattr(a, "_vps_browser_enabled", _vps_browser_enabled)
    remote = getattr(a, "_remote_browser_task", _remote_browser_task)
    note = getattr(a, "_vps_browser_note", _vps_browser_note)
    if enabled():
        try:
            result = remote(script)
            note(True)
            return result
        except Exception as e:
            note(False)
            _log(f"warn: remote browser task failed, using the local browser: {type(e).__name__}")
    path = _unique_file(".py")
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(_browser_script_text(script))
        env = dict(os.environ)
        env.setdefault("LIAM_USER_AGENT", liam_keys.BROWSER_UA)
        r = agent_mod().subprocess.run(
            [agent_mod().sys.executable, path], capture_output=True, text=True,
            timeout=_clamp_timeout(_env_int("LIAM_BROWSER_TIMEOUT", 1800, 10, 3600)), env=env)
        out = ((r.stdout or "") + (r.stderr or "")).strip()
        return out[:8000] or f"exit={r.returncode}"
    except agent_mod().subprocess.TimeoutExpired:
        return "browser task timed out"
    except Exception as e:
        return f"browser task failed: {type(e).__name__}"
    finally:
        _safe_remove(path)


_DENIED_IMAGE_NAMES = {
    "liam_secrets.py", "liam_config.json", "liam_memory.db", "tool_token",
    "stop_flag", "brain_state", "preferred_keys.json", ".env", ".env.local",
}


def _local_image_data_url(path):
    # Only the agent's own outbox is a legitimate image source. BASE_DIR holds
    # secrets and config, so it must never be exposed through this helper.
    real = os.path.realpath(os.path.abspath(str(path or "")))
    root = os.path.realpath(OUTBOX_DIR)
    if not (real == root or real.startswith(root + os.sep)):
        raise ValueError("local images must be inside the Liam outbox directory")
    name = os.path.basename(real).lower()
    if name in _DENIED_IMAGE_NAMES or name.startswith("."):
        raise ValueError("that file cannot be read as an image")
    if any(part in ("node_modules", "__pycache__") for part in real.split(os.sep)):
        raise ValueError("that file cannot be read as an image")
    if not os.path.isfile(real):
        raise ValueError("image not found")
    size = os.path.getsize(real)
    if size <= 0 or size > 4 * 1024 * 1024:
        raise ValueError("image is empty or larger than 4 MB")
    import mimetypes
    mime = mimetypes.guess_type(real)[0] or "image/png"
    if not mime.startswith("image/"):
        raise ValueError("that file is not an image")
    with open(real, "rb") as handle:
        encoded = base64.b64encode(handle.read()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def analyze_image(path_or_url, question="describe this image"):
    value = str(path_or_url or "").strip()
    try:
        if value.startswith(("http://", "https://")):
            img = _safe_url(value)
        else:
            img = _local_image_data_url(value)
        messages = [{"role": "user", "content": [
            {"type": "text", "text": str(question or "describe this image")[:1000]},
            {"type": "image_url", "image_url": {"url": img}},
        ]}]
        # Vision is a MoonMath-only capability; call_model's normal fallback
        # chain includes brains that cannot read images, so keep it empty.
        message = agent_mod().call_model(
            messages, None, brain="moonmath", tools=None, budget=45, fallbacks=())
        if message.get("_brain") in ("none", "offline"):
            return "vision failed: no vision-capable model answered"
        return message.get("content") or "no response"
    except ValueError as e:
        return f"vision failed: {e}"
    except Exception as e:
        return f"vision failed: {type(e).__name__}"
