"""Hermetic tests for claude_cli_shim.py (W1.3, produce-lane overnight plan).

Everything runs against a FAKE `claude` script (a small python3 script this file
writes to a temp dir and points MOSH_CLAUDE_BIN at) — no network, and the real
`claude` binary is never invoked. Run via gate.sh run_py_tests (named
*_test.py; discovered because it lives under service/), meant to pass under the
system interpreter (pyenv 3.12) and stay 3.11-clean (stdlib only: no pytest
features beyond plain asserts + fixtures optional).
"""
import json
import os
import stat
import sys
import tempfile
import textwrap
import threading
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # service/brain_shim/
import claude_cli_shim as shim


# ---------------------------------------------------------------------------
# Pure-function unit tests (no subprocess, no server).
# ---------------------------------------------------------------------------

def test_map_model_passthrough_and_aliases():
    assert shim.map_model("sonnet") == "sonnet"
    assert shim.map_model("opus") == "opus"
    assert shim.map_model("haiku") == "haiku"
    assert shim.map_model("anthropic/claude-sonnet-5") == "sonnet"
    assert shim.map_model("anthropic/claude-opus-5") == "opus"
    # Unknown model: best-effort passthrough (claude -p rejects it itself).
    assert shim.map_model("some-other-model") == "some-other-model"
    # No model given: default to sonnet.
    assert shim.map_model(None) == "sonnet"
    assert shim.map_model("") == "sonnet"


def test_strip_fences_json_and_plain():
    assert shim.strip_fences('```json\n{"a":1}\n```') == '{"a":1}'
    assert shim.strip_fences('```\n{"a":1}\n```') == '{"a":1}'
    # Not fenced: unchanged.
    assert shim.strip_fences('{"a":1}') == '{"a":1}'
    # Only ever called in json_mode, but must not crash on free text either.
    assert shim.strip_fences("plain text, no fences") == "plain text, no fences"


def test_render_prompt_system_and_transcript():
    messages = [
        {"role": "system", "content": "You are terse."},
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi"},
        {"role": "user", "content": "bye"},
    ]
    system_prompt, prompt = shim.render_prompt(messages, json_mode=False)
    assert system_prompt == "You are terse."
    assert "User: hello" in prompt and "Assistant: hi" in prompt and "User: bye" in prompt
    # No JSON-mode instruction leaks in when not requested.
    assert "JSON object" not in prompt


def test_render_prompt_json_mode_appends_instruction():
    messages = [{"role": "user", "content": "ping"}]
    _, prompt = shim.render_prompt(messages, json_mode=True)
    assert "User: ping" in prompt
    assert "JSON object" in prompt and "fences" in prompt.lower()


def test_render_prompt_multiple_system_messages_join():
    messages = [
        {"role": "system", "content": "part one."},
        {"role": "system", "content": "part two."},
        {"role": "user", "content": "hi"},
    ]
    system_prompt, _ = shim.render_prompt(messages, json_mode=False)
    assert "part one." in system_prompt and "part two." in system_prompt


def test_classify_error_status():
    assert shim.classify_error_status(429, "anything") == 429
    assert shim.classify_error_status(529, "anything") == 529   # 5xx-shaped
    assert shim.classify_error_status(500, "anything") == 500
    assert shim.classify_error_status(404, "not found") == 502  # not 429/5xx -> generic
    assert shim.classify_error_status(None, "Claude AI usage limit reached") == 429
    assert shim.classify_error_status(None, "the API is overloaded, try again") == 429
    assert shim.classify_error_status(None, "error code: 529") == 429
    assert shim.classify_error_status(None, "some other failure") == 502


