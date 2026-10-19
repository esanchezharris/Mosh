#!/usr/bin/env python3
"""service/reimagine_planner.py: opt-in gate, data scope, budget, plan validation, the
SDK call shape (against a fake `anthropic` module) and the subprocess key boundary.

No network and no real key: every provider response here is a fixture. A pass says the
plumbing and the refusals work, not that Claude writes good prompts.

Run: python3 service/scripts/reimagine_planner_test.py
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import types
from pathlib import Path

SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE))
import reimagine_planner as rp  # noqa: E402

FAILURES = []


def check(name, cond, detail=""):
    print(("[PASS] " if cond else "[FAIL] ") + name + (("  " + str(detail)) if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


def body(**over):
    data = {
        "request": "Turn these eight bars of keys into a hazy sampled-keyboard loop. Follow the chord changes and make it less busy.",
        "revision": "",
        "input_seconds": 16.0,
        "input_role": "source",
        "context": {"key": "F minor", "key_from": "user", "bpm": 120.0, "bpm_from": "host", "meter": "4/4",
                    "chords": [{"bar": 1, "symbol": "Fm7"}, {"bar": 3, "symbol": "Db"}], "chords_from": "user",
                    "section": "verse", "protected": ["chord-change timing"]},
        "limits": {"max_candidates": 2},
        # Fields the planner must drop rather than send:
        "inputWav": "/Users/someone/Music/secret.wav", "sourceHash": "ab" * 32,
    }
    data.update(over)
    return data


GOOD_PLAN = {"prompt": "hazy sampled keyboard loop, dusty tape, sparse voicings, lo-fi warmth",
             "strength": 0.3, "candidate_count": 2,
             "interpretation": "A sparser, tape-worn keys loop over the same changes.",
             "unsupported": ["follow the chord changes exactly", "less busy needs note-level edits"]}


tmp = Path(tempfile.mkdtemp(prefix="mosh-planner-test-"))
os.environ["MOSH_REIMAGINE_HOME"] = str(tmp / "home")
env_file = tmp / "reimagine-planner.env"
os.environ["MOSH_REIMAGINE_PLANNER_ENV"] = str(env_file)
os.environ.pop("ANTHROPIC_API_KEY", None)


def write_env(text):
    env_file.write_text(text, encoding="utf-8")


def reset_ledger():
    try:
        rp.ledger_path().unlink()
    except OSError:
        pass


# ── consent gate ──────────────────────────────────────────────────────────────────────
if env_file.exists():
    env_file.unlink()
calls = []
runner = lambda req: calls.append(req) or {"plan": GOOD_PLAN, "usage": {"input_tokens": 900, "output_tokens": 300},
                                           "model": "claude-opus-5-5", "request_id": "req_test", "stop_reason": "end_turn"}
r = rp.plan(body(), runner=runner)
check("no opt-in file → disabled, no call", r == {"ok": False, "reason": "disabled", "error": r.get("error")} and not calls, r)

os.environ["ANTHROPIC_API_KEY"] = "sk-from-shell"
write_env("ANTHROPIC_API_KEY=sk-in-file\n")
r = rp.plan(body(), runner=runner)
check("a key without MOSH_REIMAGINE_PLANNER=anthropic is not consent", r.get("reason") == "disabled" and not calls, r)

write_env("MOSH_REIMAGINE_PLANNER=anthropic\n")
r = rp.plan(body(), runner=runner)
check("a key in the shell environment is not used", r.get("reason") == "no-key" and not calls, r)
os.environ.pop("ANTHROPIC_API_KEY", None)

write_env("MOSH_REIMAGINE_PLANNER=openai\nANTHROPIC_API_KEY=k\n")
check("other providers refused", rp.plan(body(), runner=runner).get("reason") == "disabled" and not calls)

write_env("MOSH_REIMAGINE_PLANNER=anthropic\nANTHROPIC_API_KEY=k\nMOSH_REIMAGINE_PLANNER_MODEL=claude-mystery-9\n")
check("an unpriced model is refused (budget cannot be bounded)", rp.plan(body(), runner=runner).get("reason") == "config")

write_env("MOSH_REIMAGINE_PLANNER=anthropic\nANTHROPIC_API_KEY=k\nMOSH_REIMAGINE_PLANNER_EFFORT=turbo\n")
check("an unknown effort is refused", rp.plan(body(), runner=runner).get("reason") == "config")

write_env('# opt-in 2026-10-19\nexport MOSH_REIMAGINE_PLANNER="anthropic"\nANTHROPIC_API_KEY=\'sk-test\'\n'
          "MOSH_REIMAGINE_PLANNER_BUDGET_USD=1.00\n")
cfg = rp.load_config()
check("env file: export prefix, quotes and comments parse", cfg["provider"] == "anthropic" and cfg["api_key"] == "sk-test"
      and cfg["budget_usd"] == 1.0 and cfg["model"] == rp.DEFAULT_MODEL and cfg["effort"] == "medium", cfg)
st = rp.status()
check("status reports enabled without exposing the key", st["enabled"] is True and "sk-test" not in json.dumps(st), st)

# ── data scope ────────────────────────────────────────────────────────────────────────
reset_ledger()
calls.clear()
r = rp.plan(body(), runner=runner)
check("opted-in plan succeeds", r.get("ok") is True and r["plan"]["candidate_count"] == 2, r)
sent = json.dumps(calls[0]) if calls else ""
check("paths and hashes are dropped before sending", "secret.wav" not in sent and "ab" * 32 not in sent
      and "inputWav" not in sent and "sourceHash" not in sent, sent)
check("chord bars, key, BPM and protected choices are sent", '"Fm7"' in sent and "F minor" in sent and "120.0" in sent
      and "chord-change timing" in sent)
check("controller provenance is returned", r["controller"]["provider"] == "anthropic" and r["controller"]["model"] == "claude-opus-5-5"
      and r["controller"]["plannerVersion"] == rp.PLANNER_VERSION and r["controller"]["requestId"] == "req_test", r["controller"])
expected = (900 * 4.0 + 300 * 20.0) / 1e6
check("cost is priced from usage", abs(r["controller"]["costUsd"] - expected) < 1e-9, r["controller"])
ledger = rp.ledger_path().read_text().splitlines()
check("ledger records cost, not request text", len(ledger) == 1 and "hazy" not in ledger[0]
      and json.loads(ledger[0])["cost_usd"] == round(expected, 6), ledger)

# ── budget ────────────────────────────────────────────────────────────────────────────
rp._ledger_append({"cost_usd": 0.95})
calls.clear()
r = rp.plan(body(), runner=runner)
check("budget: refused before the call when the worst case would pass the cap", r.get("reason") == "budget" and not calls, r)
reset_ledger()

# ── malformed requests from the plug-in ──────────────────────────────────────────────
bad = {
    "empty request": body(request="  "),
    "non-string request": body(request=42),
    "huge request": body(request="x" * 5000),
    "max_candidates 0": body(limits={"max_candidates": 0}),
    "max_candidates 9": body(limits={"max_candidates": 9}),
    "missing limits": {k: v for k, v in body().items() if k != "limits"},
    "bool candidates": body(limits={"max_candidates": True}),
    "zero seconds": body(input_seconds=0),
    "NaN seconds": body(input_seconds=float("nan")),
    "bad role": body(input_role="mix"),
    "chord without bar": body(context={"chords": [{"symbol": "C"}]}),
    "context not object": body(context=[1]),
    "not an object": [1, 2],
}
for name, b in bad.items():
    calls.clear()
    r = rp.plan(b, runner=runner)
    check("malformed: " + name, r.get("ok") is False and r.get("reason") == "invalid-request" and not calls, r)

# ── malformed plans from the provider ────────────────────────────────────────────────
def with_plan(p, **out):
    base = {"plan": p, "usage": {"input_tokens": 10, "output_tokens": 10}, "model": "claude-opus-5-5",
            "request_id": "req_x", "stop_reason": "end_turn"}
    base.update(out)
    return lambda req: base


bad_plans = {
    "strength 0.9": dict(GOOD_PLAN, strength=0.9),
    "strength NaN": dict(GOOD_PLAN, strength=float("nan")),
    "3 candidates over a limit of 2": dict(GOOD_PLAN, candidate_count=3),
    "float candidates": dict(GOOD_PLAN, candidate_count=2.0),
    "empty prompt": dict(GOOD_PLAN, prompt=" "),
    "prompt too long": dict(GOOD_PLAN, prompt="y" * 601),
    "unsupported not a list": dict(GOOD_PLAN, unsupported="none"),
    "not an object": ["prompt"],
}
for name, p in bad_plans.items():
    r = rp.plan(body(), runner=with_plan(p))
    check("invalid plan rejected: " + name, r.get("ok") is False and r.get("reason") == "invalid-plan", r)
check("a rejected plan still reports its cost", rp.ledger_spent_usd() > 0)
r = rp.plan(body(), runner=with_plan(dict(GOOD_PLAN, prompt="hazy\nkeys\t loop")))
check("control characters in the prompt are flattened", r.get("ok") and r["plan"]["prompt"] == "hazy keys loop", r)
r = rp.plan(body(), runner=lambda req: {"error": {"reason": "refused", "message": "declined"},
                                        "usage": {"input_tokens": 5, "output_tokens": 0}, "model": "claude-opus-5-5",
                                        "request_id": "req_r", "stop_reason": "refusal"})
check("a refusal is surfaced, not turned into a plan", r.get("ok") is False and r.get("reason") == "refused", r)
r = rp.plan(body(), runner=with_plan(GOOD_PLAN, model="claude-opus-4-8"))
check("a fallback-served call is priced at the served model",
      abs(r["controller"]["costUsd"] - (10 * 5.0 + 10 * 25.0) / 1e6) < 1e-12 and r["controller"]["costEstimated"] is False, r)
r = rp.plan(body(), runner=with_plan(GOOD_PLAN, model="claude-unknown-1"))
check("an unpriced served model is charged at the worst rate and flagged", r["controller"]["costEstimated"] is True, r)

def boom(req):
    raise rp.PlannerError("timeout", "slow")


r = rp.plan(body(), runner=boom)
check("subprocess timeout surfaces as a reason", r == {"ok": False, "reason": "timeout", "error": "slow"}, r)

# ── the SDK call shape, against a fake `anthropic` module ────────────────────────────
fake = types.ModuleType("anthropic")


class _Err(Exception):
    def __init__(self, message="", status_code=0):
        super().__init__(message)
        self.message, self.status_code = message, status_code


for cls in ("AuthenticationError", "PermissionDeniedError", "RateLimitError", "BadRequestError",
            "APIStatusError", "APIConnectionError"):
    setattr(fake, cls, type(cls, (_Err,), {}))
captured = {}


class _Messages:
    def __init__(self, behaviour):
        self.behaviour = behaviour

    def create(self, **kwargs):
        captured.update(kwargs)
        if isinstance(self.behaviour, Exception):
            raise self.behaviour
        return self.behaviour


def fake_client(behaviour):
    return lambda key: types.SimpleNamespace(api_key=key, beta=types.SimpleNamespace(messages=_Messages(behaviour)))


def response(text, stop="end_turn"):
    return types.SimpleNamespace(
        content=[types.SimpleNamespace(type="text", text=text)], stop_reason=stop, model="claude-opus-5-5",
        usage=types.SimpleNamespace(input_tokens=1200, output_tokens=400), _request_id="req_sdk")


sys.modules["anthropic"] = fake
cfg = {"api_key": "sk-test", "model": "claude-opus-5-5", "effort": "medium"}
req = rp.parse_plan_request(body())
out = rp.call_claude(cfg, req, client_factory=fake_client(response(json.dumps(GOOD_PLAN))))
check("SDK: plan parsed from the text block", out.get("plan") == GOOD_PLAN and out["usage"]["output_tokens"] == 400, out)
check("SDK: structured output schema, effort and model sent", captured.get("model") == "claude-opus-5-5"
      and captured["output_config"]["effort"] == "medium" and captured["output_config"]["format"]["schema"] == rp.PLAN_SCHEMA
      and captured["max_tokens"] == rp.MAX_OUTPUT_TOKENS, {k: captured.get(k) for k in ("model", "max_tokens")})
check("SDK: server-side default fallback requested", captured.get("betas") == ["server-side-fallback-2026-07-01"]
      and captured.get("extra_body") == {"fallbacks": "default"}, captured.get("extra_body"))
check("SDK: no sampling parameters or thinking config sent", not any(k in captured for k in ("temperature", "top_p", "top_k", "thinking")))
user_text = captured["messages"][0]["content"]
check("SDK: the user message is exactly the scoped request", json.loads(user_text) == req)
out = rp.call_claude(cfg, req, client_factory=fake_client(response("", stop="refusal")))
check("SDK: refusal stop_reason → error, no plan", out.get("error", {}).get("reason") == "refused" and "plan" not in out, out)
out = rp.call_claude(cfg, req, client_factory=fake_client(response('{"prompt": "cut', stop="max_tokens")))
check("SDK: truncated output → invalid-plan", out.get("error", {}).get("reason") == "invalid-plan", out)
out = rp.call_claude(cfg, req, client_factory=fake_client(response("not json")))
check("SDK: non-JSON text → invalid-plan", out.get("error", {}).get("reason") == "invalid-plan", out)
for exc, reason in ((fake.AuthenticationError("bad key"), "auth"), (fake.RateLimitError("slow down"), "rate-limit"),
                    (fake.APIConnectionError("offline"), "network"), (fake.APIStatusError("boom", 529), "api-error")):
    try:
        rp.call_claude(cfg, req, client_factory=fake_client(exc))
        check("SDK: " + type(exc).__name__ + " raises", False)
    except rp.PlannerError as e:
        check("SDK: " + type(exc).__name__ + " → " + reason, e.reason == reason, e.reason)
del sys.modules["anthropic"]

# subprocess_main in-process: reads only the opt-in file, writes one JSON object
write_env("MOSH_REIMAGINE_PLANNER=anthropic\nANTHROPIC_API_KEY=sk-test\n")
sys.modules["anthropic"] = fake
orig_call = rp.call_claude
rp.call_claude = lambda c, r, client_factory=None: orig_call(c, r, client_factory=fake_client(response(json.dumps(GOOD_PLAN))))
buf = io.StringIO()
rp.subprocess_main(io.StringIO(json.dumps(req)), buf)
rp.call_claude = orig_call
del sys.modules["anthropic"]
check("subprocess entry returns the plan as JSON", json.loads(buf.getvalue()).get("plan") == GOOD_PLAN, buf.getvalue())

# the real subprocess boundary: no SDK in this interpreter → no-sdk, and the shell key is stripped
os.environ["MOSH_REIMAGINE_PLANNER_PYTHON"] = sys.executable
os.environ["ANTHROPIC_API_KEY"] = "sk-shell-should-not-reach"
try:
    import anthropic  # noqa: F401
    have_sdk = True
except ImportError:
    have_sdk = False
if have_sdk:
    print("[SKIP] subprocess no-sdk path (anthropic is installed in this interpreter)")
else:
    before = rp.ledger_path().read_text() if rp.ledger_path().exists() else ""
    r = rp.plan(body())
    after = rp.ledger_path().read_text() if rp.ledger_path().exists() else ""
    check("subprocess without the SDK → no-sdk, nothing spent or logged", r.get("reason") == "no-sdk"
          and r["controller"]["costUsd"] == 0 and before == after, r)
os.environ.pop("ANTHROPIC_API_KEY", None)

# ── the helper's HTTP routes (real service handler, planner off) ─────────────────────
import http.client  # noqa: E402
import threading  # noqa: E402
from http.server import ThreadingHTTPServer  # noqa: E402

os.environ["MOSH_ENABLE_SA3"] = "0"
import server  # noqa: E402

env_file.unlink()
with ThreadingHTTPServer(("127.0.0.1", 0), server.Handler) as listener:
    thread = threading.Thread(target=listener.serve_forever, daemon=True)
    thread.start()
    try:
        conn = http.client.HTTPConnection("127.0.0.1", listener.server_port, timeout=10)
        conn.request("GET", "/reimagine/plan/status")
        resp = conn.getresponse()
        st = json.loads(resp.read())
        check("GET /reimagine/plan/status: off by default", resp.status == 200 and st["enabled"] is False
              and st["reason"] == "disabled" and "never audio" in st["sends"], st)
        conn.request("POST", "/reimagine/plan", body=json.dumps(body()), headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        r = json.loads(resp.read())
        check("POST /reimagine/plan: off → ok:false disabled", resp.status == 200 and r.get("ok") is False
              and r.get("reason") == "disabled", r)
    finally:
        listener.shutdown()
        thread.join(timeout=5)

print("\nreimagine_planner_test: " + ("OK" if not FAILURES else "FAILED " + ", ".join(FAILURES)))
sys.exit(1 if FAILURES else 0)
