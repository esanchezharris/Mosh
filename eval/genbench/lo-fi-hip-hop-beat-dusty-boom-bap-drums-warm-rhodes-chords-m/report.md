# Generative techniques bench

**Brief:** lo-fi hip-hop beat, dusty boom-bap drums, warm Rhodes chords, mellow sub bass  ·  85 BPM · A minor  ·  model: **real SA3 (MLX)**  ·  seed 42 unless noted

Same brief, DAW held constant — only the generation technique changes. Every WAV is peak-normalized to −1 dBFS so loudness isn't a confound (you judge timbre, not level). Higher `brief-match` (CLAP) = sounds more like the brief; `sine` is the anti-reference (should stay below brief). `perceptual` = Audiobox production quality.

| technique | knob | perceptual | brief-match | sine | flags |
|-----------|------|------------|-------------|------|-------|
| `P0-terse` | prompt | 7.04 | 0.336 | -0.176 | muddy: 85% rolloff 678 Hz; dropout: silent gap mid-signal |
| `P1-descriptive` | prompt | 7.66 | 0.511 | -0.044 | muddy: 85% rolloff 991 Hz; tonal_suspect: flatness 0.0010 — likely a test tone / empty synth, not a real mix |
| `P2-tag` | prompt | 7.43 | 0.495 | 0.088 | muddy: 85% rolloff 754 Hz; tonal_suspect: flatness 0.0003 — likely a test tone / empty synth, not a real mix |
| `P3-reference` | prompt | 7.60 | 0.532 | 0.010 | muddy: 85% rolloff 864 Hz; tonal_suspect: flatness 0.0010 — likely a test tone / empty synth, not a real mix |
| `A2A-melody` | audio2audio | 7.83 | 0.344 | -0.234 | tonal_suspect: flatness 0.0004 — likely a test tone / empty synth, not a real mix |
| `A2A-drums` | audio2audio | 7.59 | 0.284 | -0.050 | muddy: 85% rolloff 1349 Hz; dropout: silent gap mid-signal |
| `C-grit` | color | 6.70 | 0.369 | -0.072 | muddy: 85% rolloff 1184 Hz; tonal_suspect: flatness 0.0003 — likely a test tone / empty synth, not a real mix |
| `C-air` | color | 7.54 | 0.470 | 0.063 | muddy: 85% rolloff 985 Hz; tonal_suspect: flatness 0.0004 — likely a test tone / empty synth, not a real mix |
| `BoN-s7` | seed | 8.17 | 0.488 | 0.107 | muddy: 85% rolloff 592 Hz; dropout: silent gap mid-signal |
| `BoN-s101` 🏆 | seed | 7.49 | 0.530 | 0.061 | muddy: 85% rolloff 883 Hz; tonal_suspect: flatness 0.0006 — likely a test tone / empty synth, not a real mix |
| `BoN-s256` | seed | 7.72 | 0.518 | 0.011 | muddy: 85% rolloff 880 Hz; tonal_suspect: flatness 0.0004 — likely a test tone / empty synth, not a real mix |
| `BoN-s512` | seed | 7.71 | 0.418 | 0.173 | tonal_suspect: flatness 0.0004 — likely a test tone / empty synth, not a real mix |
| `HiSteps-16` | steps | 7.75 | 0.472 | 0.083 | muddy: 85% rolloff 783 Hz; tonal_suspect: flatness 0.0009 — likely a test tone / empty synth, not a real mix |

🏆 **Best-of-N** (seed sweep): `BoN-s101` — highest brief-match of the four seeds.

## The exact prompts (this is the prompt-engineering surface)

- **P0-terse** _(Terse control prompt (what the agent writes off-the-cuff))_
  `lo-fi hip-hop beat with dusty boom-bap drums, 85 BPM`
- **P1-descriptive** _(Flowing natural-language description)_
  `Nostalgic, mellow, a lo-fi hip-hop loop at 85 BPM, A minor featuring dusty boom-bap drums, warm Rhodes chords, mellow sub bass, with vinyl crackle, tape saturation, MPC swing.`