def test_build_argv_shape_and_never_bare():
    argv = shim.build_argv("claude", "PROMPT", "sonnet", "SYS")
    assert argv[0] == "claude"
    assert "--bare" not in argv
    assert argv[argv.index("-p") + 1] == "PROMPT"
    assert argv[argv.index("--model") + 1] == "sonnet"
    assert argv[argv.index("--system-prompt") + 1] == "SYS"
    assert argv[argv.index("--output-format") + 1] == "json"
    assert argv[argv.index("--tools") + 1] == ""
    assert "--strict-mcp-config" in argv
    assert argv[argv.index("--mcp-config") + 1] == '{"mcpServers":{}}'
    assert argv[argv.index("--setting-sources") + 1] == ""
    assert "--disable-slash-commands" in argv
    assert "--no-session-persistence" in argv
    assert "--effort" not in argv  # not requested
    argv2 = shim.build_argv("claude", "PROMPT", "sonnet", "SYS", effort="high")
    assert argv2[argv2.index("--effort") + 1] == "high"


# ---------------------------------------------------------------------------
# Fake `claude` binary + a live-in-process server, for end-to-end coverage.
# ---------------------------------------------------------------------------

FAKE_CLAUDE_SRC = textwrap.dedent(r"""
    #!/usr/bin/env python3
    import json, os, sys, time

    def main():
        argv = sys.argv[1:]
        mode = os.environ.get("FAKE_CLAUDE_MODE", "success")

        argv_trace = os.environ.get("FAKE_CLAUDE_ARGV_TRACE")
        if argv_trace:
            with open(argv_trace, "w") as f:
                json.dump({"argv": argv, "had_claudecode": "CLAUDECODE" in os.environ,
                           "had_entrypoint": "CLAUDE_CODE_ENTRYPOINT" in os.environ}, f)

        if mode == "timeout":
            time.sleep(5)
            return 0

        if mode == "rate_limit":
            print(json.dumps({
                "is_error": True, "api_error_status": None,
                "result": "Claude AI usage limit reached for this account.",
                "total_cost_usd": 0, "duration_api_ms": 1, "session_id": "rl1",
                "stop_reason": "stop_sequence", "usage": {},
            }))
            return 1

        if mode == "server_error":
            print(json.dumps({
                "is_error": True, "api_error_status": 529,
                "result": "upstream overloaded",
                "total_cost_usd": 0, "duration_api_ms": 1, "session_id": "se1",
                "stop_reason": "stop_sequence", "usage": {},
            }))
            return 1

        if mode == "concurrency":
            trace = os.environ["FAKE_CLAUDE_TRACE"]
            with open(trace, "a") as f:
                f.write("start %f\n" % time.time())
            time.sleep(0.25)
            with open(trace, "a") as f:
                f.write("end %f\n" % time.time())
            print(json.dumps({
                "is_error": False, "result": "ok",
                "total_cost_usd": 0.001, "duration_api_ms": 5, "session_id": "cc1",
                "stop_reason": "end_turn", "usage": {"input_tokens": 1, "output_tokens": 1},
            }))
            return 0

        # default "success": mimic the real observed Haiku behaviour of fencing a
        # JSON reply even when told not to, so the shim's strip_fences earns its
        # keep in an end-to-end path (not just the unit test above).
        print(json.dumps({
            "is_error": False, "api_error_status": None,
            "result": "```json\n{\"ping\": 1}\n```",
            "total_cost_usd": 0.0016, "duration_api_ms": 3227, "session_id": "sess1",
            "stop_reason": "end_turn", "usage": {"input_tokens": 303, "output_tokens": 9},
        }))
        return 0

    if __name__ == "__main__":
        sys.exit(main())
""").lstrip("\n")


