#!/usr/bin/env python3
"""Golden tests for the prompt compiler (L0, fake-first, generative-only).

The loop is compile → classify → build envelope → VALIDATE. The FAKE backend is
deterministic (keyword tables + a colour registry read from colors.json) so the whole
loop runs with zero LLM/venv/numpy and is reproducible (run 3x -> identical). This proves
the envelope is always a LEGAL render command (known colours, no forbidden pairs, nl in
range, SA3-honored knobs only), not taste — taste is the offline oracle (L2) + the human.

Run:  python3 service/compiler/compiler_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from compiler import core  # noqa: E402

fails = []

# Pin the fake backend regardless of any locally-configured brain provider.
os.environ["MOSH_ENABLE_COMPILER"] = "0"

# SA3-honored knobs only — the R1 guard: the envelope must NEVER carry these.
FORBIDDEN_KEYS = {"cfg", "steps", "negative_prompt", "guidance_scale", "negativePrompt"}
ALLOWED_KEYS = {"mode", "prompt", "nl", "colors", "lab", "seed", "target", "strength",
                "reason", "say"}


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def comp(instruction, **kw):
    return core.compile(instruction, backend="fake", **kw)


# ── 1. empty instruction is rejected ──────────────────────────────────────────────
check("empty instruction ⇒ ok False", comp("").get("ok") is False)

# ── 2. re-imagine: descriptors map to colours; the envelope is valid ──────────────
r = comp("make it lo-fi and gritty")
check("lo-fi ⇒ reimagine", r["mode"] == "reimagine", r["reasoning"])
env = r["envelope"]
check("lo-fi picks the 'grit' colour",
      any(c["name"] == "grit" for c in env["colors"]), str(env["colors"]))
check("reimagine prompt is non-empty", bool(env["prompt"].strip()), env["prompt"])
check("nl is within SA3's 0.01–0.5", 0.01 <= env["nl"] <= 0.5, str(env["nl"]))
check("backend is fake", r["backend"] == "fake")

# ── 3. 'darker' ⇒ brightness with a sub-50 (reversed) slider ──────────────────────
d = comp("make my guitar darker")["envelope"]
bri = [c for c in d["colors"] if c["name"] == "brightness"]
check("darker ⇒ brightness colour present", len(bri) == 1, str(d["colors"]))
check("darker ⇒ brightness value < 50 (reversed)", bri and bri[0]["value"] < 50, str(bri))
check("an instrument noun flavours the prompt", "guitar" in d["prompt"].lower(), d["prompt"])

# ── 4. transform: an explicit 'as a / into a' instrument framing ──────────────────
t = comp("re-imagine this as a violin")
check("'as a violin' ⇒ transform mode", t["mode"] == "transform", t["reasoning"])
check("transform target is the instrument", "violin" in t["envelope"]["target"], t["envelope"]["target"])
check("transform strength in 0–100", 0 <= t["envelope"]["strength"] <= 100, str(t["envelope"]["strength"]))
t2 = comp("turn it into a synth pad")
check("'into a synth pad' ⇒ transform to synth pad", "synth pad" in t2["envelope"]["target"], t2["envelope"]["target"])

# ── 5. honest boundary: corrective routes to the RIGHT existing tool (not a re-perform) ─
for instr, sub, tool in [
    ("fix the tuning", "pitch", "moshAutoTune"),
    ("this take is pitchy", "pitch", "moshAutoTune"),
    ("tighten the timing", "timing", "quantize_notes"),
    ("quantize it to the grid", "timing", "quantize_notes"),
    ("it sounds too muddy", "tone", "eq"),
    ("the levels are uneven", "dynamics", "moshOTT"),
]:
    r = comp(instr)
    check(f"[{instr}] ⇒ corrective", r["mode"] == "corrective", r["reasoning"])
    check(f"[{instr}] ⇒ subtype {sub}", r.get("subtype") == sub, str(r.get("subtype")))
    check(f"[{instr}] ⇒ routes to {tool}", r.get("tool") == tool, str(r.get("tool")))
    check(f"[{instr}] ⇒ null envelope (corrects, doesn't re-perform)", r["envelope"] is None)
    check(f"[{instr}] ⇒ honest say", bool(r["say"]))

# generic 'fix' with no clear sub-type ⇒ corrective + ambiguous (offers the menu, no tool)
amb = comp("fix my guitar")
check("'fix my guitar' ⇒ corrective ambiguous", amb["mode"] == "corrective" and amb.get("subtype") == "ambiguous", str(amb))
check("ambiguous ⇒ no single tool", amb.get("tool") is None)
check("ambiguous say lists the options", "autotune" in (amb["say"] or "").lower())

# vocals + noise ⇒ unsupported (genuinely out of generative capability)
vc = comp("add a sung chorus")
check("vocal request ⇒ unsupported", vc["mode"] == "unsupported", vc["reasoning"])
check("vocal ⇒ instrumental-only say", "instrumental" in (vc["say"] or "").lower(), str(vc["say"]))
nz = comp("clean up the recording, too much hiss")
check("noise request ⇒ unsupported", nz["mode"] == "unsupported", nz["reasoning"])
check("noise ⇒ honest say", any(k in (nz["say"] or "").lower() for k in ("noise", "hiss", "restoration")))

# ── 6. R1 guard: ONLY SA3-honored keys; never cfg/steps/negative_prompt ───────────
for instr in ["make it epic and futuristic", "make it darker", "as a piano",
              "fix the tuning", "make it airy and bright"]:
    e = comp(instr)["envelope"]
    if e is None:
        continue
    keys = set(e.keys())
    check(f"[{instr}] no forbidden knobs", not (keys & FORBIDDEN_KEYS), str(keys & FORBIDDEN_KEYS))
    check(f"[{instr}] only known envelope keys", keys <= ALLOWED_KEYS, str(keys - ALLOWED_KEYS))

# ── 7. validity: every produced envelope re-validates without raising ─────────────
for instr in ["make it gritty", "make it epic", "darker and moodier", "as a violin",
              "airy and spacious", "punchy aggressive drums"]:
    e = comp(instr)["envelope"]
    if e is None:
        continue
    try:
        core._validate(e)
        check(f"[{instr}] envelope re-validates", True)
    except ValueError as ex:
        check(f"[{instr}] envelope re-validates", False, str(ex))

# ── 8. forbidden-pair safety: the fake never emits drum_aggression + grid_tightness ─
pp = comp("make the drums punchy and tight")["envelope"]
cn = {c["name"] for c in (pp["colors"] if pp else [])}
check("fake drops the forbidden drum_aggression+grid_tightness pair",
      not ({"drum_aggression", "grid_tightness"} <= cn), str(cn))

# ── 9. ≤3 colours even when many descriptors match ────────────────────────────────
many = comp("make it bright, gritty, epic, futuristic and airy")["envelope"]
check("at most 3 colours", len(many["colors"]) <= 3, str([c["name"] for c in many["colors"]]))

# ── 10. intensity → nl mapping (subtle < strong) ──────────────────────────────────
subtle = comp("make it subtly gritty")["envelope"]["nl"]
strong = comp("make it completely gritty")["envelope"]["nl"]
check(f"subtle nl ({subtle}) < strong nl ({strong})", subtle < strong)
explicit = comp("make it gritty", intensity=90)["envelope"]["nl"]
check(f"explicit intensity 90 ⇒ high nl ({explicit})", explicit > 0.4)

# ── 11. determinism: identical instruction ⇒ identical result, 3x ─────────────────
a = comp("make it lo-fi, gritty and dark")
b = comp("make it lo-fi, gritty and dark")
c = comp("make it lo-fi, gritty and dark")
check("compile is deterministic (a == b == c)", a == b == c, str(a["envelope"]))

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
sys.exit(len(fails))
