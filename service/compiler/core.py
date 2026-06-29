#!/usr/bin/env python3
"""Prompt-compiler core — compile a loose instruction into a VALIDATED Stable-Audio
render envelope (the lyrics generation loop applied to render params).

The shape mirrors service/lyrics/core.py exactly:
  compile → classify mode → build envelope → VALIDATE → (LLM) retry-with-the-specific-
  failure → result.  `_auto_backend()` picks the real LLM when a brain provider is
  configured (and not force-disabled), else the deterministic FAKE — the same real→fake
  posture as stable_audio3 → FakeAdapter and lyrics L3.

The validator is the colour registry (service/colors/COLORRACK_DATA/colors.json) + the
schema bounds, NOT phonology — same role the phonology core plays for lyrics: it
GUARANTEES the envelope is a legal command, so a loose instruction (or a hallucinating
LLM) can never emit an invalid render. We reuse the SAME registry + `no_stack_with` +
≤3 rules as colors.runtime.resolve_steers, read straight from colors.json (stdlib json,
no numpy / no vector load) so the whole loop + golden run hermetically.

Generative-only v1: we classify reimagine | transform | unsupported. A clearly
*corrective* instruction ("fix my guitar", "tighten the timing") or a *vocal* request is
`unsupported` and returns an honest `say` — we do NOT silently re-perform the take. The
envelope only ever carries SA3-HONORED knobs (prompt, nl, colors, lab, seed; target,
strength for transform) — never the dead cfg/steps or a non-existent negative_prompt.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Dict, List, Optional, Tuple

# Where the colour registry lives — same env override + default as colors/runtime.py
# (service/colors/COLORRACK_DATA), but read directly so validation needs no numpy.
_COLORRACK_DATA = os.environ.get(
    "COLORRACK_DATA",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                 "colors", "COLORRACK_DATA"))
_REG_CACHE: Optional[Dict[str, dict]] = None

# nl (init_noise_level) — SA3 clamps 0.01–0.5; below ~0.5 the take stays recognizable.
_NL_MIN, _NL_MAX = 0.01, 0.5
_NL_BASE = 0.40

# Honest refusals for things the generative model genuinely can't do.
_SAY = {
    "vocal": "I only generate instrumental textures — I can't create or fix vocals.",
    "noise": "I can't clean up noise/hiss in a recording yet — that needs a restoration tool.",
    "ambiguous": ("I can correct the TUNING (AutoTune), TIMING (quantize), TONE (EQ) or "
                  "LEVELS (OTT) — which one? Or describe the sound you want and I'll re-imagine it."),
    "other": "I can't do that with the generative model — try re-imagining or transforming the part.",
}

# ── keyword tables (the deterministic fake; also the LLM's fallback) ──────────────

# Corrective sub-types → the EXISTING tool that actually fixes the take (corrects it in
# place, never a synthetic re-performance). Each: (triggers, subtype, tool [a load_builtin
# type or "quantize_notes"], say). The caller (UI/agent) holds the track/clip context and
# runs the tool; the compiler only classifies + names it.
_CORRECTIVE_SUBTYPES = [
    (["in tune", "out of tune", "out-of-tune", "off-key", "off key", "off-pitch", "pitchy",
      "tune it", "tune the", "tune my", "retune", "autotune", "auto-tune", "pitch correct",
      "pitch-correct", "fix the tuning", "fix the pitch", "fix my pitch", "intonation",
      "flat notes", "sharp notes"],
     "pitch", "moshAutoTune",
     "That's a tuning issue — AutoTune corrects the pitch in place; it doesn't re-perform the take."),
    (["tighten", "on the beat", "off the beat", "off-beat", "quantize", "fix the timing",
      "fix timing", "loose timing", "sloppy timing", "timing is off", "lock it to the grid",
      "line it up"],
     "timing", "quantize_notes",
     "That's a timing issue — quantize snaps the notes to the grid (MIDI clips); it doesn't re-perform the take."),
    (["too muddy", "muddy", "too harsh", "harsh", "boomy", "boxy", "too thin", "tinny",
      "fix the tone", "fix the eq", "honky"],
     "tone", "eq",
     "That's a tone issue — an EQ shapes it without re-performing the take."),
    (["too quiet", "too loud", "uneven", "inconsistent level", "levels are", "level it",
      "even it out", "even out the level", "compress the", "fix the dynamics", "dynamics are",
      "jumpy levels", "level is all over"],
     "dynamics", "moshOTT",
     "Uneven levels — OTT (multiband compression) evens them out without re-performing."),
]
_NOISE = ["clean up the recording", "de-noise", "denoise", "remove the noise", "remove noise",
          "too noisy", "background hiss", "tape hiss", "background hum", "hum in the", "crackle",
          "take out the noise", "get rid of the noise"]
_GENERIC_FIX = ["fix ", "fix the", "fix my", "fix it", "fix this", "fix that", "repair", "correct the", "clean up"]
_VOCAL = ["vocal", "vocals", "sing ", "singing", "sung", "singer", "a cappella",
          "acappella", "acapella", "add lyrics", "sung chorus", "voiceover", "rap verse"]

# descriptor substring(s) → (colour name, slider value 0–100; 50 = neutral, <50 reverses).
_DESCRIPTORS: List[Tuple[List[str], str, float]] = [
    (["brighter", "brighten", "shinier", "shimmer", "sparkl", "crisp", "glossy", "clearer"], "brightness", 76),
    (["darker", "duller", "muffled", "murky", "gloom", "moodier", "warmer low", "less bright"], "brightness", 24),
    (["gritty", "grittier", "grit", "dirty", "dirtier", "grimy", "grungy", "rough", "raw",
      "lo-fi", "lofi", "lo fi", "crunch", "crunchy", "tape", "dusty", "vintage", "old-school", "worn"], "grit", 72),
    (["distort", "fuzz", "overdriv", "overdrive", "saturat", "screaming", "blown out", "blown-out"], "distortion", 70),
    (["epic", "cinematic", "huge", "massive", "grand", "dramatic", "anthemic", "soaring",
      "triumphant", "larger than life", "bigger"], "epic", 70),
    (["futuristic", "sci-fi", "scifi", "synthetic", "digital", "robotic", "cyber", "spacey",
      "spacial", "alien", "android"], "futuristic", 70),
    (["tense", "tension", "anxious", "unsettling", "eerie", "ominous", "menacing", "sinister",
      "dread", "creepy", "uneasy", "nervous"], "tension", 70),
    (["airy", "airier", "spacious", "open", "breathy", "ethereal", "atmospheric", "ambient",
      "dreamy", "floaty", "lush", "wide", "shimmering air"], "air", 70),
    (["punchier", "punchy", "hard-hitting", "hard hitting", "aggressive drums", "banging",
      "slamming", "harder drums", "heavier drums", "hit harder"], "drum_aggression", 72),
    (["tighter", "tight grid", "on the grid", "quantized feel", "locked in", "snappier",
      "snappy"], "grid_tightness", 70),
]

# instrument vocab (longest-first match) — transform targets + prompt flavour.
_INSTRUMENTS = [
    "electric guitar", "acoustic guitar", "slide guitar", "12-string guitar", "guitar",
    "grand piano", "electric piano", "rhodes", "piano", "upright bass", "double bass", "bass",
    "string section", "strings", "orchestra", "synth pad", "synth", "pad", "organ", "flute",
    "clarinet", "saxophone", "sax", "trumpet", "french horn", "brass", "choir", "glockenspiel",
    "music box", "bells", "harp", "marimba", "vibraphone", "kalimba", "accordion", "banjo",
    "mandolin", "sitar", "cello", "viola", "violin", "drums",
]

# transform cues — an explicit "turn it into X" / "as a X" framing.
_TX_CUES = ["into a ", "into an ", "into the ", "as a ", "as an ", "as the ",
            "turn it into ", "turn this into ", "make it a ", "make it an ",
            "sound like a ", "sounds like a ", "sound like an ", "version of a ",
            "reimagine as ", "re-imagine as ", "transform to ", "transform into "]
_TX_STRONG = ["into a ", "into an ", "turn it into ", "turn this into ", "as a ", "as an ",
              "make it a ", "make it an ", "sound like a ", "sounds like a ", "transform into "]

_INTENSIFY_LOW = ["subtle", "subtly", "slightly", "a touch", "a little", "gentle", "gently",
                  "barely", "light ", "lightly", "a hint", "mild"]
_INTENSIFY_HIGH = ["completely", "totally", "fully", "way more", "a lot", "heavily", "heavy",
                   "extreme", "extremely", "drastically", "entirely", "all the way", "max"]

_COLOR_HINTS = {
    "brightness": "tonal brightness (slider <50 = darker)",
    "epic": "cinematic drama / scale",
    "distortion": "harmonic distortion / fuzz",
    "futuristic": "synthetic, digital character",
    "tension": "unease / eerie (polarity-reversed colour)",
    "grit": "roughness / lo-fi dirt",
    "air": "airy, open high-end (kept subtle)",
    "drum_aggression": "percussive punch",
    "grid_tightness": "timing tightness",
}


# ── registry (stdlib json — no numpy, no vectors) ─────────────────────────────────

def _registry() -> Dict[str, dict]:
    global _REG_CACHE
    if _REG_CACHE is None:
        p = os.path.join(_COLORRACK_DATA, "colors.json")
        try:
            with open(p, encoding="utf-8") as f:
                _REG_CACHE = json.load(f).get("colors", {})
        except (OSError, ValueError):
            _REG_CACHE = {}
    return _REG_CACHE


def available_colors() -> List[str]:
    return sorted(_registry().keys())


# ── small helpers ─────────────────────────────────────────────────────────────────

def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, float(x)))


def _seed_for(instruction: str) -> int:
    return int(hashlib.sha1(instruction.lower().strip().encode("utf-8")).hexdigest()[:8], 16)


def _intensity_signal(low: str, intensity: Optional[int]) -> float:
    """A 0..1 'how hard' signal from an explicit intensity (0–100) or keyword cues."""
    if intensity is not None:
        try:
            return _clamp(float(intensity) / 100.0, 0.0, 1.0)
        except (TypeError, ValueError):
            pass
    if any(k in low for k in _INTENSIFY_HIGH):
        return 0.95
    if any(k in low for k in _INTENSIFY_LOW):
        return 0.2
    return 0.5


def _nl_for(low: str, intensity: Optional[int]) -> float:
    sig = _intensity_signal(low, intensity)
    return round(_clamp(_NL_MIN + (_NL_MAX - _NL_MIN) * sig, _NL_MIN, _NL_MAX), 3)


def _strength_for(low: str, intensity: Optional[int]) -> float:
    sig = _intensity_signal(low, intensity)
    return round(_clamp(30.0 + 60.0 * sig, 0.0, 100.0), 1)


def _extract_instrument(low: str) -> str:
    for inst in _INSTRUMENTS:  # already longest-first
        if re.search(r"\b" + re.escape(inst) + r"\b", low):
            return inst
    return ""


def _transform_target(low: str) -> str:
    instr = _extract_instrument(low)
    has_cue = any(c in low for c in _TX_CUES)
    if instr and has_cue:
        return instr
    for strong in _TX_STRONG:
        i = low.find(strong)
        if i >= 0:
            tail = low[i + len(strong):].strip()
            phrase = " ".join(tail.split()[:3]).strip(" .,!?;:")
            if phrase:
                return phrase
    return ""


# ── the deterministic FAKE backend ────────────────────────────────────────────────

def _corrective_subtype(low: str) -> Optional[dict]:
    for triggers, subtype, tool, say in _CORRECTIVE_SUBTYPES:
        if any(t in low for t in triggers):
            return {"subtype": subtype, "tool": tool, "say": say}
    return None


def _classify(low: str) -> Tuple[str, dict]:
    sub = _corrective_subtype(low)            # specific fix → the right corrective tool
    if sub:
        return "corrective", sub
    if any(k in low for k in _NOISE):
        return "unsupported", {"reason": "noise"}
    if any(k in low for k in _VOCAL):
        return "unsupported", {"reason": "vocal"}
    if any(k in low for k in _GENERIC_FIX):   # a fix verb but no clear sub-type → offer the menu
        return "corrective", {"subtype": "ambiguous", "tool": None, "say": _SAY["ambiguous"]}
    tgt = _transform_target(low)
    if tgt:
        return "transform", {"target": tgt}
    return "reimagine", {}


def _colors_for(low: str) -> List[dict]:
    """Match descriptors → colours, then drop forbidden-pair conflicts + cap ≤3 so the
    fake is VALID by construction (the same rules the validator enforces)."""
    reg = _registry()
    picked: List[dict] = []
    names: List[str] = []
    for triggers, name, value in _DESCRIPTORS:
        if name in names:
            continue
        if any(t in low for t in triggers):
            # drop if it composes poorly with something already chosen
            if any(name in reg.get(n, {}).get("no_stack_with", []) or
                   n in reg.get(name, {}).get("no_stack_with", []) for n in names):
                continue
            picked.append({"name": name, "value": float(value)})
            names.append(name)
        if len(picked) >= 3:
            break
    return picked


def _prompt_for(low: str, colors: List[dict], instrument: str) -> str:
    words = {
        "brightness": "bright" if any(c["name"] == "brightness" and c["value"] >= 50 for c in colors) else "dark",
        "grit": "lo-fi, gritty", "distortion": "distorted", "epic": "epic, cinematic",
        "futuristic": "futuristic", "tension": "tense, eerie", "air": "airy, spacious",
        "drum_aggression": "punchy drums", "grid_tightness": "tight, locked-in",
    }
    parts = [words.get(c["name"], c["name"]) for c in colors]
    if instrument:
        parts.append(instrument)
    prompt = ", ".join(dict.fromkeys(parts)).strip()
    if not prompt:  # no descriptor matched — fall back to a cleaned instruction
        cleaned = re.sub(r"^(make|turn|re-?imagine|render|transform)\b\s*(it|this|my|the)?\s*",
                         "", low).strip(" .,!?")
        prompt = cleaned or low.strip()
    return prompt


def _fake_compile(instruction: str, intensity: Optional[int]) -> dict:
    low = instruction.lower().strip()
    mode, extra = _classify(low)
    seed = _seed_for(instruction)
    if mode == "unsupported":
        return {"mode": "unsupported", "reason": extra["reason"], "say": _SAY.get(extra["reason"], _SAY["other"])}
    if mode == "corrective":
        return {"mode": "corrective", "subtype": extra["subtype"], "tool": extra["tool"], "say": extra["say"]}
    if mode == "transform":
        return {"mode": "transform", "target": extra["target"], "strength": _strength_for(low, intensity),
                "seed": seed, "prompt": "", "colors": [], "lab": False}
    colors = _colors_for(low)
    instrument = _extract_instrument(low)
    return {"mode": "reimagine", "prompt": _prompt_for(low, colors, instrument),
            "nl": _nl_for(low, intensity), "colors": colors, "lab": False, "seed": seed}


def _fake_reasoning(env: dict) -> str:
    if env["mode"] == "unsupported":
        return f"classified {env['reason']} — not a generative edit"
    if env["mode"] == "corrective":
        return f"corrective:{env['subtype']} → {env.get('tool') or 'clarify'}"
    if env["mode"] == "transform":
        return f"transform → {env['target']} @ strength {env['strength']:g}"
    cs = ", ".join(f"{c['name']}={c['value']:g}" for c in env.get("colors", [])) or "(no colours)"
    return f"re-imagine: {cs}; nl {env['nl']:g}"


# ── the validator (registry + schema bounds; raises the SPECIFIC failure) ─────────

def _validate_colors(colors: List[dict]) -> List[dict]:
    reg = _registry()
    if len(colors) > 3:
        raise ValueError(f"at most 3 colours allowed, you picked {len(colors)}")
    out, names = [], []
    for c in colors:
        name = str((c or {}).get("name", "")).strip()
        if reg and name not in reg:
            raise ValueError(f"unknown colour '{name}' — choose from {sorted(reg)}")
        out.append({"name": name, "value": _clamp((c or {}).get("value", 50), 0.0, 100.0)})
        names.append(name)
    nameset = set(names)
    for n in names:
        bad = (set(reg.get(n, {}).get("no_stack_with", [])) & nameset) - {n}
        if bad:
            raise ValueError(f"colour '{n}' composes poorly with {sorted(bad)} — pick one")
    return out


def _validate(env: dict) -> dict:
    """Return a cleaned/clamped envelope or raise ValueError with a specific message
    (the message is what the LLM backend re-prompts with)."""
    mode = (env or {}).get("mode")
    if mode == "unsupported":
        reason = str(env.get("reason") or "other")
        return {"mode": "unsupported", "reason": reason, "say": env.get("say") or _SAY.get(reason, _SAY["other"])}
    if mode == "corrective":
        subtype = str(env.get("subtype") or "ambiguous")
        tool = env.get("tool")
        tool = str(tool) if tool else None    # ambiguous → no single tool
        return {"mode": "corrective", "subtype": subtype, "tool": tool,
                "say": env.get("say") or _SAY["ambiguous"]}
    if mode == "transform":
        target = str(env.get("target") or "").strip()
        if not target:
            raise ValueError("transform needs a non-empty 'target' instrument")
        return {"mode": "transform", "target": target,
                "strength": _clamp(env.get("strength", 65), 0.0, 100.0),
                "seed": int(env.get("seed", 0)), "prompt": "", "colors": [], "lab": False}
    if mode == "reimagine":
        prompt = str(env.get("prompt") or "").strip()
        if not prompt:
            raise ValueError("reimagine needs a non-empty 'prompt'")
        return {"mode": "reimagine", "prompt": prompt,
                "nl": _clamp(env.get("nl", _NL_BASE), _NL_MIN, _NL_MAX),
                "colors": _validate_colors(env.get("colors") or []),
                "lab": bool(env.get("lab", False)), "seed": int(env.get("seed", 0))}
    raise ValueError(f"unknown mode '{mode}' — use reimagine | transform | unsupported")


# ── the LLM backend (L3) — propose → validate → re-prompt with the failure ────────

def _available_colors_doc() -> str:
    reg = _registry()
    lines = []
    for name in sorted(reg):
        hint = _COLOR_HINTS.get(name, name)
        ns = reg[name].get("no_stack_with", [])
        extra = f" (don't combine with {', '.join(ns)})" if ns else ""
        lines.append(f"- {name}: {hint}{extra}")
    return "\n".join(lines)


def _build_messages(instruction: str, intensity: Optional[int], feedback: Optional[str]) -> List[dict]:
    sys = (
        "You compile a producer's loose instruction about ONE audio clip into a Stable "
        "Audio render envelope. Reply with ONLY a JSON object, no commentary.\n"
        "Modes:\n"
        '  "reimagine" — re-texture the part with a prompt + steering colours. Fields: '
        '{"mode":"reimagine","prompt":str,"nl":0.01-0.5,"colors":[{"name":str,"value":0-100}],'
        '"lab":false}. nl is how far from the source (low=subtle, ~0.5=very different). '
        "Pick 0-3 colours from the palette; value 50 is neutral, <50 reverses the colour.\n"
        '  "transform" — turn the part into another INSTRUMENT timbre. Fields: '
        '{"mode":"transform","target":str,"strength":0-100}.\n'
        '  "corrective" — a tuning/timing/tone/dynamics FIX of the EXISTING take (correct it, '
        "don't re-perform it). Route to the tool that fixes it: "
        '{"mode":"corrective","subtype":"pitch"|"timing"|"tone"|"dynamics"|"ambiguous",'
        '"tool":"moshAutoTune"|"quantize_notes"|"eq"|"moshOTT"|null,"say":str}. '
        'Use subtype "ambiguous"/tool null when the fix is unclear.\n'
        '  "unsupported" — a VOCAL request (we only make instrumental textures) or NOISE '
        'removal we can\'t do: {"mode":"unsupported","reason":"vocal"|"noise","say":str}.\n'
        "Never invent knobs (no cfg, steps, or negative_prompt). Colour palette:\n"
        + _available_colors_doc())
    usr = f'Instruction: "{instruction}".'
    if intensity is not None:
        usr += f" Desired intensity (0-100): {intensity}."
    if feedback:
        usr += f" Your previous attempt was invalid: {feedback} Fix it."
    return [{"role": "system", "content": sys}, {"role": "user", "content": usr}]


def _parse_env(content: str) -> dict:
    obj = json.loads(content)
    if not isinstance(obj, dict):
        raise ValueError("expected a JSON object")
    return obj


def _coerce(obj: dict, instruction: str) -> dict:
    """Pull the envelope fields out of an LLM dict, defaulting a missing seed."""
    env = dict(obj)
    env.setdefault("seed", _seed_for(instruction))
    if "colors" in env and not isinstance(env["colors"], list):
        env["colors"] = []
    return env


def _llm_compile(instruction: str, intensity: Optional[int]) -> Tuple[dict, str, str]:
    import brain_client
    feedback: Optional[str] = None
    last_err: Optional[str] = None
    for _ in range(3):  # budget the retries; re-prompt with the specific validator failure
        resp = brain_client.chat_json(_build_messages(instruction, intensity, feedback))
        if not resp.get("ok"):
            last_err = resp.get("error", "brain unreachable")
            break
        try:
            env = _validate(_coerce(_parse_env(resp.get("content", "")), instruction))
            reasoning = str((_parse_env(resp.get("content", "")) or {}).get("reasoning", "")).strip() \
                or "compiled by LLM"
            return env, reasoning, "llm"
        except (ValueError, json.JSONDecodeError, TypeError) as e:
            last_err = str(e)
            feedback = last_err
            continue
    env = _validate(_fake_compile(instruction, intensity))  # unreachable/never-valid → fake
    return env, f"LLM unavailable or invalid ({last_err}); used fake", "fake"


def _auto_backend() -> str:
    """Real LLM when a brain provider is configured (and the compiler isn't force-
    disabled), else fake — independent of the lyric gate, mirroring that real→fake posture."""
    if os.environ.get("MOSH_ENABLE_COMPILER", "1") == "0":
        return "fake"
    try:
        import brain_client
        return "llm" if brain_client.resolve() is not None else "fake"
    except Exception:  # noqa: BLE001
        return "fake"


# ── the seam ───────────────────────────────────────────────────────────────────────

def compile(instruction: str, intensity: Optional[int] = None,
            backend: Optional[str] = None) -> dict:
    """Compile a loose instruction into a validated render envelope.

    Returns {ok, backend, mode, reasoning, envelope|None, say|None}. The envelope is a
    legal command argument set (reimagine/transform); `mode:"unsupported"` carries `say`
    and a null envelope (generative-only v1 — we don't re-perform a corrective request).
    """
    instruction = (instruction or "").strip()
    if not instruction:
        return {"ok": False, "error": "instruction required"}
    backend = backend or _auto_backend()
    if backend == "llm":
        env, reasoning, used = _llm_compile(instruction, intensity)
    else:
        env = _validate(_fake_compile(instruction, intensity))
        reasoning, used = _fake_reasoning(env), "fake"
    render = env["mode"] in ("reimagine", "transform")
    out = {"ok": True, "backend": used, "mode": env["mode"], "reasoning": reasoning,
           "envelope": env if render else None, "say": env.get("say")}
    if env["mode"] == "corrective":       # name the corrective tool the caller should run
        out["subtype"] = env.get("subtype")
        out["tool"] = env.get("tool")
    return out
