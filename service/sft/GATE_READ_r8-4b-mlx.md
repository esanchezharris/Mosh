# r8-4b MLX final size-ladder read

Date: 2026-08-23

Model: `Qwen3-4B-Instruct-2507-4bit` + final r8-4b MLX adapter

Outcome: **MISS** — faster than the ceiling and better than r7 on the
novice-jam read, but below the independent 13/25 viability floor and sharply
below r7 on frozen300. Advance to the registered 8B leg.

## Training and artifact identity

- Completed the frozen 13,113-row epoch in registered order. The final
  restart-disabled tail exited 0 at global step 13,113 with validation loss
  `0.253` and train loss `0.038`.
- Final adapter:
  `/Users/emiliosanchez-harris/Mosh/service/sft/.adapters/r8-4b-mlx-cont13000/adapters.safetensors`
  - sha256 `30c1f7f944d7ceb1047531e5ca003bac8d0e2f4fbd9f206c651d36c4404ff9f3`
  - adapter config sha256
    `5b6343816c30ed5051ddc77d060424a8ab4e060a0e59159509902125ff2dbd89`
  - final-tail log sha256
    `ab44c7c549d605f9b2ef758e546d4b68377a36c5a011074ede2292ae3fc76bab`
- Frozen train/valid hashes remained
  `9e8853344d2ac111ae6da5f239b71017b97815f394d6335fae94a9aa4549dbaf`
  and `9047ab96fd7e8f7f2155d6acc9c9b391c7989ed6205d119c46be764dfa4f3638`.

## Fuse, serve, and binary proof

- Fused into `/Users/emiliosanchez-harris/AI/models/fused/r8-4b-final` and
  served that standalone path. Direct adapter serving was not used.
- Base single-shard sha256:
  `2a73c6c248601ab904e035548abd8e6abb65ea27dcb5f342fb0a8910eb44173f`.
- Fused single-shard sha256:
  `7c3adab1c597d054bb7810d6838e0e56504bec0616cc6405f3314359469ac575`.
  The mismatch proves the adapter landed in the served model.
- `/v1/models` reported the exact fused path.
- The novice read used the same explicit takeover binary as final r7, sha256
  `6b06a294f26c3c278e6739d31fe242a4ec29c574644364a173b2e3b3d502a6ba`;
  its fresh headless selftest passed `3279/3279` with zero failures.

## Scored results

### frozen300

- Tag: `r8-4b-final-C`.
- Clean apply: **`0.30458`** with `141/300` deferrals.
- r7 comparison: `0.68958`; delta `-0.38500`.
- Result sha256:
  `c74753e5e5e6d5a30ba6eca24e7e6a173619c23da56641e36f639110f5f682a6`.

### Latency

- Tag: `r8-4b-final`; 30/30 replies JSON-valid.
- Cold first request: `6.967s`; warm median: **`1.389s`**; warm p75:
  `1.710s`; warm max: `2.570s`.
- This passes the registered `<=10s` ceiling and is faster than r7's `1.854s`
  warm median.
- Result sha256:
  `2ad169b2455dcebb62673470eb97af060782e23143e1610961553d752442a432`.

### Single clean novice-jam read

- Tag: `p3-novice-jam-r8-4b-final-cal2`.
- Goal success: `12/25 = 48%`.
- Acceptable: **`11/25 = 44%`**.
- r7 comparison: `8/25`; r8-4b is +3 tasks and therefore inside the r7
  comparison band, but misses the independently binding `>=13/25` floor.
- 28 model calls; no task rerun. Wrong defers: 6; ambiguity defer correctness:
  `4/4`.

| category | goal success | acceptable |
|---|---:|---:|
| mix | 2/5 | 2/5 |
| arrange | 3/5 | 2/5 |
| compose-drums | 0/2 | 0/2 |
| compose-melody | 1/2 | 1/2 |
| master | 0/2 | 0/2 |
| generative | 0/1 | 0/1 |
| lyrics | 0/2 | 0/2 |
| repair | 2/2 | 2/2 |
| ambiguous | 4/4 | 4/4 |

Named cases:

- `nj-drums-groove`: miss. It created/configured an empty track but emitted no
  `add_drum_pattern`; the track had zero notes.
- `nj-hats-more`: miss. It deferred instead of adding hats; no pattern or track
  was created.
- Both lyric tasks missed by deferral: no `create_lyric_sheet` and no
  `set_lyric_line`.
- All four ambiguity cases deferred correctly, including
  `nj-amb-empty-middle`; this is a material improvement over final r7's 2/4.

Tracked scoreboards:
`docs/agent-bench/scoreboard.p3-novice-jam-r8-4b-final-cal2.{json,md}` with
sha256 `30b096181b5ff4f839eadf41e08a5c76e9b54566a5ce1a8106582ae15ad86399`
and `1267594f38d6ab4e63ea15ffe9247e03bd0fcf33c3d0c91630906d4ee22c8609`.

## Decision and deliberate evaluation truncation

- r7 comparison band: **pass** (`11` exceeds r7's `8`; the clause rejects
  legs more than two tasks below r7, not legs that improve on it).
- Latency: **pass** (`1.389s <= 10s`).
- Independent viability floor: **miss** (`11 < 13`).
- Final r8-4b disposition: **MISS; proceed to 8B**.

After frozen300 landed at `0.30458` versus r7's `0.68958`, the owner agreed
that the remaining broad auxiliary surfaces were unnecessary. An evalA process
that had started was stopped before producing a result and is invalid; evalA,
diag_floor4, and grounded section B were not scored. The registered size-ladder
decision still has its two decisive surfaces: one clean novice-jam read and
latency. No scored leg was rerun. The temporary r8 server was stopped after the
decision read; final adapter and result artifacts were retained.
