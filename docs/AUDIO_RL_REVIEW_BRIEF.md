# Mosh Audio-Taste RL — Design Review Brief

> **You are a fresh reviewer with no prior context.** This document briefs you on a multi-month
> effort to train a music-making agent against a *learned audio-taste reward*, summarizes what we
> built and what we just discovered, and asks you to **sanity-check the whole approach** — are we
> losing the forest for the trees? The specific questions are at the end (§8). Be skeptical; we'd
> rather hear "the premise is shaky because X" than encouragement. Push back on the framing, not
> just the details.

---

## 1. What Mosh is

Mosh is a native macOS **DAW** (digital audio workstation — like Ableton/FL Studio) with an AI agent
living inside it called **Moshi**. The user talks to Moshi ("make the drums harder", "add a dark
melody"); Moshi replies with a compact JSON object — an emotional `intent` + an optional `say` +
a list of **commands** — and those commands mutate the session (create tracks, add MIDI clips with
notes, load plugins, set tempo, render, etc.). There are ~63 commands. Every user-visible change is
one of these commands (the "one mutation path"). Today Moshi's brain is a cloud LLM; the project
below is about training a **local** policy to be that brain — and to be *good at making music*, not
just at executing commands.

## 2. The goal & the core bet

**Goal:** a local agent that, given a request, emits DAW commands that produce *good music*.

**The core bet (the project's own framing, quoted):**

> The crux it's built to solve — **production quality ≠ musical taste.** Off-the-shelf audio reward
> models (Audiobox, raw CLAP/MERT) have *the ears of a mastering engineer, not an A&R*: they read the
> production *surface* (clean? full-spectrum? loudness-sane? artifact-free?) — real and learnable —
> but are **structurally blind to the musical idea** (interesting vs clichéd chords, melodic shape,
> groove, development). The resolution: **don't measure taste, demonstrate it** — reward proximity to
> a *distribution of real music we consider good.*

So the plan is **RL** (GRPO) on the command-emitting policy, with a **reward = production-quality
floor × musical-taste pull**, where "taste" is operationalized as *proximity to a curated set of
good-music exemplars* in a learned embedding space.

## 3. The original spec & roadmap

A 15-part spec (`docs/superpowers/specs/2026-06-27-teardown-reward-pipeline-design.md`). In one
paragraph (quoted):

> Find tutorials that show their work → tear each into a structured **Recipe** → reconstruct it as a
> real Edit (which extracts your *own* drum samples and matches the synths) → the reconstructions
> become a labeled **anchor corpus** → an **ablation engine** turns that corpus into paired data that
> isolates *musical* choices from production surface → a **learned similarity/reward head** trained on
> that data → which becomes the **"pull" reward in a GRPO loop** that tunes the command-emitting agent
> to produce music that sounds good. *That last agent is the one the whole project was for.*

Sections: §0 Recipe schema · §1 drum-sample matcher · §2 vision detectors · §3 tutorial sourcing
(by predicted "recipe yield") · §4 video→skeleton · §5 MIDI-from-screen · §5b synth-GUI patch reader
· §6 render-and-compare oracle · §7 audio separation/extraction · §8 synth patch-match (CMA-ES) · §9
render (Recipe→commands) · §10 orchestrator · **§11 training flywheel (anchors→ablation→reward head)**
· **§12 reward→RL bridge** · §13 build order · **§14 honest risk register**. §0–§10 are built and
deterministically tested; §11/§12 are the reward; the **GRPO consumption loop is a separate trainer**
that imports the reward.

**§11 keystone — the make-or-break test (quoted):**

> on held-out anchors, the trained head preserves the ablation engine's *known* ordering (original vs
> one-swap vs two-swap) **better than raw CLAP** … Hold out by *source video*, not by clip — the real
> risk is overfitting to anchors rather than recognizing novel good music.

**§12 reward:** `composite = clean · (0.5·pq/10 + 0.5·pull)` where `clean`∈[0,1] is a graded
production-quality gate (Audiobox PQ flags; broken/silent/clipped → 0), `pq`∈[0,10] is Audiobox
perceptual quality, and `pull`∈[0,1] is the §11 learned head = `α·timbre-proximity(raw-MuQ) +
(1−α)·timing-proximity(learned φ-projection)` to **21 real trap/lofi project-groove exemplars**,
α=0.5. Loudness-normalized before scoring (so "get louder" can't hack it).

**The agent & training rungs:** policy = `Qwen3-4B-Instruct-4bit` + LoRA, emitting Moshi's
`{intent, commands}` JSON. **Rung-0 SFT** on slices of real DAW projects (utterance → gold commands).
**Rung-1 GRPO** with a deterministic *clean-apply* reward (does the emitted command sequence apply
without error + match the gold command names) — proves the RL machinery, no audio. **Rung-2 GRPO**
swaps the reward (one env var, `MOSH_RL_REWARD=audio`) to: render each rollout to a WAV via the native
engine → score with the §12 reward. The trainer is reused verbatim; only the reward implementation
changes.

## 4. What we built and validated (the reward, §11/§12)

The §11 keystone was hard-won and **honestly negative for a long time**:
- A diagonal-weight head on a frozen encoder **lost** to raw CLAP (it was structurally inert).
- The same on a "musical" (timing) axis **also lost**.
- **Fix that worked:** grow the anchor corpus with **544 synthetic grooves** (procedural, library
  samples), train a **LoRA fine-tune of MuQ** (an SSL audio encoder) on triplets, **held out by source
  video**. Result on isolated micro-timing: LoRA **0.90 vs raw CLAP 0.55** (Δ+0.35, source-clustered
  CI excludes 0, replicated, artifact-controlled by an adversarial review). Timbre needs no training
  (raw MuQ 0.93 > CLAP 0.87). In-mix groove validated ~0.25–0.34 above a trivial-energy floor.
- A **critical bug** was caught mid-way: every prior "raw-CLAP" number used CLAP's HTSAT feature map,
  not its pooled embedding — invalidated and re-run. (Lesson: we've repeatedly caught our own false
  positives; assume more lurk.)
- **§12 activated:** `composite_reward.pt` bakes the 21 exemplars; the pull discriminates (real mix
  1.00 > off-style synth 0.69 > noise/silence ~0.5). Wired into a `make_reward()` seam the trainer
  imports.

Net §11/§12 claim (scoped honestly): *the composite [raw-MuQ timbre + learned timing] beats raw CLAP
at preserving ablation ordering, held-out-by-source, on timbre + isolated-timing + in-mix-timing.*
This is the "escape from CLAP-bootstrapping" the spec wanted — **as a relative ablation-ordering
metric.** Its quality as an *absolute* reward for an optimizer is exactly what's now in question.

## 5. This session — wiring the reward to the live GRPO loop, and what we found

We connected the activated reward to the real GRPO trainer and tried to get a learning signal. The
arc (all verified, committed, pushed):

1. **The render path is real** — `Oracle.render` shells out to `Mosh --run-script`, checks the exit
   code, hard-fails on an empty WAV, decodes it; the reward only ever scores real rendered samples.
   No fake/stub path. (We checked because an early run had reward 0 everywhere.)
2. **First attempt: reward 0 everywhere.** Root cause: the existing RL prompts were *single
   micro-edits* ("set the tempo to 142") → the policy emits one command → +export → an **empty edit →
   silence → reward 0**, and GRPO zeros a group's gradient when reward variance is ~0. Not a renderer
   bug — a prompt-distribution bug.
3. **Fix: seed renderable rollouts.** New prompt set whose `startCommands` build a **non-silent base**
   (a drum pattern with notes / a test-tone / a melody), so every rollout renders → within-group
   reward variance → a real gradient. Also found+fixed a reward bug: `loudness_normalize` guarded
   clipping to peak ≤ 1.0 while the floor rejects peak > 0.999, so peaky drums were flagged "broken"
   and scored 0.
4. **It produced a non-degenerate gradient** (reward μ 0.21→0.30 over 2 steps, "signal" in every
   group). We initially called this a "musical-taste gradient." **An adversarial review (14 confirmed
   findings) showed that was an over-claim**, and the per-rollout data confirmed it: successful renders
   mostly scored *identically* (e.g. all 0.437). The within-group variance ("signal") was
   overwhelmingly **emit-a-renderable-program (≈0.44) vs fail/defer (0)** — i.e. *renderability*, not
   *edit quality*. The learned `pull` varied only 0.52–0.58 (≈3% of the reward spread); cleanliness/PQ
   dominated. And "edit-on-top" let the policy **bank the seed's reward** by doing nothing.
5. **The principled fix: delta-reward** = `composite(seed+edit) − composite(seed)`. Banking the seed →
   ~0; only a genuine improvement → +, breakage → −. Implemented (the seed renders once/prompt, cached
   by fingerprint), unit-tested.
6. **Delta-reward revealed the real bottleneck (the key finding).** On a delta smoke, deltas were
   **mostly exactly 0** (the policy's edit renders the *same* composite as the seed = a no-op),
   occasionally **negative** (the edit broke the seed), and **never positive** — no rollout improved
   the seed. So the reward is now *correct*, but **this policy almost never produces an audible
   improvement the reward can reward.** Two compounding causes:
   - **Policy capability:** "add a melody on a new track" needs `create_track`+`add_midi_clip`+*notes*
     (multi-step with content). A single-edit SFT policy rarely produces it.
   - **Reward-able-edit mismatch:** the simple edits the policy *can* make (a bare 4OSC synth tone,
     a test tone) don't sound trap/lofi, so they don't raise the trap-exemplar `pull` even when they
     genuinely add audio.
7. **(c) build-from-scratch trial** (empty seed, "make a trap beat / lofi loop", absolute composite
   reward, 2 steps): **decisively worse — zero signal.** Both steps: reward μ=0.000, signal 0/4,
   **75–85% of rollouts DEFERRED** (the policy emitted *no commands* — it doesn't know how to build a
   whole beat from "make a trap beat"), and **every** non-deferred attempt **render-failed** (0
   rendered across both steps). So build-from-scratch doesn't sidestep the bottleneck — it *amplifies*
   it: the single-edit policy can't build, so there's nothing to render, let alone reward. This is a
   clean confirmation that the limiter is the **policy's capability**, not the reward or the framing.

## 6. Honest current state

- **Proven:** the full machinery works end-to-end (prompts → policy rollouts → native render → §12
  reward → GRPO advantages → policy update), deterministically. The §11 reward beats raw CLAP on
  ablation ordering held-out-by-source. The render path and reward are correct.
- **NOT proven / not achieved:** a *trainable musical-taste gradient*. With the current policy + edit
  space + reward, there are essentially no positive exemplars for GRPO to reinforce. The reward is
  ready; the policy (and the achievable-edit ↔ reward-sensitivity overlap) is the bottleneck.
- **The spec's own §14 risk register flagged several of these up front:** "reward generalizes or
  overfits", "diversity collapse", "reward hacking", "~10 s render cap", "full autonomy ambitious".

## 7. Current thinking — the fork we're at

To get a *positive* musical gradient, three paths (we're inclined toward a+b, with a quick c probe):
- **(a) Reward-able edits:** give the policy edits that, when done well, actually move the reward —
  load real drum-kit/instrument samples (so a good edit sounds trap-like and lifts the pull) instead
  of bare synth tones.
- **(b) More capable policy:** few-shot exemplars / more exploration / better SFT on multi-step content
  building, so improving edits get *sampled* (GRPO can only reinforce what the policy occasionally does).
- **(c) Build-from-scratch:** the policy's whole output is the music (composite measures build quality)
  — but the same capability concern applies.

Validation we trust going forward: a **held-out re-score** of the trained adapter vs the SFT baseline
on fixed prompts (greedy), comparing composite + the pull component — *not* a within-training μ delta
(which is noisy on tiny batches).

## 8. Questions for you (the point of this doc)

Please be a skeptic. We want to know if we're solving the right problem the right way.

1. **Is the core bet sound?** "Don't measure taste, demonstrate it — reward proximity to good-music
   exemplars." Is reward-by-exemplar-proximity a real signal for *musical taste*, or does a capable
   optimizer just learn to **imitate the 21 exemplars' surface statistics** (and collapse diversity)?
   Where does proximity-to-good-music break as an objective?

2. **Is RL-on-an-LLM-command-policy the right vehicle at all?** We're using GRPO to train an LLM that
   emits DAW commands, rewarded by rendered-audio quality. Given the bottleneck we hit (the policy's
   action space barely overlaps with the reward's sensitivity), is this the right formulation — or
   would (i) plain SFT/imitation on a large corpus of good human DAW projects, (ii) program search /
   evolutionary optimization over command sequences, or (iii) a generative *audio* model with the
   reward as a ranker, get to "good music" faster? What's the marginal value of the RL reward over
   just imitating good human productions?

3. **The action-space ↔ reward mismatch.** The clean finding is: the policy rarely makes an edit that
   the reward rewards. Is that a fundamental design flaw (the policy explores in "command space" while
   the reward lives in "audio space", and the achievable edits don't map to reward-able audio), and
   how would you restructure to make the two overlap?

4. **Reward hacking / Goodhart.** If we *do* get a strong gradient, what are the failure modes of
   `clean·(0.5·pq/10 + 0.5·pull)` under a capable optimizer? (e.g. converge to one exemplar's timbre;
   exploit the loudness-normalized pull; emit "clean but trivial" audio.) Is this composite robust
   enough to optimize hard against, or does it need adversarial/diversity terms first?

5. **Granularity.** The reward scores a ~few-second render. "Good music" is about arrangement,
   development, structure over 30 s–3 min. Is short-clip audio quality even the right *unit* for the
   signal we want, or are we optimizing the wrong timescale?

6. **Is the teardown→anchor→ablation→reward chain worth its complexity?** It's ~14 components to
   produce a reward whose absolute-optimization value is now in doubt. Is there a 10×-simpler path to
   the same goal (a music-making agent) that we're missing by being deep in this machine?

7. **The minimal decisive experiment.** What is the *smallest* experiment that would tell us whether
   this whole approach (learned-taste reward + GRPO on a command policy) can yield a music-quality
   improvement a human would notice — so we can decide to invest or pivot before spending more compute?

8. **Anything we're not even asking** that we should be.

---

*Appendix — where things live (in case you want specifics):* reward `service/teardown/flywheel/`
(`reward.py`, `reward_encoder.py`, `grpo_bridge.py`, `GRPO_HANDOFF.md`); keystone evidence
`service/teardown/VERIFY_REAL.md`; spec `docs/superpowers/specs/2026-06-27-teardown-reward-pipeline-design.md`;
trainer `service/rl/grpo.py`; reward seam `ui/scripts/rl/scoreRolloutsAudio.mts` +
`service/rl/score_audio_cli.py`; prompt builder `ui/scripts/rl/buildRlAudioPrompts.mts`; gate
`service/rl/verify_audio_gradient.py`; policy prompt `ui/src/agent/brainCore.ts`.
