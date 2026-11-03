import json, os, subprocess, sys, tempfile, unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

class SmokeTest(unittest.TestCase):
    def test_agent_roundtrip(self):
        env = dict(os.environ)
        env["LIAM_DATA_DIR"] = tempfile.mkdtemp()
        env["LIAM_DB"] = os.path.join(env["LIAM_DATA_DIR"], "t.db")
        proc = subprocess.Popen(
            [sys.executable, "-X", "utf8", "agent.py"],
            cwd=BASE, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, env=env)
        try:
            line = proc.stdout.readline().strip()
            self.assertTrue(line.startswith("{"))
            payload = {"u": "hello", "s": "2347035634340"}
            proc.stdin.write(json.dumps(payload) + "\n")
            proc.stdin.flush()
            out = proc.stdout.readline().strip()
            msg = json.loads(out)
            self.assertIn("reply", msg)
            self.assertTrue(isinstance(msg["reply"], str))
        finally:
            proc.terminate()
            proc.wait(timeout=10)

if __name__ == "__main__":
    unittest.main()