class _ShimServer:
    """Spins claude_cli_shim's real Handler on an ephemeral port, in-process."""

    def __init__(self, tmpdir):
        self.tmpdir = tmpdir
        self.fake_claude = os.path.join(tmpdir, "fake_claude.py")
        with open(self.fake_claude, "w") as f:
            f.write(FAKE_CLAUDE_SRC)
        st = os.stat(self.fake_claude)
        os.chmod(self.fake_claude, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

        self.ledger_path = os.path.join(tmpdir, "brain-shim.jsonl")
        self.cwd_dir = os.path.join(tmpdir, "shim-cwd")
        os.makedirs(self.cwd_dir, exist_ok=True)

        self._env_patch = {
            "MOSH_CLAUDE_BIN": self.fake_claude,
            "MOSH_CLAUDE_SHIM_LEDGER": self.ledger_path,
            "MOSH_CLAUDE_SHIM_CWD": self.cwd_dir,
            "MOSH_CLAUDE_SHIM_TIMEOUT_S": "2",
        }
        self._env_saved = {}
        for k, v in self._env_patch.items():
            self._env_saved[k] = os.environ.get(k)
            os.environ[k] = v

        self.httpd = shim.make_server(port=0)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def url(self, path):
        return "http://127.0.0.1:%d%s" % (self.port, path)

    def post_chat(self, body, timeout=5):
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            self.url("/v1/chat/completions"), data=data,
            headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)
        for k, v in self._env_saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _ledger_lines(server):
    if not os.path.exists(server.ledger_path):
        return []
    with open(server.ledger_path) as f:
        return [json.loads(l) for l in f if l.strip()]


def test_health_and_models():
    with tempfile.TemporaryDirectory() as td:
        s = _ShimServer(td)
        try:
            with urllib.request.urlopen(s.url("/health"), timeout=5) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            assert body["ok"] is True
            assert body["claude_bin"] == s.fake_claude

            with urllib.request.urlopen(s.url("/v1/models"), timeout=5) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            ids = {m["id"] for m in body["data"]}
            assert {"sonnet", "opus", "haiku"} <= ids
        finally:
            s.close()


def test_chat_completion_success_fence_strip_and_argv():
    with tempfile.TemporaryDirectory() as td:
        s = _ShimServer(td)
        argv_trace = os.path.join(td, "argv_trace.json")
        os.environ["FAKE_CLAUDE_ARGV_TRACE"] = argv_trace
        os.environ["CLAUDECODE"] = "1"
        os.environ["CLAUDE_CODE_ENTRYPOINT"] = "cli"
        try:
            status, body = s.post_chat({
                "model": "sonnet",
                "messages": [
                    {"role": "system", "content": "Respond with JSON only"},
                    {"role": "user", "content": 'Reply {"ping":1}'},
                ],
                "response_format": {"type": "json_object"},
                "max_tokens": 64,
            })
            assert status == 200
            content = body["choices"][0]["message"]["content"]
            # Fences from the fake Haiku-style reply must be stripped bare.
            assert content == '{"ping": 1}'
            assert json.loads(content) == {"ping": 1}
            assert body["usage"]["prompt_tokens"] == 303
            assert body["usage"]["completion_tokens"] == 9
            assert body["mosh"]["cost_usd"] == 0.0016

            with open(argv_trace) as f:
                trace = json.load(f)
            argv = trace["argv"]
            assert "--strict-mcp-config" in argv
            assert argv[argv.index("--mcp-config") + 1] == '{"mcpServers":{}}'
            assert argv[argv.index("--setting-sources") + 1] == ""
            assert "--disable-slash-commands" in argv
            assert "--no-session-persistence" in argv
            assert "--bare" not in argv
            # json_object mode must have appended the no-fences instruction to
            # the rendered prompt actually sent to the CLI.
            prompt = argv[argv.index("-p") + 1]
            assert "JSON object" in prompt

            # The env-stripping requirement: the CLI child never sees these two.
            assert trace["had_claudecode"] is False
            assert trace["had_entrypoint"] is False

            lines = _ledger_lines(s)
            assert len(lines) == 1
            assert lines[0]["ok"] is True
            assert lines[0]["prompt_tokens"] == 303
            # Ledger must never carry prompt/response text.
            blob = json.dumps(lines[0])
            assert "ping" not in blob
            assert "JSON object" not in blob
        finally:
            os.environ.pop("FAKE_CLAUDE_ARGV_TRACE", None)
            os.environ.pop("CLAUDECODE", None)
            os.environ.pop("CLAUDE_CODE_ENTRYPOINT", None)
            s.close()


