"""Regression tests for the Python agent tools and security helpers.

The bridge's HTTP surface is exercised by tests/bridge.test.js. These tests
never call a real provider or send a real WhatsApp message.
"""

from __future__ import annotations

import base64
import contextlib
import importlib.util
import io
import json
import os
import re
import socket
import tempfile
import types
import unittest
import wave
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in os.sys.path:
    os.sys.path.insert(0, str(ROOT))

TEST_DATA = tempfile.mkdtemp(prefix="liam_test_data_")
os.environ["LIAM_DATA_DIR"] = TEST_DATA
os.environ["LIAM_DB"] = str(Path(TEST_DATA) / "memory.db")

import agent  # noqa: E402
import debug_probe  # noqa: E402
import liam_google  # noqa: E402
import liam_keys  # noqa: E402
import whatsapp_liam as wa  # noqa: E402

OWNER = agent.OWNERS[0]
ADMIN = next(iter(agent.ADMS))
MEMBER = "2348000000000"


class FakeResponse:
    def __init__(self, status=200, payload=None, invalid_json=False):
        self.status_code = status
        self.ok = 200 <= status < 300
        self._payload = payload
        self._invalid_json = invalid_json

    def json(self):
        if self._invalid_json:
            raise ValueError("not json")
        return self._payload


def write_file(path: Path, data: bytes = b"x") -> Path:
    path.write_bytes(data)
    return path


class ToolClientTests(unittest.TestCase):
    def setUp(self):
        self.token_file = Path(wa.TOKEN_FILE)
        self.token_file.parent.mkdir(parents=True, exist_ok=True)
        self.token_file.write_text("a" * 64, encoding="utf-8")

    def tearDown(self):
        try:
            self.token_file.unlink()
        except OSError:
            pass

    def test_missing_token_is_safe_error(self):
        self.token_file.unlink()
        with self.assertRaises(wa.ToolError) as ctx:
            wa._token()
        self.assertIn("not running", str(ctx.exception))

    def test_empty_token_is_safe_error(self):
        self.token_file.write_text("", encoding="utf-8")
        with self.assertRaises(wa.ToolError):
            wa._post("send", to="x", text="y")

    def test_post_sends_authenticated_json(self):
        response = FakeResponse(200, {"ok": True, "msg": "sent"})
        with mock.patch.object(wa.requests, "post", return_value=response) as post:
            self.assertEqual(wa._post("send", to="123", text="hi"), "sent")
        kwargs = post.call_args.kwargs
        self.assertEqual(kwargs["json"], {"action": "send", "to": "123", "text": "hi"})
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer " + "a" * 64)
        self.assertIn("timeout", kwargs)

    def test_http_error_returns_safe_message(self):
        response = FakeResponse(500, {"ok": False, "msg": "the WhatsApp action failed"})
        with mock.patch.object(wa.requests, "post", return_value=response):
            with self.assertRaises(wa.ToolError) as ctx:
                wa._post("send", to="123", text="hi")
        self.assertEqual(str(ctx.exception), "the WhatsApp action failed")

    def test_non_json_error_does_not_leak_body(self):
        response = FakeResponse(500, invalid_json=True)
        with mock.patch.object(wa.requests, "post", return_value=response):
            with self.assertRaises(wa.ToolError) as ctx:
                wa._post("send", to="123", text="hi")
        self.assertEqual(str(ctx.exception), "the WhatsApp action failed")

    def test_non_json_success_is_ok(self):
        response = FakeResponse(200, invalid_json=True)
        with mock.patch.object(wa.requests, "post", return_value=response):
            self.assertEqual(wa._post("stop"), "ok")

    def test_network_error_is_safe(self):
        with mock.patch.object(wa.requests, "post", side_effect=wa.requests.ConnectionError("boom")):
            with self.assertRaises(wa.ToolError) as ctx:
                wa._post("send", to="123", text="hi")
        self.assertIn("not reachable", str(ctx.exception))

    def test_send_voice_posts_mimetype_and_cleans_up(self):
        path = str(Path(TEST_DATA) / "voice.wav")
        Path(path).write_bytes(b"RIFF")
        with mock.patch.object(liam_google, "synth_voice", return_value=(path, "audio/wav")), \
                mock.patch.object(wa, "_post", return_value="sent") as post:
            self.assertEqual(wa.send_voice("2347000000000@c.us", "hello"), "sent")
        post.assert_called_once_with(
            "voice", to="2347000000000@c.us", path=path, mimetype="audio/wav", timeout=120)
        self.assertFalse(Path(path).exists())

    def test_send_voice_cleans_up_when_send_fails(self):
        path = str(Path(TEST_DATA) / "voice-fail.wav")
        Path(path).write_bytes(b"RIFF")
        with mock.patch.object(liam_google, "synth_voice", return_value=(path, "audio/wav")), \
                mock.patch.object(wa, "_post", side_effect=wa.ToolError("bridge down")):
            with self.assertRaises(wa.ToolError):
                wa.send_voice("2347000000000@c.us", "hello")
        self.assertFalse(Path(path).exists())

    def test_stop_and_control_files(self):
        with mock.patch.object(wa, "_post", return_value="stopping") as post:
            self.assertEqual(wa.stop(), "stopping")
        post.assert_called_once_with("stop")

        wa.set_stop(True)
        self.assertTrue(wa.get_stop())
        self.assertEqual(Path(wa.STOP_FILE).read_text(encoding="utf-8"), "1")
        wa.set_stop(False)
        self.assertFalse(wa.get_stop())
        self.assertEqual(Path(wa.STOP_FILE).read_text(encoding="utf-8"), "0")

    def test_leave_and_permission_actions(self):
        with mock.patch.object(wa, "_post", return_value="left") as post:
            self.assertEqual(wa.leave_group("123@g.us"), "left")
        post.assert_called_once_with("leave", jid="123@g.us")

        with mock.patch.object(wa, "_post", return_value="okay") as post:
            self.assertEqual(wa.permission("123@g.us", "2347000000000", True), "okay")
        post.assert_called_once_with(
            "permission", jid="123@g.us", who="2347000000000", allow=True)


