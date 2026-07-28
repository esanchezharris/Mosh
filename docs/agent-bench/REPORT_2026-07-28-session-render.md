# REPORT 2026-07-28 — unified session renderer (single-shot master/key visibility)

**Change measured:** the two session renderers were collapsed into one
(`ui/src/agent/sessionRender.ts`). The single-shot path previously rendered via
`brainCore::compactSnapshot`, which showed no master state, no key, no tempo map
and no buses. Both paths now use the renderer the loop path already had.

**Verdict in one line:** the targeted fix works decisively (`master-trim`
0/5 → 13/13, p = 0.0001), and the same runs surfaced a probable regression on
`master-glue` (80% → 38.5%, p = 0.031) that should be resolved before this
merges.

---

## Environment

| | |
|---|---|
| seat | `--claude-cli`, `claude-sonnet-5`, temperature 0 |
| binary | `build-macos-arm64-release/…/Mosh` (built 2026-07-18 01:48) |
| flags | `--runner single --no-render` |
| suite | 34 tasks |
| post-change tree | `claude/funny-borg-be3841` @ the Task-5 commit |
| pre-change tree | `ae63eccd` (level with `main`), separate worktree, **same seat and same binary** |

Every repetition used a distinct `--tag` (the bench derives engine session dirs
from the tag), and all runs were **serial** — concurrent real-engine runs contend
for `~/Library/Mosh` state.

---

## 1. Primary result — the three master tasks

10 reps, post-change:

```
master-trim              PPPPPPPPPP  10/10
master-glue              FPPPFFFFPP   5/10
master-eq-before-comp    FFFFFFFFFF   0/10
```

The pre-registered baseline for this comparison was *master-glue 10/10 ·
master-eq-before-comp 8/10 · master-trim 0/10*. **Two thirds of that baseline did
not reproduce**, so rather than report against it, an A/B was run on the
pre-change commit with the seat and binary held constant. That A/B — not the
quoted baseline — is the basis for every claim below.

## 2. The A/B (this is the load-bearing measurement)

Pooling the dedicated master reps with the three full-suite sweeps:

| task | pre-change (`ae63eccd`) | post-change | Fisher one-tailed |
|---|---|---|---|
| `master-trim` | 0/5 (0%) | **13/13 (100%)** | p = 0.0001 (post > pre) |
| `master-eq-before-comp` | 0/5 (0%) | 0/13 (0%) | no difference |
| `master-glue` | 12/15 (80%) | 5/13 (38.5%) | **p = 0.031 (pre > post)** |

### 2.1 `master-trim` — fixed, unambiguously

0/5 → 13/13 with only the renderer changed. Every post-change pass was a single
`set_master_volume`. This is the bug the change set out to fix: the master fader
defaults to −3 dB, the single-shot model could not see it, and "pull the master
down a couple dB" became an absolute guess that graded as moving *up*
(`master volumeDb Δ1.0 not down within [1,6]` — the identical note recorded in
`scoreboard.sonnet-5-single.json` on 2026-07-19).

### 2.2 `master-eq-before-comp` — not a regression, and never passing here

0/5 pre-change, 0/13 post-change. The change neither helped nor hurt it. The
quoted 8/10 baseline does not reproduce on this seat; it should not be used as a
reference point for `--claude-cli` runs.

One real effect hides inside this null result. Pre-change the model guessed
`unknown builtin: eq` (lowercase, 4 of 5); post-change it guesses
`unknown builtin: EQ` (capitalized, 13 of 13). The change **did** shift the guess
toward display-name casing — the prompt now shows `chain:[Compressor]` for this
task, the only one of the three whose setup pre-loads a plugin. It costs nothing
today only because both spellings are wrong: the real id is `4bandEq`.

### 2.3 `master-glue` — probable regression, flagged not dismissed

80% → 38.5%, p = 0.031. Caveats stated plainly:

- **It does not survive multiple-comparison correction.** Three tasks were
  tested; Bonferroni would require p < 0.0167. This is nominally significant, not
  robustly so.
- **An earlier read of this same task said p = 0.128** (pre 12/15 vs post 5/10).
  Adding the three full-suite observations moved it to 0.031. A number this close
  to the threshold is unstable at these sample sizes — treat the *effect size*
  (a halving of the pass rate) and the *mechanism* as the signal, not the p-value.
- Failure mode is `unknown builtin: Compressor` (5 occurrences) plus `no plugin`
  (4) — the latter being follow-up `set_master_plugin_param` calls that fail
  because the load before them failed.

