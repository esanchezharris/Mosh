# Voice / agent loop — verification protocol

How to prove the "talk to Moshi → real DAW edits" loop, at three levels of cost.
The loop: **voice/text → brain (LLM) → JSON commands → validate → MoshOps → Tracktion → snapshot → Moshi earcon.**

## Level 1 — offline, free, deterministic (runs in `npm test`)

```
cd ui && npm test
```

Covers (no network, no engine, no mic):

- **`commands.test.ts` — catalog ↔ backend arg contract.** Parses `src/moshops/MoshOps.cpp` and asserts every arg name the brain may emit is one the C++ handler actually reads. This is the regression guard for the class of bug where the catalog declared `set_transport(playing)` but the engine reads `action` — so the command silently no-ops against the real app. If a future catalog edit drifts from the backend, this test fails.
- **`commands.test.ts` — validation.** Every catalog command's happy path validates; unknown commands, missing-required args, and wrong-typed args are all rejected *before* the command seam (the hallucination gate).
- **`brain.test.ts` — `parseReply`.** The fragile "pull one JSON object out of LLM prose" step: fenced ```json, prose-wrapped, malformed, and non-string fields.

## Level 2 — live LLM intent→command eval (needs a provider key, costs tokens)

Proves the brain turns natural language into the **right valid commands** against a real model, using the *exact* product system prompt + catalog + parser.

```
cd ui
MOSH_BRAIN_EVAL=1 \
DEEPSEEK_BASE_URL=https://api.deepseek.com DEEPSEEK_API_KEY=sk-... DEEPSEEK_MODEL=deepseek-chat \
npm run brain-eval
```

(`OPENAI_*` / `XAI_*` work too — same env var names the C++ `BrainProxy` resolves; set `MOSHI_BRAIN_PROVIDER` to force one.) Without `MOSH_BRAIN_EVAL=1` and a key, the suite **skips cleanly** with a one-line hint and makes no network calls — so it is safe in the default `npm test`.

Asserts, per ask (e.g. "mute the bass", "set the tempo to 90", "start playing"): the expected command is present, every emitted command passes `validateCommand` (no hallucinations), and args are sane. LLMs are nondeterministic — scoring is on the command *set* + arg *ranges*, not exact strings.

## Level 3 — manual end-to-end voice, on the real device (needs key + mic)

The one leg that can't be automated. In the packaged `Mosh.app`:

1. Put a provider key in `~/.config/mosh/env` (`DEEPSEEK_API_KEY` / `_BASE_URL` / `_MODEL`, or OpenAI/xAI).
   Launch the binary **directly** (not `open`) so the env propagates:
   `./build/Mosh_artefacts/Mosh.app/Contents/MacOS/Mosh`
2. Hold Moshi's mic button and speak ~6 commands that exercise the corrected contract, e.g.:
   - "add a track called drums"  → a track appears
   - "set the tempo to 90"        → tempo readout = 90
   - "mute the drums"             → track mutes
   - "play it"                    → **transport starts** (this is the `action` fix — was broken before)
   - "stop"                       → transport stops
   - "make the drums a bit quieter" → volume drops
3. Confirm for each: the Tracktion state changed, Moshi fired an earcon, and **one Undo reverts the whole spoken edit** (agent batches = one undo step).
4. Grant the two TCC prompts on first use (Microphone + Speech Recognition).

If voice is unavailable (e.g. `voice_supported()` false), the same loop is exercisable by **typing** into Moshi's composer — voice and text feed the identical pipe.