class AgentToolTests(unittest.TestCase):
    def setUp(self):
        agent.set_brain("moonmath")
        wa.set_stop(False)

    def tearDown(self):
        agent.set_brain("moonmath")
        wa.set_stop(False)

    def test_config_owners_and_admins_are_shared(self):
        self.assertIn(OWNER, agent.OWNERS)
        self.assertIn(ADMIN, agent.ADMS)
        self.assertTrue(agent._is_owner(OWNER + "@c.us"))
        self.assertTrue(agent._is_admin(ADMIN + ":12"))
        self.assertFalse(agent._is_owner(MEMBER))
        self.assertFalse(agent._is_admin(MEMBER))

    def test_config_requires_an_owner(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "missing.json"
            with mock.patch.object(agent, "CONFIG_PATH", str(missing)):
                with self.assertRaises(RuntimeError):
                    agent._load_people()
            empty = Path(tmp) / "empty.json"
            empty.write_text(json.dumps({"owners": []}), encoding="utf-8")
            with mock.patch.object(agent, "CONFIG_PATH", str(empty)):
                with self.assertRaises(RuntimeError):
                    agent._load_people()
            valid = Path(tmp) / "valid.json"
            valid.write_text(json.dumps({
                "owners": ["2347000000000@c.us"],
                "admins": {"2347000000001": {"name": "A", "is": "friend", "she_calls": ["A"]}},
            }), encoding="utf-8")
            with mock.patch.object(agent, "CONFIG_PATH", str(valid)):
                owners, admins = agent._load_people()
            self.assertEqual(owners, ["2347000000000"])
            self.assertEqual(admins["2347000000001"]["name"], "A")

    def test_all_schemas_are_closed_objects(self):
        for schema in agent.SCHEMAS:
            params = schema["function"]["parameters"]
            self.assertIs(params.get("additionalProperties"), False, schema["function"]["name"])
        names = {schema["function"]["name"] for schema in agent.SCHEMAS}
        self.assertIn("send_voice", names)
        self.assertNotIn("start_call", names)
        self.assertNotIn("send_file", names)

    def test_owner_only_tools_are_hidden_from_members(self):
        member_names = {s["function"]["name"] for s in agent._schemas_for(MEMBER)}
        self.assertTrue(agent.OWNER_ONLY_TOOLS.isdisjoint(member_names))
        owner_names = {s["function"]["name"] for s in agent._schemas_for(OWNER)}
        self.assertTrue(agent.OWNER_ONLY_TOOLS.issubset(owner_names))

    def test_outbound_tools_are_owner_only(self):
        with mock.patch.object(agent.wa, "send_message", return_value="sent") as send:
            self.assertIn("only the owner", agent._tools_for(MEMBER)["send_dm"]("2347", "hi"))
            send.assert_not_called()
            self.assertEqual(agent._tools_for(OWNER)["send_dm"]("2347", "hi"), "sent")
            send.assert_called_once_with("2347", "hi")
        with mock.patch.object(agent, "stop_task", return_value="stopping") as stop:
            self.assertIn("only the owner", agent._tools_for(MEMBER)["stop_task"]())
            stop.assert_not_called()
            self.assertEqual(agent._tools_for(OWNER)["stop_task"](), "stopping")
            stop.assert_called_once_with()

    def test_leave_uses_the_current_group(self):
        jid = "120363000000000000@g.us"
        with mock.patch.object(agent.wa, "leave_group", return_value="left") as leave:
            self.assertEqual(agent._tools_for(OWNER, jid)["leave_group"](), "left")
            leave.assert_called_once_with(jid)
            self.assertIn("only the owner", agent._tools_for(MEMBER, jid)["leave_group"]())
            self.assertEqual(leave.call_count, 1)

    def test_leave_without_group_is_honest(self):
        self.assertIn("inside it", agent.leave_group(None))
        with mock.patch.object(agent.wa, "leave_group", return_value="left") as leave:
            self.assertEqual(agent.leave_group("123@g.us"), "left")
        leave.assert_called_once_with("123@g.us")

    def test_memory_tools_are_scoped(self):
        with mock.patch.object(agent, "remember", return_value="ok") as remember:
            agent._tools_for(MEMBER)["remember"](user="owner", fact="fact")
            remember.assert_called_once_with(MEMBER, "fact", source=MEMBER, scope="personal")
        with mock.patch.object(agent, "remember", return_value="ok") as remember:
            agent._tools_for(OWNER)["remember"](user="babe", fact="fact")
            remember.assert_called_once_with(OWNER, "fact", source=OWNER, scope="personal")
        with mock.patch.object(agent, "remember", return_value="ok") as remember:
            admin_name = agent.ADMS[ADMIN]["name"]
            agent._tools_for(OWNER)["remember"](user=admin_name, fact="fact")
            remember.assert_called_once_with(ADMIN, "fact", source=OWNER, scope="personal")

    def test_brain_switch_is_owner_only(self):
        self.assertIn("only the owner", agent.switch_brain("moon", MEMBER))
        self.assertEqual(agent.get_brain(), "moonmath")
        self.assertEqual(agent.switch_brain("moon", OWNER), "switched to moonmath")
        self.assertEqual(agent.get_brain(), "moonmath")
        with self.assertRaises(ValueError):
            agent.set_brain("does-not-exist")
        self.assertEqual(agent._normalize_brain("hugging face"), "huggingface")
        self.assertEqual(agent._normalize_brain("8b"), "hermes")

    def test_stop_task_uses_bridge_with_file_fallback(self):
        with mock.patch.object(agent.wa, "stop", return_value="stopping") as stop:
            self.assertEqual(agent.stop_task(), "stopping")
        stop.assert_called_once_with()

        with mock.patch.object(agent.wa, "stop", side_effect=agent.wa.ToolError("down")), \
                mock.patch.object(agent.wa, "set_stop") as set_stop:
            self.assertIn("stopping", agent.stop_task())
        set_stop.assert_called_once_with(True)

    def test_send_image_removes_temp_file(self):
        path = Path(agent._unique_file(".png"))
        path.write_bytes(b"PNG")
        with mock.patch.object(liam_google, "generate_image", return_value=str(path)), \
                mock.patch.object(agent.wa, "send_image", return_value="sent"):
            self.assertEqual(agent.send_image("2347", "a cat"), "sent")
        self.assertFalse(path.exists())

        path = Path(agent._unique_file(".png"))
        path.write_bytes(b"PNG")
        with mock.patch.object(liam_google, "generate_image", return_value=str(path)), \
                mock.patch.object(agent.wa, "send_image", side_effect=RuntimeError("no")):
            with self.assertRaises(RuntimeError):
                agent.send_image("2347", "a cat")
        self.assertFalse(path.exists())

    def test_check_tokens_never_prints_keys(self):
        text = agent.check_tokens()
        self.assertIn("Current brain:", text)
        self.assertIn("Provider quotas", text)
        self.assertNotIn("sk-", text)
        self.assertNotIn("hf_", text)

    def test_probe_without_key_returns_reason(self):
        self.assertEqual(agent._probe("http://127.0.0.1:1", "model", "", timeout=1),
                         (False, "no key configured"))

    def test_unique_temp_files_do_not_collide(self):
        paths = {agent._unique_file(".png") for _ in range(8)}
        self.assertEqual(len(paths), 8)
        for path in paths:
            self.assertEqual(Path(path).parent.resolve(), Path(agent.OUTBOX_DIR).resolve())
            os.remove(path)


class UrlSafetyTests(unittest.TestCase):
    def test_rejects_local_and_non_http_targets(self):
        for value in (
            "file:///C:/Windows/win.ini",
            "ftp://example.com/file",
            "http://localhost/",
            "http://127.0.0.1:5678/",
            "http://10.0.0.1/",
            "http://100.64.0.1/",
            "http://169.254.169.254/latest/meta-data/",
            "https://user:pass@example.com/",
            "http://printer.local/",
            "",
        ):
            with self.assertRaises(ValueError, msg=value):
                agent._safe_url(value)

    def test_accepts_public_addresses(self):
        info = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]
        with mock.patch.object(agent.socket, "getaddrinfo", return_value=info):
            self.assertEqual(agent._safe_url("https://example.com/page"),
                             "https://example.com/page")

    def test_rejects_unresolvable_hosts(self):
        with mock.patch.object(agent.socket, "getaddrinfo", side_effect=socket.gaierror("no")):
            with self.assertRaises(ValueError):
                agent._safe_url("https://does-not-exist.example/")

    def test_screenshot_checks_subprocess_exit_code(self):
        with mock.patch.object(agent, "_safe_url", return_value="https://example.com"), \
                mock.patch.object(agent.subprocess, "run",
                                  return_value=types.SimpleNamespace(returncode=1)), \
                mock.patch.object(agent.wa, "send_image") as send:
            with self.assertRaises(RuntimeError):
                agent.screenshot("2347", "https://example.com")
        send.assert_not_called()

    def test_screenshot_sends_a_real_capture(self):
        def fake_run(cmd, **kwargs):
            Path(cmd[-1]).write_bytes(b"PNG")
            return types.SimpleNamespace(returncode=0)

        with mock.patch.object(agent, "_safe_url", return_value="https://example.com"), \
                mock.patch.object(agent.subprocess, "run", side_effect=fake_run), \
                mock.patch.object(agent.wa, "send_image", return_value="sent") as send:
            self.assertEqual(agent.screenshot("2347", "https://example.com"), "sent")
        send.assert_called_once()
        self.assertEqual(Path(send.call_args.args[1]).suffix, ".png")


