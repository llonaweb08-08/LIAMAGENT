from __future__ import annotations

import imaplib
import ipaddress
import json
import os
import re
import shlex
import socket
import urllib.error
import urllib.parse
import urllib.request

import liam_keys

from .runtime import BASE_DIR, FILE_READ_MAX, SHELL_OUTPUT_MAX, _atomic_write_text, _env_int
from .state import _clamp_timeout

_BLOCKED_HOST_SUFFIXES = (".local", ".internal", ".localhost", ".home", ".lan")


def _generous_timeout(env_name, default=3600):
    """No short per-call cap; only the overall turn deadline bounds a call."""
    return _clamp_timeout(_env_int(env_name, default, 5, 7200))


def _safe_url(url: str) -> str:
    """Only allow public http(s) targets; block file://, localhost and SSRF."""
    value = str(url or "").strip()
    try:
        parsed = urllib.parse.urlparse(value)
        port = parsed.port if parsed.port is not None else (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise ValueError("that URL is not valid") from exc
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("only public http(s) URLs are allowed")
    if parsed.username or parsed.password:
        raise ValueError("URLs with credentials are not allowed")
    host = parsed.hostname.lower().rstrip(".")
    if host == "localhost" or any(host.endswith(suffix) for suffix in _BLOCKED_HOST_SUFFIXES):
        raise ValueError("local addresses are not allowed")
    try:
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError("could not resolve that site") from exc
    if not addresses:
        raise ValueError("could not resolve that site")
    for info in addresses:
        try:
            ip = ipaddress.ip_address(str(info[4][0]).split("%", 1)[0])
        except ValueError as exc:
            raise ValueError("could not resolve that site") from exc
        if not ip.is_global:
            raise ValueError("local addresses are not allowed")
    return value


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-run the SSRF check on every redirect target."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _safe_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open_url(url, timeout=None, headers=None):
    request = urllib.request.Request(url, headers=dict(headers or {}))
    opener = urllib.request.build_opener(_SafeRedirectHandler())
    return opener.open(request, timeout=timeout or _generous_timeout("LIAM_WEB_TIMEOUT"))


def _http_json(url, payload=None, headers=None, timeout=None):
    from ._compat import agent_mod
    try:
        ua = agent_mod().liam_keys.BROWSER_UA
    except Exception:
        ua = liam_keys.BROWSER_UA
    data = None
    request_headers = {
        "User-Agent": ua,
        "Accept": "application/json",
    }
    request_headers.update(headers or {})
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=request_headers)
    opener = urllib.request.build_opener(_SafeRedirectHandler())
    with opener.open(request, timeout=timeout or _generous_timeout("LIAM_WEB_TIMEOUT")) as response:
        return json.loads(response.read().decode("utf-8", "replace"))


