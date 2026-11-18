import json
import os
import subprocess
import sys
import tempfile
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class SmokeTest(unittest.TestCase):
    def test_agent_roundtrip(self):
        env = dict(os.environ)
        env["LIAM_DATA_DIR"] = tempfile.mkdtemp()
        env["LIAM_DB"] = os.path.join(env["LIAM_DATA_DIR"], "t.db")
        env["LIAM_OFFLINE"] = "1"  # never call a real provider in tests
        proc = subprocess.Popen(
            [sys.executable, "-X", "utf8", "agent.py"],
            cwd=BASE, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, env=env)
        stderr = ""
        try:
            line = proc.stdout.readline(4096).strip()
            self.assertTrue(line.startswith("{"))
            payload = {"u": "hello", "s": "2347035634340", "i": "smoke-1"}
            proc.stdin.write(json.dumps(payload) + "\n")
            proc.stdin.flush()
            out = proc.stdout.readline(4096).strip()
            msg = json.loads(out)
            self.assertIn("reply", msg)
            self.assertTrue(isinstance(msg["reply"], str))
        finally:
            try:
                if proc.stdin:
                    proc.stdin.close()
            except Exception:
                pass
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
            if proc.stderr:
                stderr = proc.stderr.read(8192)
                proc.stderr.close()
            try:
                if proc.stdout:
                    proc.stdout.close()
            except Exception:
                pass
        self.assertNotIn("Traceback", stderr)


if __name__ == "__main__":
    unittest.main()