class GoogleHelperTests(unittest.TestCase):
    def test_missing_key_is_honest(self):
        with mock.patch.object(liam_keys, "GOOGLE_API_KEY", ""):
            with self.assertRaises(liam_google.GoogleUnavailable):
                liam_google.synth_voice("hello")
            with self.assertRaises(liam_google.GoogleUnavailable):
                liam_google.generate_image("hello")

    def test_pcm_is_wrapped_as_wav(self):
        path, mime = liam_google._write_audio(b"\x00\x01" * 8, "audio/L16;rate=16000")
        try:
            self.assertEqual(mime, "audio/wav")
            self.assertTrue(path.endswith(".wav"))
            with wave.open(path, "rb") as handle:
                self.assertEqual(handle.getnchannels(), 1)
                self.assertEqual(handle.getsampwidth(), 2)
                self.assertEqual(handle.getframerate(), 16000)
        finally:
            os.remove(path)

    def test_encoded_audio_keeps_real_type(self):
        cases = [
            ("audio/wav", b"RIFF", ".wav", "audio/wav"),
            ("audio/mpeg", b"ID3", ".mp3", "audio/mpeg"),
            ("audio/ogg", b"OggS", ".ogg", "audio/ogg"),
        ]
        for source, raw, suffix, expected in cases:
            path, mime = liam_google._write_audio(raw, source)
            try:
                self.assertEqual(mime, expected)
                self.assertTrue(path.endswith(suffix))
            finally:
                os.remove(path)
        with self.assertRaises(RuntimeError):
            liam_google._write_audio(b"x", "audio/webm")

    def test_ogg_conversion_is_optional(self):
        path, _ = liam_google._write_audio(b"RIFF", "audio/wav")
        try:
            with mock.patch.object(liam_google.shutil, "which", return_value=None):
                self.assertIsNone(liam_google._to_ogg(path, "audio/wav"))
        finally:
            os.remove(path)

    def test_generate_image_returns_unique_files(self):
        payload = {
            "candidates": [{"content": {"parts": [
                {"inlineData": {"data": base64.b64encode(b"PNGDATA").decode()}}
            ]}}]
        }
        with mock.patch.object(liam_google, "_post", return_value=payload):
            first = liam_google.generate_image("one")
            second = liam_google.generate_image("two")
        try:
            self.assertNotEqual(first, second)
            self.assertEqual(Path(first).read_bytes(), b"PNGDATA")
            self.assertEqual(Path(second).read_bytes(), b"PNGDATA")
        finally:
            for path in (first, second):
                os.remove(path)

    def test_generate_image_requires_media(self):
        with mock.patch.object(liam_google, "_post", return_value={"candidates": []}):
            with self.assertRaises(RuntimeError):
                liam_google.generate_image("one")

    def test_http_errors_are_readable(self):
        error = liam_google.urllib.error.HTTPError(
            "https://example.test", 403, "Forbidden", {}, io.BytesIO(b"denied"))
        with mock.patch.object(liam_keys, "GOOGLE_API_KEY", "test-key"), \
                mock.patch.object(liam_google.urllib.request, "urlopen", side_effect=error):
            with self.assertRaises(RuntimeError) as ctx:
                liam_google._post("model", {})
        self.assertIn("HTTP 403", str(ctx.exception))


