# a3b-r7-mlx final gate read

Date: 2026-08-20

Model: `Qwen3-30B-A3B-Instruct-2507-4bit` + final `a3b-r7-mlx` adapter

Outcome: **gate MISS** — one clean read, no model-quality retries. Aggregate,
grounded apply, and latency passed; the per-command floor and novice-jam legs
missed.

## Training result and artifact identity

- Completed `13113/13113` steps (one epoch) with final validation loss `0.225`.
- The log spans 2026-08-18 12:13:25 through 2026-08-20 09:53:57 PDT
  (`45h 40m 32s` observed wall-clock, including any machine idle/sleep time).
- Final adapter:
  `/Users/emiliosanchez-harris/Mosh/service/sft/.adapters/a3b-r7-mlx/adapters.safetensors`
  - sha256 `3030789d438c1e42cf7352b3d3d54659d85989dcd59839c655e14736e9e2e146`
  - `adapter_config.json` sha256
    `c2ebc7c12ba477d2cbc01f44142a67b868f87795c22db0ec0e876067138c9788`
  - training log sha256
    `81350a630c03c5e8f95e6536877c38f95d90b4e119a1bdcacea30be4b633dd6a`
- Recipe verified from `adapter_config.json`: rank 16, scale 2, dropout 0.05,
  last 16 layers, attention q/k/v/o only, lr `1e-5`, prompt masking, gradient
  checkpointing, batch 1, one epoch, sequence length 6400.
- Frozen data rechecked immediately before the read:
  - train sha256 `9e8853344d2ac111ae6da5f239b71017b97815f394d6335fae94a9aa4549dbaf`
  - valid sha256 `9047ab96fd7e8f7f2155d6acc9c9b391c7989ed6205d119c46be764dfa4f3638`

## Fuse, serve, and native-binary proof

- Fused into a standalone copy at
  `/Users/emiliosanchez-harris/AI/models/fused/a3b-r7-4bit-final` and served
  that path directly. The direct adapter-serving shortcut was not used.
- Base last-shard sha256:
  `b02f0e9f626bd2f5bb41e057216c9d6f594ddeac91cc3f2161cc935d050a12c6`.
- Fused last-shard sha256:
  `3d3848ff3d083885cdb6b327b7dd12a5a8cf5e51cc951d8ab26765145d6ac78e`.
  The mismatch proves the adapter landed in the served weights.
- `/v1/models` reported the exact fused path as a served model id.
- Grounded/agent reads used the release binary built from takeover commit
  `6e5cac27bfee6986c4381a2b1c9b12df46f36e2c`, sha256
  `6b06a294f26c3c278e6739d31fe242a4ec29c574644364a173b2e3b3d502a6ba`.
  Its headless selftest passed `3279/3279`, zero failures.
- After the read, the stopped server's regenerable 16 GiB fused copy was
  deleted. The final adapter, config, log, and result artifacts were retained;
  the repository preflight returned to PASS with 79 GiB free on Data.

## Frozen evaluation surfaces

Fixture hashes were checked before their respective reads:

- evalA: `d68ec63696ee1e88c2bb39c7ff21ae98e1dca4b60d9b762a680b33ac4019c911`
- frozen300: `1868ed3153ef7a212c72911f26f8aedb94997eb76e1e45f6df822f65ff9d7a2c`
- diag_floor4: `6488483a7518abae6a94c8f51d641e792f3dd90e644cda44456b193d4b989882`
- grounded §B script:
  `f415b1f41047d84b65a23c66d370dfaff5e9fccdf3f5da9b45a60a431c09bc27`
- novice-jam tasks:
  `e2a4946637b89e053e09701ead84ea9ac09f122126f4f7015d0c5ed4898208c9`
- acceptability rubric:
  `4b4fa088294e76cb61a41a5726480558d1d5e536c525a41d334c5146a42eac9c`

### evalA (210-row core)

- Tag: `a3b-r7-final-A`
- Clean apply: `0.84246` (15 deferrals / 210)
- Floor misses: `add_note 0.000` (n=6), `set_render_param 0.000` (n=1),
  `undo 0.000` (n=6), `build_skeleton_from_clip 0.400` (n=5), and
  `suggest_next_line 0.400` (n=5).
- At floor: `redo 0.500` (n=4), `sketch_beatbox 0.500` (n=2).
- Report:
  `~/Library/Mosh/work/gate/rerun-evals/eval_results.a3b-r7-final-A.json`

