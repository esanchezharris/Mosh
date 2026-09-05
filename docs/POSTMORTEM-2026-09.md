# Postmortem: March–August 2026 — why quality never shipped, and the contract that fixes it

Written 2026-09-01 from a five-agent forensic sweep over both machines (timeline,
Mosh-agent audit, render provenance, PC handoff docs, tutorial-pipeline autopsy).
Owner-approved. This document is the "don't go down the same path again" artifact.
It is deliberately blunt.

## The one-sentence finding

The make → render → **listen → correct-in-DAW → promote lesson to prompt** loop —
the only process that has ever produced beats the owner loved — ran exactly once,
on **2026-03-19**, and never again through the 2026-08-23 pre-pivot freeze; every
quality signal since was answered with infrastructure instead of another round.

## Timeline of incarnations (evidence in the forensic reports)

| When | Incarnation | Fate |
|---|---|---|
| Nov 2025–Apr 2026 | DAWNMonster (REAPER scripts + web UI) | Mined as donor code, never revived |
| **Mar 19** | **AbletonMONSTER flywheel** | **The breakthrough: 6 gen rounds + 4 human corrections in ~14h; prompt v1→v2→v3; 78-beat batch** |
| Apr 6–9 | Python-native renderer + v4.1 training (Qwen LoRA SFT) | **Spec 15 ABORT**: 24 blind labels, 1.92/5, would_open 0/24, proxy correlation +0.12; "the student converges to the teacher" |
| Apr 10–30 | MonsterDAWW PC (Tauri/JUCE) + "New project 3" + No Computer runtime | Three parallel platform builds; "Human labels are still empty"; Apr 25 handoff bundle shipped with all six gate tests red |
| May 4–14 | MonsterDAWW Mac | Two real listening passes (2.0/5, then ~2–3/5); tutorial-repro pipeline built, 1/66 tutorials processed; parked May 19 mid-iteration |
| May 13–16 | web-plugins → Mosh v1 (browser arena) | Reframed ~every 2 weeks: arena → native solo → recording-first |
| Jun 8–Aug 23 | Mosh v2 (greenfield, ~/Mosh, Tracktion) | 1,246 commits; superb engineering; FMS refuted by ear and paused; taste archive ended with **1 organic label**; froze as `pre-pivot-baseline-2026-08-23` with every by-ear acceptance still pending |

Seven re-platformings in five months. The last human correction artifact anywhere:
`gen002_fix.meta.json`, 2026-03-19 11:05 AM (PC, `E:\AbletonMONSTER`).

## The recurring mistake, in its six costumes

1. **Quality signals answered with infrastructure.** Apr 9's 24 labels came with
   dictated fixes; the spec's next step was "turn the labels into a manual_fix
   corpus." Instead a new DAW workspace started the next day. Apr 27: "Human labels
   are still empty" → runtime rewrite. May 8: "product-complete" declared by cron
   with zero musical criteria.
2. **Four label systems built, none fed:** v4.1 ManualFixRecord (empty), Capture OS
   (dry run never happened), Monster Ear (unpushed branch), Mosh taste archive
   (1 organic label). March 19 needed only a folder and a meta.json convention.
3. **Proxy metrics readopted in new costumes** after Spec 15 proved them noise:
   structural gates, green-check counts, conformance scoreboards, frozen SFT
   benchmarks. The ear kept appearing as a *verdict*, never again as a *teacher*.
4. **Methodology preconditions skipped.** "No catalog, no loop" — the Apr 29
   synthwave restart required owner-made seed sessions; none were ever made, so
   round 1 never ran.
5. **Scale and training before calibration.** "210 beats/hour" was celebrated; the
   SFT corpus was never human-rated; the student converged to a 2/5 teacher.
6. **Platform churn destroyed loop continuity.** Code and specs survived each
   reset; the running correction thread — the load-bearing artifact — did not.

## Why the Mosh agent's beats are placeholder-grade (2026-08-31 audit)

Ranked causes, all structural, none about model intelligence:
1. **Sound source**: the agent can only reach a sine-synthesized 8-pad kit and a
   default-state 4OSC. No preset concept exists on the command seam; no sample
   catalog is agent-visible; the one curated system (`generate_beat_recipe` +
   palette-v1 + the owner groove library) is fenced out of the agent catalog over
   the synchronous `execute_command` UI-thread constraint.
2. **No taste in the prompt**: no reference beats, no per-track instrument
   visibility in the session render, worked examples unshipped, 2KB memory budget.
3. **Dosage doctrine + budgets**: "smallest command set", 8 steps / 180 s /
   800-token completions / "4-8 notes" guidance — an assistant for bounded edits,
   not a producer.

Reference exhibit: `release-f0a3f525-final.wav` — a 93.75% hand-scripted 3-track
demo scaffold to which the agent contributed 8 stepwise eighth notes, with rhythm,
velocity, and register hard-coded by guardrails.

## The quality-loop contract (standing rules, owner-approved 2026-09-01)

1. **≥1 human correction round per week through the product surface.** A fix
   without a written lesson (meta.json: rating + one-line notes) does not count.
2. **No new label/telemetry infrastructure until the existing one holds ≥25 real
   labels.** Four unfed systems already exist; feed one before building a fifth.
3. **Proxy metrics never gate musical decisions.** Ear verdicts only. Automated
   gates remain for code correctness.
4. **No re-platforming or greenfield rewrites** without a written postmortem of the
   current platform, a 1-week cooling period, and explicit owner sign-off.
5. **One genre at a time** reaches "keeper" before the next starts.
6. **METHODOLOGY.md non-negotiables** (catalog first; mandatory meta; lesson→rule
   with provenance; corrected output as next-round reference; 6-round cap) govern
   every loop, in every surface.

## The approved direction (summary; full plan in the owner's plan file 2026-09-01)

One loop, two surfaces, no re-platforming. ~/Mosh remains the platform. The
Ableton flywheel lab (`~/AbletonMONSTER`, revived 2026-08-31, gen001 = keeper)
runs weekly rounds **until** Mosh's new produce lane passes an ear A/B against it
on the same ask — then the lab retires. Phase 1 (trap): real sounds on the agent
seam (un-fence recipes/palette, preset commands, agent-visible drum catalog,
rights-clean palette-v2 via SA3 one-shots + Vital patch bank) + the flywheel
pillars at the agent seam (instrument-visible session render, genre templates,
reference-DSL few-shot, a produce lane with frontier-model budgets, correction
capture from mosh-log diffs promoted by a human). Composition modes ship as one
per-role source matrix (MIDI+real-sound ↔ SA3 audio per role); frontier now,
distill later (train only on ear-rated corpus); First-Stranger revives only after
the keeper bar is met in Mosh — inverting the old order.
