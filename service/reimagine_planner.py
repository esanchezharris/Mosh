#!/usr/bin/env python3
"""Re-Imagine M1 request planner: one opt-in cloud call that turns the typed intention
into a bounded, structured render request (docs/reimagine-plugin/M1-CONTEXTUAL-LOOP.md).

What it is: a single Claude Messages API call per Generate/Revise. It reads the user's
typed request (and revision) plus the region's TEXT context (key, BPM, meter, chord names
with bar numbers, section label, protected choices, duration) and returns a JSON plan:
an SA3 prompt, a generation strength and a candidate count. The plug-in validates the plan
again (validateRequest) before it spends a model attempt.

What it never sends: audio, file names, paths, hashes, or any other part of the session.
The model never listens to anything; it cannot judge whether a take follows the chords.

Consent: OFF unless the owner writes the opt-in file (default
~/.config/mosh/reimagine-planner.env, override MOSH_REIMAGINE_PLANNER_ENV) containing
`MOSH_REIMAGINE_PLANNER=anthropic` and `ANTHROPIC_API_KEY=...`. A key in the shell
environment or in ~/.config/mosh/env is NOT consent and is never read here. The helper
(service/server.py) never loads the key either: it hands the request to this file run as
a subprocess under MOSH_REIMAGINE_PLANNER_PYTHON (a small venv with the `anthropic`
SDK), which reads the opt-in file itself.

Budget: every call is priced from the response's usage and appended to a local ledger;
a call is refused when the ledger total plus that call's worst case would pass
MOSH_REIMAGINE_PLANNER_BUDGET_USD (default 20). Unknown models are refused because their
cost cannot be bounded.
"""
from __future__ import annotations

import json
import math
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

PLANNER_VERSION = "reimagine-claude-planner/1"
DEFAULT_MODEL = "claude-opus-5-5"
DEFAULT_EFFORT = "medium"
DEFAULT_BUDGET_USD = 20.0
MAX_OUTPUT_TOKENS = 16000
SUBPROCESS_TIMEOUT_S = 120.0

# USD per million tokens (input, output), first-party Claude API rates. Thinking tokens
# bill as output tokens and are included in usage.output_tokens.
PRICING_PER_MTOK: Dict[str, Tuple[float, float]] = {
    "claude-opus-5-5": (4.00, 20.00),
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-haiku-5-5": (0.10, 0.50),
    "claude-fable-5-1": (10.00, 50.00),
    # The "default" server-side fallback route may serve a refused request on Opus 4.8.
    "claude-opus-4-8": (5.00, 25.00),
}
FALLBACK_MODEL_FOR_BUDGET = "claude-opus-4-8"
EFFORTS = ("low", "medium", "high", "xhigh", "max")

# Mirrors src/reimagine/ReImagineSession.h; the plug-in re-checks every bound.
MIN_STRENGTH, MAX_STRENGTH = 0.01, 0.5
MAX_CANDIDATES = 4
MAX_PROMPT_CHARS = 600
MAX_TEXT_CHARS = 2000
MAX_CHORDS = 64