def web_fetch(url):
    from ._compat import agent_mod
    a = agent_mod()
    safe = a._safe_url(url)
    try:
        timeout = _generous_timeout("LIAM_FETCH_TIMEOUT")
        with a._open_url(safe, timeout=timeout, headers={
            "User-Agent": a.liam_keys.BROWSER_UA,
            "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        }) as response:
            data = response.read(300000)
            charset = response.headers.get_content_charset() or "utf-8"
        text = data.decode(charset, "replace")
        # Strip active content and markup, then collapse whitespace.
        text = re.sub(r"<script.*?</script>", " ", text, flags=re.S | re.I)
        text = re.sub(r"<style.*?</style>", " ", text, flags=re.S | re.I)
        text = re.sub(r"<noscript.*?</noscript>", " ", text, flags=re.S | re.I)
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        return text[:8000] or "(empty page)"
    except ValueError:
        raise
    except Exception as e:
        return f"fetch failed: {type(e).__name__}"


def _search_tavily(query):
    from ._compat import agent_mod
    a = agent_mod()
    body = a._http_json("https://api.tavily.com/search", {
        "api_key": a.liam_keys.TAVILY_API_KEY,
        "query": query,
        "max_results": 8,
        "search_depth": "basic",
    })
    out = []
    for item in (body.get("results") or [])[:8]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip() or "(untitled)"
        link = str(item.get("url") or "").strip()
        snippet = re.sub(r"\s+", " ", str(item.get("content") or "")).strip()[:240]
        out.append(f"- {title}: {link}" + (f"\n  {snippet}" if snippet else ""))
    return out


def _search_brave(query):
    from ._compat import agent_mod
    a = agent_mod()
    url = "https://api.search.brave.com/res/v1/web/search?" + urllib.parse.urlencode({
        "q": query, "count": 8, "safesearch": "moderate",
    })
    body = a._http_json(url, headers={
        "X-Subscription-Token": a.liam_keys.BRAVE_API_KEY,
        "Accept": "application/json",
    })
    out = []
    for item in (((body.get("web") or {}).get("results")) or [])[:8]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip() or "(untitled)"
        link = str(item.get("url") or "").strip()
        snippet = re.sub(r"\s+", " ", str(item.get("description") or "")).strip()[:240]
        out.append(f"- {title}: {link}" + (f"\n  {snippet}" if snippet else ""))
    return out


def _search_serper(query):
    from ._compat import agent_mod
    a = agent_mod()
    body = a._http_json("https://google.serper.dev/search", {
        "q": query, "num": 8,
    }, headers={"X-API-KEY": a.liam_keys.SERPER_API_KEY})
    out = []
    for item in (body.get("organic") or [])[:8]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip() or "(untitled)"
        link = str(item.get("link") or "").strip()
        snippet = re.sub(r"\s+", " ", str(item.get("snippet") or "")).strip()[:240]
        out.append(f"- {title}: {link}" + (f"\n  {snippet}" if snippet else ""))
    return out


def _ddg_target(href):
    value = str(href or "").replace("&amp;", "&")
    if value.startswith("//"):
        value = "https:" + value
    parsed = urllib.parse.urlparse(value)
    if parsed.hostname and parsed.hostname.endswith("duckduckgo.com") and parsed.path.startswith("/l/"):
        target = urllib.parse.parse_qs(parsed.query).get("uddg", [""])[0]
        return urllib.parse.unquote(target) or value
    return value


def _ddg_clean_title(raw):
    title = re.sub(r"<.*?>", " ", str(raw or ""))
    return re.sub(r"\s+", " ", title).strip()


def _ddg_parse_html(page):
    out = []
    for match in re.finditer(
            r'class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', page, re.S):
        link = _ddg_target(match.group(1))
        title = _ddg_clean_title(match.group(2)) or "(untitled)"
        try:
            _safe_url(link)
        except ValueError:
            continue
        out.append(f"- {title}: {link}")
        if len(out) >= 8:
            break
    return out


def _ddg_parse_lite(page):
    out, seen = [], set()
    for match in re.finditer(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', page, re.S):
        raw = match.group(1)
        if "uddg=" not in raw and not raw.startswith(("http://", "https://", "//")):
            continue
        link = _ddg_target(raw)
        if not link.startswith(("http://", "https://")) or link in seen:
            continue
        parsed = urllib.parse.urlparse(link)
        if parsed.hostname and "duckduckgo.com" in parsed.hostname:
            continue
        title = _ddg_clean_title(match.group(2))
        if not title:
            continue
        try:
            _safe_url(link)
        except ValueError:
            continue
        seen.add(link)
        out.append(f"- {title}: {link}")
        if len(out) >= 8:
            break
    return out


def _search_duckduckgo(query):
    # Try the classic html endpoint first, then the lighter lite endpoint, which
    # is friendlier to cloud IPs where the html endpoint sometimes errors.
    from ._compat import agent_mod
    a = agent_mod()
    try:
        ua = a.liam_keys.BROWSER_UA
    except Exception:
        ua = liam_keys.BROWSER_UA
    headers = {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
    }
    encoded = urllib.parse.urlencode({"q": query})
    endpoints = (
        ("html", "https://html.duckduckgo.com/html/?" + encoded, a._ddg_parse_html),
        ("lite", "https://lite.duckduckgo.com/lite/?" + encoded, a._ddg_parse_lite),
    )
    problems = []
    for name, url, parser in endpoints:
        try:
            with a._open_url(url, headers=headers) as response:
                page = response.read(400000).decode("utf-8", "replace")
            results = parser(page)
            if results:
                return results
            problems.append(f"{name}: no results")
        except Exception as e:
            problems.append(f"{name}: {type(e).__name__}")
    raise RuntimeError("; ".join(problems) or "no results")


def web_search(query):
    from ._compat import agent_mod
    a = agent_mod()
    text = str(query or "").strip()
    if not text:
        return "nothing to search for"
    providers = []
    if a.liam_keys.TAVILY_API_KEY:
        providers.append(("Tavily", a._search_tavily))
    if a.liam_keys.BRAVE_API_KEY:
        providers.append(("Brave", a._search_brave))
    if a.liam_keys.SERPER_API_KEY:
        providers.append(("Serper", a._search_serper))
    providers.append(("DuckDuckGo", a._search_duckduckgo))
    failures = []
    for name, provider in providers:
        try:
            results = provider(text)
            if results:
                return "\n".join(results)
            failures.append(f"{name}: no results")
        except Exception as e:
            failures.append(f"{name}: {type(e).__name__}")
    return "search failed - " + "; ".join(failures[:3])


def file_read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            return handle.read(FILE_READ_MAX)[:FILE_READ_MAX]
    except Exception as e:
        return f"read failed: {type(e).__name__}"


def file_write(path, content):
    try:
        value = str(content or "")
        _atomic_write_text(path, value, mode=0o600)
        return f"wrote {len(value)} bytes to {path}"
    except Exception as e:
        return f"write failed: {type(e).__name__}"


def shell_exec(command, timeout=None):
    from ._compat import agent_mod
    sp = agent_mod().subprocess
    try:
        if isinstance(command, (list, tuple)):
            args = [str(x) for x in command]
        else:
            text = str(command or "").strip()
            if not text:
                return "empty command"
            if len(text) > 4000:
                return "command is too long"
            args = shlex.split(text, posix=(os.name != "nt"))
        if not args:
            return "empty command"
        timeout = _generous_timeout("LIAM_SHELL_TIMEOUT", int(timeout or 3600))
        result = sp.run(
            args, shell=False, capture_output=True, text=True, timeout=timeout)
        output = ((result.stdout or "") + (result.stderr or ""))[:SHELL_OUTPUT_MAX]
        return f"exit={result.returncode}\n{output}"
    except sp.TimeoutExpired:
        return "command timed out"
    except Exception as e:
        return f"exec failed: {type(e).__name__}"


def email_read(host="", username="", password="", folder="INBOX", limit=5):
    """Read recent mail. Credentials come from LIAM_EMAIL_* env vars by default."""
    host = str(host or os.environ.get("LIAM_EMAIL_HOST") or "").strip()
    username = str(username or os.environ.get("LIAM_EMAIL_USER") or "").strip()
    password = str(password or os.environ.get("LIAM_EMAIL_PASSWORD") or "")
    folder = str(folder or os.environ.get("LIAM_EMAIL_FOLDER") or "INBOX").strip() or "INBOX"
    if not host or not username or not password:
        return "email is not configured (set LIAM_EMAIL_HOST, LIAM_EMAIL_USER and LIAM_EMAIL_PASSWORD)"
    mail = None
    try:
        import email
        port = _env_int("LIAM_EMAIL_PORT", 993, 1, 65535)
        timeout = _generous_timeout("LIAM_EMAIL_TIMEOUT")
        limit = max(1, min(20, int(limit or 5)))
        mail = imaplib.IMAP4_SSL(host, port, timeout=timeout)
        mail.login(username, password)
        status, _ = mail.select(folder, readonly=True)
        if status != "OK":
            return f"could not open folder {folder}"
        status, data = mail.search(None, "ALL")
        if status != "OK" or not data:
            return "could not search the mailbox"
        ids = (data[0] or b"").split()[-limit:]
        out = []
        for message_id in ids:
            status, message_data = mail.fetch(message_id, "(RFC822)")
            if status != "OK" or not message_data:
                continue
            raw = next((part[1] for part in message_data
                        if isinstance(part, tuple) and len(part) > 1), b"")
            message = email.message_from_bytes(raw)
            body = ""
            if message.is_multipart():
                for part in message.walk():
                    if part.get_content_type() != "text/plain":
                        continue
                    if "attachment" in str(part.get("Content-Disposition") or "").lower():
                        continue
                    payload = part.get_payload(decode=True) or b""
                    body = payload.decode(part.get_content_charset() or "utf-8", "replace")
                    break
            else:
                payload = message.get_payload(decode=True) or b""
                body = payload.decode(message.get_content_charset() or "utf-8", "replace")
            out.append(f"From: {message.get('From')}\nSubject: {message.get('Subject')}\n{body[:500]}")
        return "\n---\n".join(out) if out else "no messages"
    except Exception as e:
        return f"email read failed: {type(e).__name__}"
    finally:
        if mail is not None:
            try:
                mail.logout()
            except Exception:
                pass


def create_tool(name, code):
    # Inert: writes a module file only. Nothing in this agent auto-imports tools/.
    safe = re.sub(r"[^a-zA-Z0-9_]", "", str(name or ""))
    if not safe or safe[0].isdigit():
        return "invalid tool name"
    tools_dir = os.path.join(BASE_DIR, "tools")
    os.makedirs(tools_dir, exist_ok=True)
    path = os.path.join(tools_dir, safe + ".py")
    try:
        _atomic_write_text(path, str(code or ""), mode=0o600)
    except OSError as e:
        return f"create failed: {type(e).__name__}: {e}"
    return f"created tool file {path}; manual review required (no auto-load)"
