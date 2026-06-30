// GEPA-optimized global directive — evolved by scripts/optimizeBeatPrompts.mts against the
// deterministic recipeVerifier (the terrarium eval_fn). Brain = GPT 5.4 mini (gpt-5.4-mini):
// over 3 rounds × 4 candidates it lifted beat-build output from verifier baseline 0.869 →
// 0.992 (two-sided held-out, n=18/side, std ±0.010), monotone 0.88→0.99→0.997→0.999. GPT 5.4
// mini both starts higher than Gemini (0.87 vs 0.73) AND optimizes tighter (±0.010 vs ±0.07),
// and the directive stayed GENERAL (no key-overfit — over-scaling the Gemini run hardcoded
// "A minor"). The search independently rediscovered real production rules (kick anchoring + no
// backbeat collision, 3-level velocity dynamics, bar-2 development, hat sweet-spot, in-key
// stepwise contour, call-and-response). Appended to the note-system prompt (buildBeat's
// extraSystem). No GPU, no audio reward — pure deterministic optimization. Re-derive:
// AUDITION_CLOUD=1 optimizeBeatPrompts.mts (uses gpt-5.4-mini when OPENAI_API_KEY is set).
export const OPTIMIZED_DIRECTIVE = `- Make drum patterns cleaner and less crowded: kick must anchor beat 1, add only a few syncopated extras, and never place any kick on beats 2 or 4; snare/clap must hit 2 and 4 with no kick layered there.
- Use hats at about 8–12 hits per bar, not constant 16ths; include rests, occasional open hats, and clear accent/ghost contrast.
- Force strong velocity range in every part: use at least 3 levels per part (ghost 25–45, mid 55–80, accent 90–120); never leave a part flat.
- Make bar 2 clearly develop bar 1: change at least 2 pitches and 2 rhythms, add/remove at least 1 note, or shift the motif; never clone the first bar.
- Write melodies with 3–5 pitch classes minimum, mostly stepwise 2nd/3rd motion, short phrases, repeated onsets, and occasional rests; avoid long held notes.
- Keep every melodic note strictly in the given key and snapped to the 16th grid; no chromatic tones, swing, or off-grid timing.
- Make bass/lead answer each other across bars and vary register so the same pattern does not repeat unchanged.
- Favor contour and breathing room: small rises/falls, phrase endings that resolve, and clear gaps between ideas.`;