def test_rate_limit_maps_to_429():
    with tempfile.TemporaryDirectory() as td:
        s = _ShimServer(td)
        os.environ["FAKE_CLAUDE_MODE"] = "rate_limit"
        try:
            status, body = s.post_chat({"model": "sonnet", "messages": [{"role": "user", "content": "hi"}]})
            assert status == 429
            assert "error" in body
            lines = _ledger_lines(s)
            assert len(lines) == 1 and lines[0]["ok"] is False and lines[0]["status"] == 429
        finally:
            os.environ.pop("FAKE_CLAUDE_MODE", None)
            s.close()


def test_api_error_status_529_passthrough():
    with tempfile.TemporaryDirectory() as td:
        s = _ShimServer(td)
        os.environ["FAKE_CLAUDE_MODE"] = "server_error"
        try:
            status, body = s.post_chat({"model": "sonnet", "messages": [{"role": "user", "content": "hi"}]})
            assert status == 529
            assert "error" in body
        finally:
            os.environ.pop("FAKE_CLAUDE_MODE", None)
            s.close()


def test_timeout_maps_to_504():
    with tempfile.TemporaryDirectory() as td:
        s = _ShimServer(td)
        os.environ["FAKE_CLAUDE_MODE"] = "timeout"
        os.environ["MOSH_CLAUDE_SHIM_TIMEOUT_S"] = "0.3"
        try:
            status, body = s.post_chat({"model": "sonnet", "messages": [{"role": "user", "content": "hi"}]}, timeout=10)
            assert status == 504
            assert "error" in body
        finally:
            os.environ.pop("FAKE_CLAUDE_MODE", None)
            s.close()


def test_concurrent_calls_are_serialized():
    with tempfile.TemporaryDirectory() as td:
        s = _ShimServer(td)
        trace_path = os.path.join(td, "concurrency_trace.txt")
        os.environ["FAKE_CLAUDE_MODE"] = "concurrency"
        os.environ["FAKE_CLAUDE_TRACE"] = trace_path
        try:
            results = []

            def fire():
                results.append(s.post_chat({"model": "sonnet", "messages": [{"role": "user", "content": "hi"}]}, timeout=10))

            t1 = threading.Thread(target=fire)
            t2 = threading.Thread(target=fire)
            t1.start()
            time.sleep(0.05)  # ensure t1's call has entered the lock first
            t2.start()
            t1.join(timeout=10)
            t2.join(timeout=10)

            assert all(status == 200 for status, _ in results)

            with open(trace_path) as f:
                events = [l.split() for l in f if l.strip()]
            assert len(events) == 4  # start,end,start,end — never interleaved
            times = [(kind, float(ts)) for kind, ts in events]
            # Reconstruct call intervals in the order they were logged and assert
            # the second call's start is not before the first call's end.
            (k0, t0), (k1, t1_), (k2, t2_), (k3, t3) = times
            assert k0 == "start" and k1 == "end" and k2 == "start" and k3 == "end"
            assert t1_ <= t2_
        finally:
            os.environ.pop("FAKE_CLAUDE_MODE", None)
            os.environ.pop("FAKE_CLAUDE_TRACE", None)
            s.close()


def test_ledger_one_line_per_call_no_prompt_text():
    with tempfile.TemporaryDirectory() as td:
        s = _ShimServer(td)
        try:
            secret = "super-secret-user-prompt-content-xyz"
            s.post_chat({"model": "sonnet", "messages": [{"role": "user", "content": secret}]})
            s.post_chat({"model": "sonnet", "messages": [{"role": "user", "content": secret}]})
            lines = _ledger_lines(s)
            assert len(lines) == 2
            raw = open(s.ledger_path).read()
            assert secret not in raw
        finally:
            s.close()


def main():
    tests = [
        (name, fn) for name, fn in sorted(globals().items())
        if name.startswith("test_") and callable(fn)
    ]
    failed = []
    for name, fn in tests:
        try:
            fn()
            print("PASS %s" % name)
        except AssertionError as e:
            failed.append(name)
            print("FAIL %s: %s" % (name, e))
        except Exception as e:  # noqa: BLE001 - surface unexpected errors as failures too
            failed.append(name)
            print("ERROR %s: %r" % (name, e))
    total = len(tests)
    print("\nclaude_cli_shim_test: %d/%d passed" % (total - len(failed), total))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