class HygieneTests(unittest.TestCase):
    def test_tracked_sources_have_no_hardcoded_keys(self):
        pattern = r"(sk-[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,})"
        for name in (
            "agent.py", "whatsapp_liam.py", "liam_google.py", "liam_keys.py",
            "whatsapp_bridge.js", "debug_probe.py", "liam_config.json",
        ):
            text = (ROOT / name).read_text(encoding="utf-8")
            self.assertIsNone(re.search(pattern, text), name)
        self.assertTrue(hasattr(liam_keys, "GOOGLE_API_KEY"))

    def test_debug_probe_reuses_agent_probe(self):
        fake = dict(agent.BRAINS["moonmath"])
        fake["keys"] = ["one", "two"]
        with mock.patch.dict(agent.BRAINS, {"moonmath": fake}), \
                mock.patch.object(agent, "_probe",
                                  side_effect=[(False, "HTTP 429"), (True, "")]) as probe:
            self.assertEqual(debug_probe.probe("moonmath", timeout=1), (True, ""))
        self.assertEqual(probe.call_count, 2)

    def test_debug_probe_output_has_no_keys(self):
        with mock.patch.object(debug_probe, "probe", return_value=(True, "")):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(debug_probe.main(["moonmath"]), 0)
        self.assertIn("moonmath", out.getvalue())
        self.assertNotIn("sk-", out.getvalue())

    def test_check_domain_has_no_import_side_effect(self):
        path = ROOT / "tools" / "check_domain.py"
        spec = importlib.util.spec_from_file_location("check_domain", path)
        module = importlib.util.module_from_spec(spec)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            spec.loader.exec_module(module)
        self.assertEqual(out.getvalue(), "")
        self.assertEqual(err.getvalue(), "")
        with mock.patch.object(module.socket, "getaddrinfo", return_value=[(None, None, None, None, ("1.2.3.4", 0))]):
            self.assertIn("1.2.3.4", module.get_domain_info("example.com"))
        with contextlib.redirect_stderr(err):
            self.assertEqual(module.main([]), 2)


if __name__ == "__main__":
    unittest.main()