### frozen300

- Tag: `a3b-r7-final-C`
- Clean apply: `0.68958` (20 deferrals / 300)
- Report:
  `~/Library/Mosh/work/gate/rerun-evals/eval_results.a3b-r7-final-C.json`

### diag_floor4

- Tag: `a3b-r7-final-diagfloor4`
- Clean apply: `0.49123` (8 deferrals / 19)
- `split_clip 0.833` (n=6) passed its diagnostic floor.
- Other diagnostics confirmed `set_render_param 0.000`, `redo 0.250`, and
  `undo 0.333`.
- Report:
  `~/Library/Mosh/work/gate/rerun-evals/eval_results.a3b-r7-final-diagfloor4.json`

### Grounded §B

- Positive clean apply: `33/37 = 0.8919` — **passes** the 0.85 bar.
- Negative defer: `10/20 = 0.50`; wrong-defer count `11`.
- Classes: validation 3, apply-error 6, invented-file 3; no parse errors.
- Report:
  `~/mosh-bench-artifacts/eval-v2/sectionB._Users_emiliosanchez-harris_AI_models_fused_a3b-r7-4bit-final.default.json`

### Latency

- Tag: `a3b-r7-final`; 30/30 replies were JSON-valid.
- Cold first request: `7.754s`; warm median: `1.854s`; warm p75: `2.012s`;
  warm max: `5.590s`.
- Report:
  `~/Library/Mosh/work/gate/rerun-evals/latency.a3b-r7-final.json`

## Single clean novice-jam read

- Tag: `p3-novice-jam-a3b-r7-final-cal2`
- Goal success: `12/25 = 48%`.
- Acceptable: **`8/25 = 32%`**, below the registered `16/25` gate.
- 36 model calls; no task rerun. Wrong defers: 2; ambiguous defer correctness:
  `2/4`.

| category | goal success | acceptable |
|---|---:|---:|
| mix | 2/5 | 1/5 |
| arrange | 3/5 | 2/5 |
| compose-drums | 0/2 | 0/2 |
| compose-melody | 1/2 | 1/2 |
| master | 2/2 | 2/2 |
| generative | 1/1 | 0/1 |
| lyrics | 1/2 | 0/2 |
| repair | 0/2 | 0/2 |
| ambiguous | 2/4 | 2/4 |

Named cases:

- `nj-drums-groove`: miss. It created a track, then `load_drum_kit` failed
  with `no track`; no `add_drum_pattern`, zero notes.
- `nj-hats-more`: miss. It listed kits, then tried nonexistent kit `default`;
  no new track or `add_drum_pattern`.
- `nj-amb-empty-middle`: miss. It should have deferred but emitted six
  commands; `create_section` and four notes applied before a malformed drum
  pattern failed.
- Lyrics: `nj-write-some-words` met its goal but was unacceptable because a
  follow-up constraint command failed validation; `nj-first-line-lyrics`
  retried sheet creation instead of using `set_lyric_line`. Both are
  unacceptable under the calibrated rubric.

Tracked scoreboard:
`docs/agent-bench/scoreboard.p3-novice-jam-a3b-r7-final-cal2.{json,md}`.

## Gate decision and disposition

- Standing aggregate is the registered mean of the two surface scores:
  `(0.84246 + 0.68958) / 2 = 0.76602` — **passes** (≥0.75).
- Grounded §B `0.8919` — **passes** (≥0.85).
- Per-command floors — **miss**.
- Novice-jam acceptable `8/25` — **miss** (required ≥16/25).
- Latency — **passes** the r8 comparison ceiling by a wide margin.

The run is complete and reproducible, but r7 is not the new shipping adapter.
Keep r5 as the incumbent. For r8, final r7's comparison baseline is 8 acceptable
tasks; the independently registered frontier floor still requires at least
13/25, so a smaller leg must reach 13/25 (and ≤10s median) to pass.

## Harness deviation discovered before the read

The first eval command failed before making a model call because two recently
added dev/e2e query fixtures in `bridge.mock.ts` dereferenced `window` at module
scope. This did not consume the one clean model read. The takeover branch adds
a raw-Node import regression test and one shared guarded query parser. After the
fix, that test plus eight related bridge tests passed, and a 19-prompt CLI dump
proved the eval import path before the scored calls began.