- **P2-tag** _(Stable-Audio metadata/tag style (comma descriptors + BPM/key))_
  `lo-fi hip-hop, 90s, dusty boom-bap drums, warm Rhodes chords, mellow sub bass, 85 BPM, A minor, nostalgic, mellow, hazy, vinyl crackle, tape saturation, MPC swing`
- **P3-reference** _(Era + gear/artist reference style)_
  `90s lo-fi hip-hop instrumental in the style of J Dilla, SP-1200, Madlib: dusty boom-bap drums, warm Rhodes chords, mellow sub bass, 85 BPM, A minor, vinyl crackle, tape saturation`
- **A2A-melody** _(Re-imagine a real 85 BPM soul melody loop (nl 0.4))_
  `lo-fi hip-hop, 90s, dusty boom-bap drums, warm Rhodes chords, mellow sub bass, 85 BPM, A minor, nostalgic, mellow, hazy, vinyl crackle, tape saturation, MPC swing`
- **A2A-drums** _(Re-imagine a real neo-soul drum loop (nl 0.35))_
  `lo-fi hip-hop, 90s, dusty boom-bap drums, warm Rhodes chords, mellow sub bass, 85 BPM, A minor, nostalgic, mellow, hazy, vinyl crackle, tape saturation, MPC swing`
- **C-grit** _(Tag prompt + grit steering (dusty/saturated))_
  `lo-fi hip-hop, 90s, dusty boom-bap drums, warm Rhodes chords, mellow sub bass, 85 BPM, A minor, nostalgic, mellow, hazy, vinyl crackle, tape saturation, MPC swing`
- **C-air** _(Tag prompt + air steering (ASTD-capped at 0.08))_
  `lo-fi hip-hop, 90s, dusty boom-bap drums, warm Rhodes chords, mellow sub bass, 85 BPM, A minor, nostalgic, mellow, hazy, vinyl crackle, tape saturation, MPC swing`
- **BoN-s7** _(Tag prompt, seed 7 (best-of-N candidate))_
  `lo-fi hip-hop, 90s, dusty boom-bap drums, warm Rhodes chords, mellow sub bass, 85 BPM, A minor, nostalgic, mellow, hazy, vinyl crackle, tape saturation, MPC swing`
- **BoN-s101** _(Tag prompt, seed 101 (best-of-N candidate))_
  `lo-fi hip-hop, 90s, dusty boom-bap drums, warm Rhodes chords, mellow sub bass, 85 BPM, A minor, nostalgic, mellow, hazy, vinyl crackle, tape saturation, MPC swing`
- **BoN-s256** _(Tag prompt, seed 256 (best-of-N candidate))_
  `lo-fi hip-hop, 90s, dusty boom-bap drums, warm Rhodes chords, mellow sub bass, 85 BPM, A minor, nostalgic, mellow, hazy, vinyl crackle, tape saturation, MPC swing`
- **BoN-s512** _(Tag prompt, seed 512 (best-of-N candidate))_
  `lo-fi hip-hop, 90s, dusty boom-bap drums, warm Rhodes chords, mellow sub bass, 85 BPM, A minor, nostalgic, mellow, hazy, vinyl crackle, tape saturation, MPC swing`
- **HiSteps-16** _(Tag prompt at 16 sampling steps (vs 8))_
  `lo-fi hip-hop, 90s, dusty boom-bap drums, warm Rhodes chords, mellow sub bass, 85 BPM, A minor, nostalgic, mellow, hazy, vinyl crackle, tape saturation, MPC swing`

## Listening index

Staged to `~/Desktop/mosh-genbench/lo-fi-hip-hop-beat-dusty-boom-bap-drums-warm-rhodes-chords-m/` for A/B. Sources (the real audio fed to the a2a renders) are in `eval/genbench/sources/`.

- **prompt**: `P0-terse`, `P1-descriptive`, `P2-tag`, `P3-reference`
- **audio2audio**: `A2A-melody`, `A2A-drums`
- **color**: `C-grit`, `C-air`
- **seed**: `BoN-s7`, `BoN-s101`, `BoN-s256`, `BoN-s512`
- **steps**: `HiSteps-16`