## 3. Root cause of the builtin failures

`MoshOps.cpp:212` defines builtins with **two different strings**:

| `type` (what commands take) | `name` (what the chain renders) |
|---|---|
| `compressor` | `Compressor` |
| `4bandEq` | `4-Band EQ` |

`renderSession` renders `p.name` — the display name. The snapshot's `Plugin` type
carries **both** `name` and `type` (`ui/src/types.ts:300`), so the useful string
is available and discarded. The prompt therefore shows `chain:[Compressor]` to a
model whose next command needs `type: "compressor"`.

Compounding it: nothing in the prompt supplies the builtin vocabulary at all. The
catalog entry reads *"type from list_builtins"* — a call a single-shot model
cannot make. The loop path can call `list_builtins` and recover across steps,
which is why this never surfaced there.

**Why `master-glue` can regress even though its chain is empty:** the exemplar
theory does not explain it — at decision time that task's chain renders
`chain:[empty]`. The likelier mechanism is that a visible master line makes the
model treat the master as a concrete, addressable object and emit a richer
sequence (load *and* configure), enlarging the surface on which the pre-existing
vocabulary gap can bite. This is a hypothesis, not a measured finding.

## 4. Regression sweep — full suite, 3 reps

```
sweep 1: 25/34 = 73.5%
sweep 2: 24/34 = 70.6%
sweep 3: 26/34 = 76.5%
pooled : 75/102 = 73.5%
```

By category (pooled over 3 sweeps):

| category | pooled | | category | pooled |
|---|---|---|---|---|
| ambiguous | 12/12 | | lyrics | 6/6 |
| compose-melody | 12/12 | | generative | 8/9 |
| arrange | 15/18 | | repair | 6/9 |
| mix | 8/15 | | compose-drums | 5/12 |
| master | 3/9 | | | |

**This sweep is underpowered and must not be read as clearing the suite.** Three
repetitions over 34 binary tasks cannot resolve a per-task shift smaller than
roughly one-in-three; a task that quietly went from 90% to 60% would very likely
still show `PPP`. It is a smoke test for gross breakage, and it found none.

For orientation only: the prior single-runner sonnet-5 scoreboard
(`scoreboard.sonnet-5-single.json`, 2026-07-19) also scored 73.5% (25/34). That
run used the **OpenRouter** seat rather than `--claude-cli`, so it is not a
controlled comparison — the matching headline is a coincidence worth no weight.
Within the master category the composition changed rather than the total:
`master-trim` now passes, `master-glue` now fails.

Tasks not passing all three sweeps: `arr-split-dup`, `drums-boombap`,
`drums-new-hats`, `drums-trap-sketch`, `gen-run-render`, `master-eq-before-comp`,
`master-glue`, `mix-balance`, `mix-submix`, `mix-vocal-space`, `rep-move-comp`.
Most are known-hard (`arr-split-dup` is documented as structurally impossible
single-shot); no attempt is made here to attribute them to this change.

## 5. Recommendation

**Do not merge as-is.** The core fix is proven, but shipping it alongside a
probable halving of `master-glue` trades one master task for another.

Suggested follow-up, in order:

1. **Render the builtin `type`, not the display name.** Must be builtin-aware:
   `type` for an external VST3 is `getPluginType()`, a format label, so a blanket
   swap makes real plugins unidentifiable. Something like
   `chain:[compressor, "Pro-Q 3"]` — id for builtins, name for externals.
2. **Put the builtin vocabulary in the prompt.** The deeper gap is that a
   single-shot model is told to get `type` from a call it cannot make. A short
   enumeration in the catalog description or a knowledge card would address
   `master-glue` and `master-eq-before-comp` together, and is the only thing that
   can fix `4bandEq` — no casing change reaches it.
3. **Re-measure both master tasks** after (1) and (2), ≥15 reps per arm.

Note that (1) changes the shared renderer, so it also moves the **loop** path's
output — which the approved spec deliberately froze. That is an owner decision,
not an incidental follow-on.

## 6. Artifacts

- Post-change master reps: `scoreboard.sr-master-r{1..10}.{json,md}`
- Post-change full sweeps: `scoreboard.sr-full-r{1..3}.{json,md}`
- Pre-change A/B: `scoreboard.ab-pre-r{1..5}` and `scoreboard.ab-pre-glue-r{6..15}`,
  written in the throwaway `ae63eccd` worktree and **not** committed here.
- Smoke: `scoreboard.sr-smoke.{json,md}` (n=1, no evidentiary weight).
