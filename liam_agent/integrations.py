from __future__ import annotations

import base64
import json
import os
import re
import shlex
import time

import liam_keys

from ._compat import agent_mod
from .people import OWNERS
from .runtime import BASE_DIR, DATA_DIR, _env_int, _log, _safe_remove, _unique_file
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
    if left is not None:
        seconds = max(5, min(seconds, int(left)))
    return agent_mod().wa.vps_exec(
        command, timeout=seconds, cwd=cwd, sender=sender, chat=chat, group=group)


def report_progress(text, sender=None):
    try:
        return agent_mod().wa.send_message(OWNERS[0], str(text or ""), sender=sender or OWNERS[0])
    except Exception as e:
        return f"progress report failed: {type(e).__name__}"


def _emit_progress(text):
    from . import state
    value = " ".join(str(text or "").split()).strip()
    if not value:
        return "nothing to report"
    if len(value) > 1200:
        value = value[:1200].rstrip() + "…"
    try:
        a = agent_mod()
        now = time.monotonic()
        # Specific fix for progress spam: do not send the exact same update again
        # in quick succession (common when a slow tool is called repeatedly), and
        # rate-limit explicit progress messages so a chat is never flooded.
        last_text = str(getattr(state, "_LAST_PROGRESS_TEXT", "") or "")
        last_emit = float(getattr(state, "_LAST_PROGRESS_EMIT_AT", 0.0) or 0.0)
        if value == last_text and (now - last_emit) < _env_int("LIAM_PROGRESS_DEDUPE", 120, 10, 3600):
            state._LAST_PROGRESS_AT = now
            a._LAST_PROGRESS_AT = now
            return "sent (already reported)"
        if (now - last_emit) < _env_int("LIAM_PROGRESS_MIN_GAP", 8, 0, 600):
            state._LAST_PROGRESS_AT = now
            a._LAST_PROGRESS_AT = now
            return "progress update rate-limited"
        print(json.dumps({"progress": value}, ensure_ascii=False), flush=True)
    except Exception:
        return "couldn't send that update"
    now = time.monotonic()
    state._LAST_PROGRESS_AT = now
    agent_mod()._LAST_PROGRESS_AT = now
    state._LAST_PROGRESS_TEXT = value
    agent_mod()._LAST_PROGRESS_TEXT = value
    state._LAST_PROGRESS_EMIT_AT = now
    agent_mod()._LAST_PROGRESS_EMIT_AT = now
    return "sent"


_AUTO_PROGRESS = {
    "browser_task": "I'm working on the browser task now - give me a moment.",
    "screenshot": "Taking the screenshot now - one moment.",
    "vps_exec": "Running that on the pentest machine now - give me a moment.",
    "web_fetch": "Fetching that page now - one moment.",
    "email_read": "Checking your inbox now - one moment.",
    "analyze_image": "Looking at that image now - one moment.",
    "shell_exec": "Running that command now - one moment.",
}


def _auto_progress_text(name):
    return _AUTO_PROGRESS.get(name, "Working on it - give me a moment.")


SLOW_TOOLS = {"browser_task", "screenshot", "vps_exec", "web_fetch",
              "email_read", "analyze_image", "shell_exec"}

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
    agent_mod().vps_exec("mkdir -p " + VPS_BROWSER_DIR, timeout=30, sender=OWNERS[0])
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
        with open(path, "wb") as handle:
            handle.write(base64.b64decode(data))
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


def _local_image_data_url(path):
    real = os.path.realpath(os.path.abspath(str(path or "")))
    roots = [os.path.realpath(DATA_DIR), os.path.realpath(BASE_DIR)]
    if not any(real == root or real.startswith(root + os.sep) for root in roots):
        raise ValueError("local images must be inside the Liam data directory")
    if not os.path.isfile(real):
        raise ValueError("image not found")
    size = os.path.getsize(real)
    if size <= 0 or size > 4 * 1024 * 1024:
        raise ValueError("image is empty or larger than 4 MB")
    mime = __import__('mimetypes').guess_type(real)[0] or "image/png"
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
        message = agent_mod().call_model(messages, None, brain="moonmath", tools=None, budget=45)
        return message.get("content") or "no response"
    except ValueError as e:
        return f"vision failed: {e}"
    except Exception as e:
        return f"vision failed: {type(e).__name__}"
