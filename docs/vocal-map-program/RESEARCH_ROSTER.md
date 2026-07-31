# Vocal Map Research Roster

**Admission closes:** 2026-08-13

**Stack freezes:** 2026-08-27

**Owner decision required for any roster change before cutoff**

## Deep-evaluation roster

| Capability | Candidates |
| --- | --- |
| Vocal analysis | [GAME](https://github.com/openvpi/GAME); Basic Pitch/FCPE |
| Aligned lyrics | [SongMASS](https://arxiv.org/abs/2012.05168); current constrained FMS; frontier-plus-verifier; DeepRapper; PoetryDiffusion |
| Synthesis/span editing | [SoulX-Singer](https://github.com/Soul-AILab/SoulX-Singer); [YingMusic-Singer-Plus](https://github.com/ASLP-lab/YingMusic-Singer-Plus) |
| Local preview | zero-shot/quantized candidates beginning with the SoulX family |

Feasibility smoke only: demucs-rs and MuScriptor. [AudioSeal](https://github.com/facebookresearch/audioseal)
is the watermark implementation target, not a model candidate. A smoke result
cannot win a production capability without an explicit owner roster amendment
before cutoff.

## Participant and corpus gate

- Three singers total; recruit two additional singers by 2026-08-06.
- Record 30 minutes of separately consented adaptation material per singer.
- Seal 24 evaluation clips, eight per singer.
- Within each singer’s eight clips: balance melodic/rap and free/paired mumble
  cases.
- Store consent, provenance, allowed uses, transformations, hashes, and
  revocation lineage.
- Never train on the sealed evaluation clips.
- Fine-tune only on the adaptation corpus or independently rights-cleared/
  synthetic data.

## Evaluation packet

Each system receives identical, immutable clip and prompt manifests. Record:

- model, adapter, runtime, and artifact hashes;
- capability versions;
- latency, queue time, cost, failure class, and cancellation result;
- Keep / Passable / Reject;
- 1–5 identity, contour/F0, rhythmic emphasis, expressive phrasing,
  lyric-singability, pride, and edit-locality scores;
- before/after phrase-locality checks; and
- license posture and commercial blocker.

Raters are labeled and candidate presentation is blinded where practical.
Evaluation artifacts remain immutable; corrections create a new manifest
revision.

## Freeze rule

Disqualify a stack that loses identity, exact F0/contour, rhythmic emphasis, or
expressive phrasing. Among survivors:

1. maximize Keep rate;
2. maximize pride and edit locality;
3. minimize latency and cost.

A restricted-license system may win the private playtest only with an explicit
commercial blocker. If nothing clears the bar, select the best observed stack
on 2026-08-27 anyway. From 2026-08-28 onward, work is debugging, integration,
and usability iteration, not candidate discovery.