PLAN_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "prompt": {"type": "string",
                   "description": "Stable Audio 3 text prompt for the transformed audio."},
        "strength": {"type": "number",
                     "description": "Init-noise level 0.01-0.5: how far the result may move from the input audio."},
        "candidate_count": {"type": "integer",
                            "description": "How many independent candidates to render."},
        "interpretation": {"type": "string",
                           "description": "One sentence: what you understood the musician to want."},
        "unsupported": {"type": "array", "items": {"type": "string"},
                        "description": "Parts of the request this backend cannot enforce."},
    },
    "required": ["prompt", "strength", "candidate_count", "interpretation", "unsupported"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """You plan one audio-to-audio transformation for a musician working in their DAW.

The backend is Stable Audio 3 Medium, run locally in "re-imagine" mode: it takes the
musician's audio clip as init audio plus ONE English text prompt, and renders a clip of the
same length. Its controls are only:
- prompt: a text description of the target sound. It responds to instrument, timbre,
  texture, recording/production character, genre and mood words. It does not reliably follow
  bar numbers, chord symbols, tempo numbers or structural instructions; at best they nudge it.
- strength (init-noise level, 0.01-0.5): low keeps more of the input's timing, notes and
  rhythm; high moves further from it. Requests to keep timing or harmony call for lower
  strength; requests for a different instrument or heavy texture change need more.
- candidate_count: independent seeds rendered for the musician to audition.

Write the prompt as a compact sound description (comma-separated phrases are fine), at most
600 characters. Translate the musician's intent into sound words; do not copy instructions
the model cannot follow. On a revision, the input audio is the version the musician picked,
so describe the change from it and keep strength modest unless they ask for a big change.

List in "unsupported" every part of the request the backend cannot enforce, in the
musician's terms (for example "follow the chord changes exactly", "keep the chord-change
timing", "make the performance less busy" when it needs note-level editing). Be honest:
naming chords or a BPM in the prompt is not enforcement. Never claim to have heard the
audio; you receive only text.

Stay within the limits given in the request. Return only the JSON plan."""


class PlannerError(Exception):
    """A refusal with a machine-readable reason the plug-in shows next to the template path."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


# ── configuration (the opt-in file is the only source) ────────────────────────────────
def env_file_path() -> Path:
    override = os.environ.get("MOSH_REIMAGINE_PLANNER_ENV", "").strip()
    return Path(override) if override else Path.home() / ".config" / "mosh" / "reimagine-planner.env"


def _parse_env_file(path: Path) -> Dict[str, str]:
    values: Dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return values
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):]
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def load_config(path: Optional[Path] = None) -> Dict[str, Any]:
    """Opt-in settings from the planner env file. `key_present` is reported, the key
    itself is returned only under "api_key" for the subprocess that makes the call."""
    path = path or env_file_path()
    raw = _parse_env_file(path)
    provider = raw.get("MOSH_REIMAGINE_PLANNER", "").strip().lower()
    try:
        budget = float(raw.get("MOSH_REIMAGINE_PLANNER_BUDGET_USD", DEFAULT_BUDGET_USD))
    except ValueError:
        budget = float("nan")
    return {
        "env_file": str(path),
        "provider": provider,
        "model": raw.get("MOSH_REIMAGINE_PLANNER_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL,
        "effort": raw.get("MOSH_REIMAGINE_PLANNER_EFFORT", DEFAULT_EFFORT).strip().lower() or DEFAULT_EFFORT,
        "budget_usd": budget,
        "api_key": raw.get("ANTHROPIC_API_KEY", "").strip(),
    }


def config_problem(cfg: Dict[str, Any]) -> Optional[PlannerError]:
    if not cfg["provider"]:
        return PlannerError("disabled", "Cloud planner is off (no opt-in in " + cfg["env_file"] + ")")
    if cfg["provider"] != "anthropic":
        return PlannerError("disabled", "Unsupported planner provider \"" + cfg["provider"] + "\" (anthropic only)")
    if not cfg["api_key"]:
        return PlannerError("no-key", "ANTHROPIC_API_KEY missing from " + cfg["env_file"])
    if cfg["model"] not in PRICING_PER_MTOK:
        return PlannerError("config", "Model " + cfg["model"] + " has no price on record, so its cost cannot be bounded")
    if cfg["effort"] not in EFFORTS:
        return PlannerError("config", "Effort must be one of " + ", ".join(EFFORTS))
    if not math.isfinite(cfg["budget_usd"]) or cfg["budget_usd"] < 0:
        return PlannerError("config", "MOSH_REIMAGINE_PLANNER_BUDGET_USD must be a non-negative number")
    return None


# ── ledger (local spend record; no request text) ─────────────────────────────────────
def ledger_path() -> Path:
    root = os.environ.get("MOSH_REIMAGINE_HOME", "").strip()
    home = Path(root) if root else Path.home()
    return home / "Library" / "Mosh" / "ReImagine" / "planner-ledger.jsonl"


def ledger_spent_usd(path: Optional[Path] = None) -> float:
    path = path or ledger_path()
    total = 0.0
    try:
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                try:
                    cost = json.loads(line).get("cost_usd")
                except ValueError:
                    continue
                if isinstance(cost, (int, float)) and math.isfinite(cost):
                    total += float(cost)
    except OSError:
        pass
    return total


def _ledger_append(record: Dict[str, Any], path: Optional[Path] = None) -> None:
    path = path or ledger_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")


def cost_usd(model: str, input_tokens: int, output_tokens: int) -> float:
    price_in, price_out = PRICING_PER_MTOK[model]
    return (input_tokens * price_in + output_tokens * price_out) / 1_000_000.0


def worst_case_usd(model: str, input_tokens_estimate: int) -> float:
    # A refusal can be re-run on the fallback model inside the same call, so bound both.
    return max(cost_usd(m, input_tokens_estimate, MAX_OUTPUT_TOKENS) for m in (model, FALLBACK_MODEL_FOR_BUDGET))


def served_cost_usd(configured: str, served: str, input_tokens: int, output_tokens: int) -> Tuple[float, bool]:
    """Cost at the model that served the call; an unpriced served model is charged at the
    most expensive known rate and flagged as an estimate."""
    if served in PRICING_PER_MTOK:
        return cost_usd(served, input_tokens, output_tokens), False
    if not served or served == configured:
        return cost_usd(configured, input_tokens, output_tokens), False
    worst = max(PRICING_PER_MTOK, key=lambda m: PRICING_PER_MTOK[m][1])
    return cost_usd(worst, input_tokens, output_tokens), True


# ── request from the plug-in ─────────────────────────────────────────────────────────
def _text(data: Dict[str, Any], key: str, limit: int = MAX_TEXT_CHARS) -> str:
    value = data.get(key, "")
    if value is None:
        return ""
    if not isinstance(value, str):
        raise PlannerError("invalid-request", key + " must be a string")
    if len(value) > limit:
        raise PlannerError("invalid-request", key + " is longer than " + str(limit) + " characters")
    return value.strip()


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return float(value)


def parse_plan_request(data: Any) -> Dict[str, Any]:
    """Validates the plug-in's /reimagine/plan body and keeps ONLY the text fields the
    planner may send. Anything else in the body (paths, hashes) is dropped here."""
    if not isinstance(data, dict):
        raise PlannerError("invalid-request", "body must be a JSON object")
    request = _text(data, "request")
    if not request:
        raise PlannerError("invalid-request", "request is empty")
    revision = _text(data, "revision")
    ctx = data.get("context") or {}
    if not isinstance(ctx, dict):
        raise PlannerError("invalid-request", "context must be an object")
    limits = data.get("limits") or {}
    if not isinstance(limits, dict):
        raise PlannerError("invalid-request", "limits must be an object")

    max_candidates = limits.get("max_candidates")
    if isinstance(max_candidates, bool) or not isinstance(max_candidates, int) or not 1 <= max_candidates <= MAX_CANDIDATES:
        raise PlannerError("invalid-request", "limits.max_candidates must be 1-" + str(MAX_CANDIDATES))
    seconds = _number(data.get("input_seconds"))
    if seconds is None or seconds <= 0:
        raise PlannerError("invalid-request", "input_seconds must be a positive number")
    role = data.get("input_role", "source")
    if role not in ("source", "parent-take"):
        raise PlannerError("invalid-request", "input_role must be source or parent-take")

    chords: List[Dict[str, Any]] = []
    raw_chords = ctx.get("chords") or []
    if not isinstance(raw_chords, list) or len(raw_chords) > MAX_CHORDS:
        raise PlannerError("invalid-request", "context.chords must be a list of at most " + str(MAX_CHORDS))
    for item in raw_chords:
        bar = _number(item.get("bar")) if isinstance(item, dict) else None
        symbol = item.get("symbol") if isinstance(item, dict) else None
        if bar is None or not isinstance(symbol, str) or not 0 < len(symbol) <= 24:
            raise PlannerError("invalid-request", "each chord needs a numeric bar and a short symbol")
        chords.append({"bar": bar, "symbol": symbol})

    protected = ctx.get("protected") or []
    if not isinstance(protected, list) or not all(isinstance(p, str) and len(p) <= 200 for p in protected):
        raise PlannerError("invalid-request", "context.protected must be a list of short strings")

    def provenance(key: str) -> str:
        value = ctx.get(key, "unknown")
        return value if value in ("unknown", "host", "user", "inferred") else "unknown"

    bpm = _number(ctx.get("bpm"))
    meter = ctx.get("meter") if isinstance(ctx.get("meter"), str) and len(ctx.get("meter")) <= 8 else ""
    return {
        "request": request,
        "revision": revision,
        "input_seconds": round(seconds, 3),
        "input_role": role,
        "context": {
            "key": _text(ctx, "key", 64),
            "key_from": provenance("key_from"),
            "bpm": round(bpm, 3) if bpm and bpm > 0 else None,
            "bpm_from": provenance("bpm_from"),
            "meter": meter,
            "chords": chords,
            "chords_from": provenance("chords_from"),
            "section": _text(ctx, "section", 64),
            "protected": [p.strip() for p in protected if p.strip()],
        },
        "limits": {"max_candidates": max_candidates, "strength_min": MIN_STRENGTH,
                   "strength_max": MAX_STRENGTH, "max_prompt_chars": MAX_PROMPT_CHARS},
    }


def user_message(plan_request: Dict[str, Any]) -> str:
    """The exact text sent to the provider (also what the disclosure describes)."""
    return json.dumps(plan_request, indent=1, sort_keys=True)


def estimate_input_tokens(plan_request: Dict[str, Any]) -> int:
    # ~4 characters per token for English/JSON, plus the schema; rounded up generously.
    chars = len(SYSTEM_PROMPT) + len(user_message(plan_request)) + len(json.dumps(PLAN_SCHEMA))
    return chars // 3 + 200


# ── plan from the provider ───────────────────────────────────────────────────────────
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def validate_plan(plan: Any, plan_request: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(plan, dict):
        raise PlannerError("invalid-plan", "plan is not a JSON object")
    prompt = plan.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise PlannerError("invalid-plan", "plan has no prompt")
    prompt = " ".join(_CONTROL.sub(" ", prompt).split())
    if len(prompt) > MAX_PROMPT_CHARS:
        raise PlannerError("invalid-plan", "plan prompt is longer than " + str(MAX_PROMPT_CHARS) + " characters")
    strength = _number(plan.get("strength"))
    if strength is None or not MIN_STRENGTH <= strength <= MAX_STRENGTH:
        raise PlannerError("invalid-plan", "plan strength outside 0.01-0.5")
    count = plan.get("candidate_count")
    max_candidates = plan_request["limits"]["max_candidates"]
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= max_candidates:
        raise PlannerError("invalid-plan", "plan candidate_count outside 1-" + str(max_candidates))
    interpretation = plan.get("interpretation")
    unsupported = plan.get("unsupported")
    if not isinstance(interpretation, str) or not isinstance(unsupported, list) \
            or not all(isinstance(u, str) for u in unsupported):
        raise PlannerError("invalid-plan", "plan is missing interpretation/unsupported")
    return {
        "prompt": prompt,
        "strength": round(strength, 4),
        "candidate_count": count,
        "interpretation": " ".join(interpretation.split())[:400],
        "unsupported": [" ".join(u.split())[:200] for u in unsupported if u.strip()][:12],
    }


# ── the provider call (runs in the planner subprocess, never in the helper) ──────────
def call_claude(cfg: Dict[str, Any], plan_request: Dict[str, Any],
                client_factory: Optional[Callable[[str], Any]] = None) -> Dict[str, Any]:
    """One Messages API call with a JSON-schema-constrained answer. Returns
    {plan, usage, model, request_id, stop_reason} or raises PlannerError."""
    try:
        import anthropic  # noqa: PLC0415 (only the planner venv has it)
    except ImportError as exc:
        raise PlannerError("no-sdk", "the anthropic package is not installed in " + sys.executable) from exc
    make = client_factory or (lambda key: anthropic.Anthropic(api_key=key, timeout=90.0, max_retries=2))
    client = make(cfg["api_key"])
    try:
        response = client.beta.messages.create(
            model=cfg["model"],
            max_tokens=MAX_OUTPUT_TOKENS,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message(plan_request)}],
            output_config={"effort": cfg["effort"],
                           "format": {"type": "json_schema", "schema": PLAN_SCHEMA}},
            betas=["server-side-fallback-2026-07-01"],
            # A safety decline is re-run server-side on Anthropic's recommended fallback
            # model instead of failing the plan. extra_body keeps older SDKs working.
            extra_body={"fallbacks": "default"},
        )
    except anthropic.AuthenticationError as exc:
        raise PlannerError("auth", "the API key was rejected") from exc
    except anthropic.PermissionDeniedError as exc:
        raise PlannerError("auth", "the API key lacks permission for " + cfg["model"]) from exc
    except anthropic.RateLimitError as exc:
        raise PlannerError("rate-limit", "rate limited by the API; try again shortly") from exc
    except anthropic.BadRequestError as exc:
        raise PlannerError("api-error", "request rejected: " + str(getattr(exc, "message", exc))) from exc
    except anthropic.APIStatusError as exc:
        raise PlannerError("api-error", "API error " + str(exc.status_code)) from exc
    except anthropic.APIConnectionError as exc:
        raise PlannerError("network", "could not reach the API") from exc

    usage = getattr(response, "usage", None)
    usage_out = {"input_tokens": int(getattr(usage, "input_tokens", 0) or 0),
                 "output_tokens": int(getattr(usage, "output_tokens", 0) or 0)}
    served_model = str(getattr(response, "model", "") or cfg["model"])
    result: Dict[str, Any] = {"usage": usage_out, "model": served_model,
                              "request_id": str(getattr(response, "_request_id", "") or ""),
                              "stop_reason": str(getattr(response, "stop_reason", "") or "")}
    if result["stop_reason"] == "refusal":
        result["error"] = {"reason": "refused", "message": "the model declined this request"}
        return result
    if result["stop_reason"] == "max_tokens":
        result["error"] = {"reason": "invalid-plan", "message": "the plan was cut off at max_tokens"}
        return result
    text = next((b.text for b in getattr(response, "content", []) if getattr(b, "type", "") == "text"), "")
    try:
        result["plan"] = json.loads(text)
    except ValueError:
        result["error"] = {"reason": "invalid-plan", "message": "the plan was not valid JSON"}
    return result


def subprocess_main(stdin=sys.stdin, stdout=sys.stdout) -> int:
    """`python reimagine_planner.py --call`: reads the plan request on stdin, makes the
    call with the key from the opt-in file, writes one JSON object on stdout."""
    try:
        plan_request = json.loads(stdin.read())
        cfg = load_config()
        problem = config_problem(cfg)
        if problem:
            raise problem
        out = call_claude(cfg, plan_request)
    except PlannerError as exc:
        out = {"error": {"reason": exc.reason, "message": str(exc)}}
    except ValueError:
        out = {"error": {"reason": "invalid-request", "message": "planner input was not JSON"}}
    stdout.write(json.dumps(out))
    stdout.flush()
    return 0


# ── the helper-side entry points (service/server.py) ─────────────────────────────────
def planner_python() -> str:
    override = os.environ.get("MOSH_REIMAGINE_PLANNER_PYTHON", "").strip()
    if override:
        return override
    venv = Path.home() / "Library" / "Mosh" / "planner-venv" / "bin" / "python"
    return str(venv) if venv.exists() else sys.executable


def status(cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    cfg = cfg or load_config()
    problem = config_problem(cfg)
    spent = ledger_spent_usd()
    return {
        "ok": True,
        "enabled": problem is None,
        "reason": problem.reason if problem else "",
        "message": str(problem) if problem else "",
        "provider": cfg["provider"] or "none",
        "model": cfg["model"],
        "effort": cfg["effort"],
        "budgetUsd": cfg["budget_usd"] if math.isfinite(cfg["budget_usd"]) else None,
        "spentUsd": round(spent, 6),
        "plannerVersion": PLANNER_VERSION,
        "sends": "typed request and revision, key, BPM, meter, chord names with bar numbers, "
                 "section label, protected choices, input duration and role; never audio, paths or hashes",
    }


def _run_subprocess(plan_request: Dict[str, Any]) -> Dict[str, Any]:
    script = str(Path(__file__).resolve())
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}  # the opt-in file is the only key source
    try:
        proc = subprocess.run([planner_python(), "-I", script, "--call"], input=json.dumps(plan_request),
                              capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_S, env=env, check=False)
    except subprocess.TimeoutExpired as exc:
        raise PlannerError("timeout", "the planner did not answer within " + str(int(SUBPROCESS_TIMEOUT_S)) + " s") from exc
    except OSError as exc:
        raise PlannerError("no-sdk", "cannot start the planner interpreter " + planner_python()) from exc
    try:
        return json.loads(proc.stdout)
    except ValueError as exc:
        raise PlannerError("internal", "the planner subprocess returned no JSON (exit " + str(proc.returncode) + ")") from exc


def plan(data: Any, runner: Callable[[Dict[str, Any]], Dict[str, Any]] = _run_subprocess,
         cfg: Optional[Dict[str, Any]] = None, now: Callable[[], float] = time.monotonic) -> Dict[str, Any]:
    """POST /reimagine/plan. Returns {ok:true, plan, controller, budget} or
    {ok:false, reason, error}. Every provider call is priced and written to the ledger,
    failures included."""
    try:
        plan_request = parse_plan_request(data)
        cfg = cfg or load_config()
        problem = config_problem(cfg)
        if problem:
            raise problem
        spent = ledger_spent_usd()
        worst = worst_case_usd(cfg["model"], estimate_input_tokens(plan_request))
        if spent + worst > cfg["budget_usd"]:
            raise PlannerError("budget", "planner budget reached: $%.2f of $%.2f spent (this call could cost up to $%.2f)"
                               % (spent, cfg["budget_usd"], worst))
    except PlannerError as exc:
        return {"ok": False, "reason": exc.reason, "error": str(exc)}

    started = now()
    try:
        out = runner(plan_request)
    except PlannerError as exc:
        return {"ok": False, "reason": exc.reason, "error": str(exc)}
    latency_ms = int((now() - started) * 1000)

    usage = out.get("usage") or {}
    in_tok, out_tok = int(usage.get("input_tokens", 0) or 0), int(usage.get("output_tokens", 0) or 0)
    cost, estimated = served_cost_usd(cfg["model"], str(out.get("model", "")), in_tok, out_tok)
    controller = {
        "plannerVersion": PLANNER_VERSION, "provider": "anthropic", "model": cfg["model"],
        "servedModel": out.get("model", ""), "effort": cfg["effort"], "requestId": out.get("request_id", ""),
        "inputTokens": in_tok, "outputTokens": out_tok, "costUsd": round(cost, 6), "costEstimated": estimated, "latencyMs": latency_ms,
        "stopReason": out.get("stop_reason", ""),
    }
    if in_tok or out_tok or out.get("request_id"):
        try:
            _ledger_append({"at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                            "planner": PLANNER_VERSION, "model": cfg["model"], "served_model": controller["servedModel"],
                            "request_id": controller["requestId"], "input_tokens": in_tok, "output_tokens": out_tok,
                            "cost_usd": round(cost, 6), "ok": "error" not in out})
        except OSError:
            pass
    budget = {"budgetUsd": cfg["budget_usd"], "spentUsd": round(ledger_spent_usd(), 6)}

    if "error" in out:
        err = out["error"] if isinstance(out["error"], dict) else {}
        return {"ok": False, "reason": err.get("reason", "api-error"), "error": err.get("message", "planner failed"),
                "controller": controller, "budget": budget}
    try:
        validated = validate_plan(out.get("plan"), plan_request)
    except PlannerError as exc:
        return {"ok": False, "reason": exc.reason, "error": str(exc), "controller": controller, "budget": budget}
    return {"ok": True, "plan": validated, "controller": controller, "budget": budget}


if __name__ == "__main__":
    if "--call" in sys.argv[1:]:
        sys.exit(subprocess_main())
    if "--status" in sys.argv[1:]:
        print(json.dumps(status(), indent=1))
        sys.exit(0)
    print("usage: reimagine_planner.py --status | --call < request.json", file=sys.stderr)
    sys.exit(2)
