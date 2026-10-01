# "Mosh Clean Lead v0" — validation report (2026-10-01)

Companion to [AUDIT-2026-10-01.md](AUDIT-2026-10-01.md). Three statuses, kept apart because a
pass on one says nothing about the others:

| Status | Verdict |
|---|---|
| **Engineering** | **Passed** on this Mac, headless, at the commit in §1. Evidence in §2–§7. |
| **Listening** | **NOT RUN.** Render pairs are prepared (§8). No one has listened. |
| **Release** | **Internal candidate.** Not release-ready: listening approval, live-monitoring acceptance and an installed-app check have not happened. |

Passing tests and synthetic signals show the chain is built and applied correctly. They do not
show that it sounds good on a voice.

## 1. What was verified, and where

| Field | Value |
|---|---|
| Code under test | branch `claude/mosh-vocal-presets-2e6055`, local commit `e434294c` (not pushed), on top of baseline `e9f7182e` |
| Build | Release, `macos-arm64-release-app` / `-tests`, from that commit with a clean tree |
| Machine | this Mac (arm64), `MOSH_NO_AUDIO=1` — no audio device, no microphone, no plugin host |
| Baseline for comparison | [AUDIT §1](AUDIT-2026-10-01.md#1-baseline-checks-before-any-change): selftest 3767/3767, MoshTests 504 cases |

This report was added in a later docs-only commit; §9 records the final gate run.

## 2. The preset as shipped in the tree

`resources/presets/track-chain/mosh-clean-lead-v0.json` — schema 1, id `mosh.clean-lead`,
revision 0. Two stages, dry, no EQ, no ambience, no saturation, no makeup gain.

| # | Processor | Setting (as written in the file) | What the engine stores | Engine's own display |
|---|---|---|---|---|
| 1 | `lowpass`, state `mode = "highpass"` | frequency 80 Hz | 80.0 | `80 Hz` |
| 2 | `compressor`, state `sidechainTrigger = false` | threshold −24 dB | linear gain 0.063096 | `-24.00 dB` |
| | | ratio 2.5 : 1 | slope 0.400000 | `2.50 : 1` |
| | | attack 20 ms | 20.0 | `20.0 ms` |
| | | release 150 ms | 150.0 | `150.0 ms` |
| | | output gain 0 dB | 0.0 | `+0.00 dB` |
| | | input (sidechain) gain 0 dB | 0.0 | `+0.00 dB` |

The right-hand columns are the selftest's readback from the live plugins after
`apply_track_preset`, not the requested values.

**Why these numbers.** 80 Hz was the proposed audition seed and is kept as one: it is a
−3 dB corner with a 12 dB/octave slope, so it trims rumble without reaching most voices'
fundamentals. The compressor values were chosen after measuring the processor (§4), not
before: a low ratio, an attack slow enough that the gain does not ride individual pitch
periods, a release short enough to recover between phrases, and no output gain, so the preset
never adds level. On the one real lead vocal available (§8) this gives about 2.4 LU of
level reduction at the recording's own level, 0.2 LU when the same recording is 6 dB
quieter, and 4.3 LU when it is 6 dB hotter. Whether those are the right numbers is a listening
question this report cannot answer.

## 3. Unit conversion and schema (engine-free)

`build-macos-arm64-release/tests/MoshTests_artefacts/Release/MoshTests "[track-preset]"`
→ **165 assertions in 6 test cases, all passed.** Full suite: 75 988 assertions in 510 cases,
all passed (baseline 504 cases).

Covered: threshold endpoints (0 dB → 1.0, −40 dB → exactly 0.01, −40.1 dB → error, not
clamped); ratio as reciprocal slope (2:1 → 0.5, 20:1 → 0.05, 1/0.95 : 1 → exactly 0.95,
1:1 → error because the parameter cannot represent it, 0 / negative / ∞ / NaN → error);
identity-encoded ranges; and a schema reject table — not JSON, wrong kind, newer schema,
unknown key, missing key, unsupported or unqualified processor, unknown parameter, missing
parameter, wrong or missing unit, a normalized copy beside the canonical value, non-numeric or
out-of-range value, bad typed state, non-boolean bypass. The bundled file is parsed and its
values pinned.

## 4. Measured DSP (direct plugin harness)

`VOCAL-PRESET TABLE` and `VOCAL-PRESET DSP` sections of `--selftest`. Fresh, un-inserted
plugin instances built from the same state the command inserts, driven the way the playback
graph drives them (`baseClassInitialise` → `applyToBufferWithAutomation` per block →
`baseClassDeinitialise`), at **44.1 and 48 kHz × 64 / 128 / 256-sample blocks × mono and
stereo** (12 configurations).

**Table vs engine (32 checks).** Parameter ids, order, count and native ranges of both
processors equal the pinned table; a plugin created from an all-non-default probe preset reads
every value and both pieces of typed state back; `mode = "highpass"` really selects the
high-pass filter; ratio 4:1 is held as slope 0.25 and displayed by the engine as `4.00 : 1`;
both declare zero latency.

**High-pass, 80 Hz** — identical in all four rate/channel configurations:

| Frequency | Measured | 2nd-order Butterworth design | Tolerance |
|---|---|---|---|
| 40 Hz | −12.31 dB | −12.30 dB | ±0.6 |
| 80 Hz | −3.01 dB | −3.01 dB | ±0.35 |
| 160 Hz | −0.26 dB | −0.26 dB | ±0.3 |
| 1 kHz | −0.000 dB | 0 | ±0.2 |

**Compressor static curve**, 1 kHz tone, steady state, compressor alone:

| Tone peak | Relative to threshold | Gain, 48 kHz | Gain, 44.1 kHz |
|---|---|---|---|
| −30.0 dBFS | peak below threshold | 0.00 dB | 0.00 dB |
| −18.0 dBFS | 2× | −1.38 dB | −1.35 dB |
| −5.9 dBFS | 8× | −5.71 dB | −5.71 dB |
| −0.2 dBFS | 15.5× | −6.73 dB | −6.73 dB |

- Gain falls monotonically with level and passes at exactly the output trim below threshold.
- Solving the pinned formula `gain = (th + (L − th)·slope) / L` for the detector level `L`
  gives `L = 0.635 × peak` (48 kHz) and `0.636 × peak` (44.1 kHz) — the rectified mean of a
  sine, 0.637. The same constant then predicts the top step to within 0.01 dB. So the
  compressor is an amplitude-domain compressor on a **mean-level** detector, exactly as the
  source reads, and **it compresses**. This is the measurement that closes the 2026-09-06
  "does not compress" finding (see the audit for why that sweep saw nothing).
- A sine whose *peak* is at the threshold is not compressed: for a sine the knee sits about
  3.9 dB above the labelled threshold.

**Other properties, every configuration.** Silence in gives digital silence out. An impulse
comes out finite and starts at the input sample: no added latency, no pre-ringing. Output is
sample-identical (≤ 1e-6) across 64 / 128 / 256-sample blocks. Mono and stereo agree. On the
stepped tone the output peak does not exceed the input peak.

**CPU, observation only.** Slowest single block through both stages: 0.003–0.006 ms. A
64-sample block at 48 kHz lasts 1.33 ms. No overruns are possible to observe headless; this is
processing cost, not a live-device measurement.

**Latency.** Added processing latency: zero (declared and measured). Hardware round-trip
latency was not measured — there is no device in this run.

## 5. The command (`apply_track_preset`)

`--selftest`: **4068/4068 checks passed** (baseline 3767 + 301 new), three consecutive runs
recorded in §9. `--selftest-undo`: 30/30.

| Requirement | Evidence (section of `VocalPresetSelfTest.cpp`) |
|---|---|
| All stages instantiate; values read back from the live plugins in the preset's units | APPLY — result readback, live parameters (`getCurrentValue`), typed state, bypass, order |
| One undo step; redo restores chain **and effective values**, including after the plugin objects are purged and re-created | UNDO |
| Applying twice does not duplicate | REAPPLY — untouched group → `changed:false`, and the next undo reverts the *earlier* edit, proving no transaction was opened |
| Only the preset's own group is replaced | REAPPLY — tweaked group reset, one undo returns the tweak exactly; a partial group is completed, not doubled; the user's EQ is unchanged |
| Other tracks, sends, fader, automation untouched | ISOLATION — first track's snapshot byte-identical; second track's fader level, send, user plugin and automation unchanged |
| Chain sits ahead of sends and fader | ISOLATION (fader and send already present) and RENDER (fader created later lands after the chain) |
| Failures mutate nothing | REFUSALS — 16 cases, each checked for refusal, reason, and canonical-snapshot equality |
| No empty transaction on refusal; a pending redo survives | REFUSALS — real edit → refusal → undo reverts the real edit; refusal while redo pending → redo still works |
| Injected failure leaves no partial chain or damaged history | FAULTS — both fault points, outside and inside a batch, and during a replace |
| Save / reload | PERSIST — see §6 |
| Dry recordings untouched | DRY AUDIO — SHA-256 of the original file and the session's imported copy; clip timing and source reference; the preset file itself |

Refusals covered: missing `trackId`; unknown track; instrument track; drum track; return
track; frozen track; while recording; missing file; relative path; not JSON; an instrument
patch offered as a track preset; newer schema; unsupported processor; unsupported typed state;
unknown key; no room on the track (16-plugin engine limit). Also: `load_preset` given a
track-chain file refuses it by name.

**Recording.** Applying while recording is refused with "cannot apply a preset while recording
— stop recording first". A headless run has no device and cannot start a real recording, so
the guard's input is forced through a selftest-only seam; the guard code is the real one. It
was not exercised against a rolling record on hardware.

**End-to-end render** (RENDER section). A stepped tone imported as a clip, exported dry and
again after applying the preset, 48 kHz / 512-sample blocks: step gains −0.000 / −1.38 /
−5.71 / −6.73 dB — the same curve as the direct harness. Pulling the track fader down 12 dB
shifts every step by exactly 12 dB, so the gain reduction is unchanged: the chain is pre-fader.
A 44.1 kHz render of the same track matches the 48 kHz one on the top step (0.00 dB apart).

## 6. Persistence — three kinds of equality, reported separately

| Kind | Same process (`save` → `reload`) | Fresh process (`scripts/vocal-preset/verify.py reopen`) |
|---|---|---|
| **Serialized** | The saved edit carries `moshPresetId` on every preset plugin (count on disk = count live), `mode="highpass"`, and the preset name | Project file written by process 1 is opened by path in process 2 |
| **Effective** | Plugins rebuilt from the file hold the preset's values (parameters the DSP reads); the track's snapshot is identical; re-applying is still a no-op | Stage order, values, display strings, bypass, ownership tags and the target track id identical; re-applying is a no-op; still exactly two rows |
| **Rendered** | Peak residual between pre-save and post-reload exports: **−240 dBFS** (bit-identical; tolerance −90) | Peak residual between the two processes' exports: **−240 dBFS** (tolerance −90) |

`verify.py reopen`: **14/14 checks passed.** Byte equality of the render was not demanded; a
−90 dBFS residual tolerance was. The renders happen to be bit-identical.

## 7. Could these tests fail? (RED proofs)

Run once and discarded; nothing below is in the tree.

- **DSP.** The selftest was run against a deliberately weak preset (ratio 1.06:1) through
  `MOSH_PRESETS_DIR`: 18 checks failed, including "the compressor measurably compresses"
  (−0.45 dB) in all four configurations.
- **Command.** A temporary build disabled five things at once — the rollback, the pre-fader
  placement, the no-op detection, the recording guard and the capacity check. 18 checks failed
  and each sabotage was caught by the check written for it (both fault points, the in-batch
  rollback, the failed-replace restore, placement ahead of fader and send, `changed:false`,
  "while recording", "no room"). The temporary commit was reset and no marker remains.

## 8. Listening material — prepared, not auditioned

`scripts/vocal-preset/verify.py audition`, sources read-only from
`~/Library/Mosh/references/songs/greg/source/` (`mixpackage.json`: the owner's own song;
consent recorded there as "local probe only; never committed or uploaded"). SHA-256 of every
source verified identical before and after. Output: `~/Library/Mosh/task-evidence/vocal-preset-20261001/audition/` (outside the
repository; nothing uploaded; 27 WAVs + `audition-report.json`).

**Method.** Each source is imported into a throwaway session and exported dry, then exported
again after `apply_track_preset`. Input level is varied with clip gain in the session (−6, 0,
+6 dB); no source file is rewritten. Each `*_processed_matched.wav` is the processed render
with one static gain so its integrated loudness (ITU-R BS.1770, ffmpeg `ebur128`) equals the
dry render's; the gain is applied to the render copy.

| Source | Input | Dry peak / LUFS | Processed peak / LUFS | Loudness change | Peak change | Match gain |
|---|---|---|---|---|---|---|
| lead | −6 dB | −16.70 / −24.6 | −15.85 / −24.8 | −0.2 LU | **+0.85 dB** | +0.2 dB |
| lead | 0 dB | −10.70 / −18.6 | −10.12 / −21.0 | −2.4 LU | **+0.58 dB** | +2.4 dB |
| lead | +6 dB | −4.70 / −12.6 | −4.73 / −16.9 | −4.3 LU | −0.03 dB | +4.3 dB |
| double | −6 dB | −17.65 / −33.8 | −17.70 / −33.8 | 0.0 LU | −0.05 dB | 0.0 dB |
| double | 0 dB | −11.65 / −27.8 | −13.48 / −27.9 | −0.1 LU | −1.83 dB | +0.1 dB |
| double | +6 dB | −5.65 / −21.8 | −7.75 / −23.2 | −1.4 LU | −2.10 dB | +1.4 dB |
| background | −6 dB | −22.22 / −36.2 | −22.33 / −36.2 | 0.0 LU | −0.11 dB | 0.0 dB |
| background | 0 dB | −16.22 / −30.2 | −16.33 / −30.2 | 0.0 LU | −0.11 dB | 0.0 dB |
| background | +6 dB | −10.22 / −24.2 | −11.38 / −24.8 | −0.6 LU | −1.16 dB | +0.6 dB |

All renders finite. Levels are as exported from a fresh session, whose master sits at −3 dB
(a hazard the package itself records); dry and processed share that path, so the differences
are unaffected.

**What the measurements say — as measurements, not as a verdict on the sound:**

- The preset is **level-dependent**, as any fixed-threshold chain is. It engages on the lead at
  its recorded level and above, and is nearly transparent on quieter material.
- On the lead it **lowers loudness more than it lowers peaks**: the loudest phrases come down
  by a few dB while the single highest sample does not. Whole-file crest factor (peak − RMS)
  therefore *rises* by 1.1 / 2.9 / 4.1 dB at −6 / 0 / +6 dB input. That is consistent with a
  mean-level detector and a 20 ms attack letting onsets through. It also means a
  loudness-matched processed file peaks higher than its dry counterpart.
- The processed peak **exceeded the dry peak** on the lead at −6 and 0 dB input, by 0.85 and
  0.58 dB. No gain stage adds level; a high-pass rotates phase and can move a waveform's peak.
  The preset is not a limiter and does not guarantee peaks at or below the input's.

**Limits of this material.** One song, one performer; the lead is the only stem dense enough
to exercise the compressor. The package records all three stems as printed with the owner's
Ableton **track inserts** ("post-fader track inserts; no returns; no master") — they are
already-processed vocals, **not raw dry recordings**, so this is a chain on top of a chain.
No rap, no deliberately sibilant fixture, and no recording made through Mosh's own input path
is available. Human listening session: **NOT RUN.**

## 9. Gates

| Check | Command | Result |
|---|---|---|
| Unit tests | `MoshTests` | 75 988 assertions, 510 cases, all passed |
| Native selftest ×3 | `MOSH_NO_AUDIO=1 Mosh --selftest` | see below |
| Undo selftest | `Mosh --selftest-undo` | 30/30 |
| Reopen in a fresh process | `scripts/vocal-preset/verify.py reopen --bin …` | 14/14 |
| UI typecheck | `npm run typecheck` | rc 0 |
| UI unit tests | `npm test` | see below |
| UI e2e, V3 plugins | `npx playwright test -c playwright.isolated.config.ts e2e/v3-plugins.spec.ts` | 2/2 |
| Command coverage | `scripts/daw-conformance/coverage_check.py` | 284 commands, 265 covered, 19 waived, 0 uncovered |
| Scoreboard | `scripts/daw-conformance/scoreboard.py --check` | fresh (regenerated: 265 / 284) |
| Canonical gate | `scripts/auto-loop/gate.sh native <worktree> origin/main` | see below |

GATE_RESULTS_PLACEHOLDER

## 10. Not verified

- **Listening approval** — not run. The preset is an internal candidate until someone listens.
- **Live input monitoring** through the chain, **hardware round-trip latency**, CPU and
  overruns on a real device — no device in any run here.
- **Applying while actually recording** on hardware — only the guard's logic was exercised.
- **Applying during real playback** — the graph-change path is the one `load_builtin` already
  uses, but headless runs have no playback context, so continuity was not observed.
- **Installed-app behaviour** — everything ran from the build tree.
- **Other shells** (Pro Tools, Live, v2, classic) — the entry point is in the V3 inspector only.
  The command and the snapshot field are shell-independent.
- **Multiplayer** — per-track plugin commands are not broadcast to peers today; a preset
  applied on one machine is not replicated. Pre-existing, unchanged.
- **Standalone / plugin targets** — only the `Mosh` app hosts track inserts; there is no other
  target to check a track preset against. Not a pass, not applicable.
- **Third-party preset evaluation** — not run; see [CREATOR-INQUIRY-DRAFT.md](CREATOR-INQUIRY-DRAFT.md).

## 11. Known limitations of the slice

- The V3 inspector's parameter slider is linear across 10–22 000 Hz with a 0.01 step (about
  220 Hz). The high-pass row *displays* 80 Hz correctly, but nudging it jumps far. Undo or
  re-applying the preset restores it. A frequency control that can be set precisely is
  follow-on work.
- The preset label on a rack row says where the plugin came from. It stays after the user
  edits a value.
- Re-applying over an edited chain replaces the preset's own plugins, so automation the user
  drew on *those* plugins goes with them (one undo brings it back).
- The compressor has no knee, no mix and no sidechain filter; the preset invents none.
