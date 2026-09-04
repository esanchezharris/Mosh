#!/usr/bin/env python3
"""claude_cli_shim.py — local OpenAI-compatible HTTP shim in front of `claude -p`.

Context (W1.3 of the produce-lane overnight plan, docs/POSTMORTEM-2026-09.md's
approved direction): tonight's PRIMARY brain is the Claude Code CLI itself, run
via `claude -p` under the owner's subscription — dev-time iteration, never a
shipping config. Mosh's BrainProxy already speaks the OpenAI chat-completions
shape to any `openai`-compatible base URL (src/brain/BrainProxy.cpp); this
process is that base URL. It does nothing but translate one HTTP call into one
`claude -p` subprocess call and translate the reply back.

stdlib only (no requests/flask/pydantic) — the gate's py_tests auto-discovers
`service/**/*_test.py` and runs it under the *system* interpreter (pyenv 3.12,
must also run cleanly on 3.11); this module and its test must never require a
third-party package or the real `claude` binary.

Endpoints:
  GET  /health                — {"ok": true, "claude_bin": ..., "port": ...}
  GET  /v1/models             — a minimal OpenAI-shaped model list
  POST /v1/chat/completions   — the one real endpoint; see call_claude() below

Concurrency: `claude -p` is a heavyweight subprocess (auth, MCP init, model
call) and this shim is single-owner dev tooling, so a single lock serializes
/v1/chat/completions — no parallel `claude` children, no interleaved stdout.

Never `--bare`: that mode forces ANTHROPIC_API_KEY auth (would bill the API
key, not the subscription) — see claude --help. This shim always keeps the
default (subscription/OAuth) auth path and only narrows scope via
--strict-mcp-config / --setting-sources "" / --disable-slash-commands so a
plain query does not read the user's real Mosh CLAUDE.md, skills, or MCP
servers.

Env knobs (all optional):
  MOSH_CLAUDE_BIN            claude executable (default ~/.local/bin/claude,
                              else "claude" from PATH)
  MOSH_CLAUDE_SHIM_PORT      HTTP port (default 8788)
  MOSH_CLAUDE_SHIM_TIMEOUT_S per-call subprocess timeout in seconds (default 170)
  MOSH_CLAUDE_SHIM_EFFORT    if set, passed through as `--effort <value>`
  MOSH_CLAUDE_SHIM_LEDGER    ledger JSONL path (default ~/Library/Mosh/logs/brain-shim.jsonl)
  MOSH_CLAUDE_SHIM_CWD       empty scratch cwd for the `claude` child (default
                              ~/Library/Mosh/brain-shim/cwd)
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_PORT = 8788
DEFAULT_TIMEOUT_S = 170.0

# Exact bytes verified live tonight — do NOT reformat via json.dumps (its default
# separators insert a space and would silently drift from the verified argv).
MCP_CONFIG_JSON = '{"mcpServers":{}}'

# claude -p passes model aliases straight through; only the OpenRouter-style
# "anthropic/claude-<name>-5" ids (what BrainProxy's provider table sends when a
# caller names a fully-qualified model) need remapping to the bare alias.
PASSTHROUGH_MODELS = {"sonnet", "opus", "haiku"}
MODEL_ALIASES = {
    "anthropic/claude-sonnet-5": "sonnet",
    "anthropic/claude-opus-5": "opus",
    "anthropic/claude-haiku-5": "haiku",
}

# Haiku (and occasionally other models) wrap "JSON only" replies in ```/```json
# fences even when told not to; strip them only when the caller asked for
# response_format: json_object, so free-text replies are left untouched.
_FENCE_RE = re.compile(r"^```(?:json)?\s*\n?(.*?)\n?```\s*$", re.DOTALL)

# is_error with no clear api_error_status: sniff the result text for the
# phrases Claude Code uses for capacity/rate problems so BrainProxy's provider
# fallback (429/5xx only) actually triggers instead of parking on a 502.
_RATE_LIMIT_RE = re.compile(r"rate.?limit|usage limit|overloaded|529", re.IGNORECASE)

_CALL_LOCK = threading.Lock()


def _claude_bin():
    envv = os.environ.get("MOSH_CLAUDE_BIN")
    if envv:
        return envv
    default = os.path.expanduser("~/.local/bin/claude")
    return default if os.path.exists(default) else "claude"


def _shim_port():
    try:
        return int(os.environ.get("MOSH_CLAUDE_SHIM_PORT", str(DEFAULT_PORT)))
    except ValueError:
        return DEFAULT_PORT


def _timeout_s():
    try:
        return float(os.environ.get("MOSH_CLAUDE_SHIM_TIMEOUT_S", str(DEFAULT_TIMEOUT_S)))
    except ValueError:
        return DEFAULT_TIMEOUT_S


def _ledger_path():
    return os.environ.get("MOSH_CLAUDE_SHIM_LEDGER") or os.path.expanduser(
        "~/Library/Mosh/logs/brain-shim.jsonl"
    )


def _cwd_dir():
    d = os.environ.get("MOSH_CLAUDE_SHIM_CWD") or os.path.expanduser(
        "~/Library/Mosh/brain-shim/cwd"
    )
    os.makedirs(d, exist_ok=True)
    return d


def map_model(model):
    """sonnet|opus|haiku pass through unchanged; the OpenRouter-style fully
    qualified ids collapse to their bare alias; anything else is passed through
    best-effort (claude -p will reject an unknown model itself)."""
    if not model:
        return "sonnet"
    if model in PASSTHROUGH_MODELS:
        return model
    return MODEL_ALIASES.get(model, model)


def strip_fences(text):
    m = _FENCE_RE.match((text or "").strip())
    return m.group(1).strip() if m else text


def _message_text(content):
    if isinstance(content, list):
        # OpenAI content-parts shape: [{"type":"text","text":"..."}, ...] — join text parts.
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return content or ""


def render_prompt(messages, json_mode):
    """Split an OpenAI `messages` array into (system_prompt, prompt): system-role
    messages join into the --system-prompt string; everything else renders as a
    role-labelled transcript (claude -p takes one prompt string, not a message
    array). In json_mode, append an explicit no-fences instruction to the
    transcript prompt — the CLI's --output-format json still lets the *model's*
    `result` text be Markdown-fenced JSON (see strip_fences)."""
    system_parts = []
    transcript = []
    for m in messages or []:
        role = (m.get("role") or "user").strip().lower()
        text = _message_text(m.get("content"))
        if role == "system":
            if text:
                system_parts.append(text)
        elif role == "assistant":
            transcript.append("Assistant: " + text)
        else:
            transcript.append("User: " + text)
    system_prompt = "\n\n".join(system_parts)
    prompt = "\n\n".join(transcript)
    if json_mode:
        note = "Respond with exactly one JSON object and nothing else — no markdown code fences, no commentary."
        prompt = (prompt + "\n\n" + note) if prompt else note
    return system_prompt, prompt


def build_argv(claude_bin, prompt, model, system_prompt, effort=None):
    argv = [
        claude_bin,
        "-p", prompt,
        "--output-format", "json",
        "--model", model,
        "--system-prompt", system_prompt,
        "--tools", "",
        "--strict-mcp-config",
        "--mcp-config", MCP_CONFIG_JSON,
        "--setting-sources", "",
        "--disable-slash-commands",
        "--no-session-persistence",
    ]
    if effort:
        argv += ["--effort", effort]
    return argv


class UpstreamError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def classify_error_status(api_error_status, error_text):
    """api_error_status wins when it already looks like the right HTTP code
    (429, or any 5xx); otherwise sniff for a rate-limit/capacity phrase and map
    to 429; otherwise a generic 502. This is the whole reason BrainProxy's
    per-provider fallback (openai(shim) -> openrouter -> deepseek -> xai, see
    runTask.ts PRODUCE_CLOUD_PROVIDERS) can actually move past a stuck CLI."""
    if isinstance(api_error_status, int) and (api_error_status == 429 or api_error_status >= 500):
        return api_error_status
    if _RATE_LIMIT_RE.search(error_text or ""):
        return 429
    return 502


def call_claude(prompt, model, system_prompt, json_mode, effort=None, timeout_s=None):
    """Run one `claude -p` call and return
    {content, model, usage, cost_usd, duration_api_ms, wall_ms, session_id, stop_reason}
    or raise UpstreamError with the HTTP status the caller should return."""
    claude_bin = _claude_bin()
    argv = build_argv(claude_bin, prompt, model, system_prompt, effort)

    env = dict(os.environ)
    # These two identify an in-progress Claude Code session to the CLI; left set,
    # a `claude -p` child spawned from inside a Claude Code session behaves like a
    # nested/recursive session instead of a plain one-shot call.
    env.pop("CLAUDECODE", None)
    env.pop("CLAUDE_CODE_ENTRYPOINT", None)

    timeout_s = _timeout_s() if timeout_s is None else timeout_s
    t0 = time.monotonic()
    try:
        proc = subprocess.run(
            argv, env=env, cwd=_cwd_dir(),
            capture_output=True, text=True, timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        raise UpstreamError(504, "claude -p timed out after %.0fs" % timeout_s)
    wall_ms = int((time.monotonic() - t0) * 1000)

    stdout = proc.stdout or ""
    stderr = proc.stderr or ""
    payload = None
    if stdout.strip():
        try:
            payload = json.loads(stdout)
        except ValueError:
            payload = None
    if payload is None:
        tail = (stderr or stdout).strip()[-500:]
        raise UpstreamError(502, "claude -p exited %d with non-JSON stdout: %s" % (proc.returncode, tail))

    is_error = bool(payload.get("is_error"))
    result_text = payload.get("result") or ""
    if is_error:
        status = classify_error_status(payload.get("api_error_status"), result_text or stderr)
        raise UpstreamError(status, result_text or (
            "claude -p reported is_error=true (subtype=%s)" % payload.get("subtype")))

    if json_mode:
        result_text = strip_fences(result_text)

    return {
        "content": result_text,
        "model": model,
        "usage": payload.get("usage") or {},
        "cost_usd": payload.get("total_cost_usd"),
        "duration_api_ms": payload.get("duration_api_ms"),
        "wall_ms": wall_ms,
        "session_id": payload.get("session_id"),
        "stop_reason": payload.get("stop_reason"),
    }


def _append_ledger(entry):
    """Sizes/tokens/cost/ms only — NEVER prompt or response text (system prompts
    and completions can carry anything the app is working on)."""
    path = _ledger_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a") as f:
            f.write(json.dumps(entry, sort_keys=True) + "\n")
    except OSError:
        pass  # ledger is diagnostic, never load-bearing for the response


class Handler(BaseHTTPRequestHandler):
    server_version = "MoshClaudeShim/1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - - [%s] %s\n" % (
            self.address_string(), self.log_date_time_string(), fmt % args))

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"ok": True, "claude_bin": _claude_bin(), "port": _shim_port()})
            return
        if self.path == "/v1/models":
            self._send_json(200, {
                "object": "list",
                "data": [{"id": m, "object": "model"} for m in ("sonnet", "opus", "haiku")],
            })
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self._send_json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            self._send_json(400, {"error": "invalid JSON body"})
            return

        messages = body.get("messages") or []
        model = map_model(body.get("model"))
        response_format = body.get("response_format") or {}
        json_mode = isinstance(response_format, dict) and response_format.get("type") == "json_object"
        system_prompt, prompt = render_prompt(messages, json_mode)
        effort = os.environ.get("MOSH_CLAUDE_SHIM_EFFORT") or None
        req_bytes = len(raw)

        with _CALL_LOCK:
            try:
                result = call_claude(prompt, model, system_prompt, json_mode, effort=effort)
            except UpstreamError as e:
                _append_ledger({
                    "ts": time.time(), "ok": False, "status": e.status,
                    "model": model, "req_bytes": req_bytes, "error_len": len(e.message or ""),
                })
                self._send_json(e.status, {"error": e.message})
                return

        usage = result["usage"] or {}
        prompt_tokens = int(usage.get("input_tokens") or 0)
        completion_tokens = int(usage.get("output_tokens") or 0)
        finish_reason = "stop" if result.get("stop_reason") in (None, "end_turn") else result["stop_reason"]
        resp = {
            "id": "chatcmpl-" + (result.get("session_id") or "shim"),
            "object": "chat.completion",
            "created": int(time.time()),
            "model": result["model"],
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": result["content"]},
                "finish_reason": finish_reason,
            }],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
            },
            "mosh": {
                "cost_usd": result.get("cost_usd"),
                "duration_api_ms": result.get("duration_api_ms"),
            },
        }
        _append_ledger({
            "ts": time.time(), "ok": True, "model": model,
            "req_bytes": req_bytes, "resp_bytes": len(result["content"] or ""),
            "prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens,
            "cost_usd": result.get("cost_usd"), "duration_api_ms": result.get("duration_api_ms"),
            "wall_ms": result.get("wall_ms"),
        })
        self._send_json(200, resp)


def make_server(host="127.0.0.1", port=None):
    return ThreadingHTTPServer((host, _shim_port() if port is None else port), Handler)


def main(argv=None):
    httpd = make_server()
    sys.stderr.write("claude_cli_shim: listening on 127.0.0.1:%d (claude_bin=%s)\n" % (
        httpd.server_address[1], _claude_bin()))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
