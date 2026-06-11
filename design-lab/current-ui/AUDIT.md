# Current UI — honest audit (the starting point)

*Screenshots: [shot_empty.png](shot_empty.png) · [shot_generative.png](shot_generative.png)
· [shot_consolidated.png](shot_consolidated.png). Source of truth: `ui/src/` (React +
Vite, CSS variables in `ui/src/styles.css`, purple-accent dark theme `#6c5cff` on
`#0e0e11`). This is what Mosh actually looks like today — Wave-2 design work starts
HERE, not from a blank page.*

## What it is

A competent, conventional dev-tool DAW: topbar (logo · transport · timecode · B-5 slot
· Export · theme toggle), a toolbar row of bordered pill buttons (+Track / +Test Tone /
+MIDI · Move / Split / Snap · Zoom± · Undo / Redo · Save / Reload), bar-number ruler,
track headers (name, M/S, volume slider), blue clips with waveform strips and an RL
badge, red playhead line, bottom CHAIN panel (plugin cards: Neural-nam with DRIVE/MIX,
Tier-A badge, Lab, latency), bottom-right GENERATIVE drawer (GRIT/NL sliders, DIRTY
badge, seed, Render/Accept/Reject).

## What's load-bearing (keep — these bones are GOOD)

- **The skeleton maps 1:1 to MoshOps.** Every control is a thin view over a verified
  command. Whatever the skin becomes, this skeleton survives — that's the swappable
  seam doing its job.
- **The information set is right.** Transport+timecode always visible; chain and
  generative as summonable bottom surfaces; clip = name + waveform + lineage badge.
  The *choices of what exists* need almost no change.
- **The empty stage.** Most of the screen is already calm dark space — closer to Flow
  Mode than any commercial DAW ships.
- **The GENERATIVE drawer** is already the Color Rack seed (GRIT/NL sliders + state
  badges + seed). It needs a dialect change, not a redesign.

## Where it violates the brief (the gap)

| symptom | brief violation |
|---|---|
| Purple `#6c5cff` accent, blue clips, red playhead — four accent hues | Palette is exact: INK/LIME/GLOW/BONE/MIST. One lume, not four. |
| 13 bordered pill buttons in a permanent toolbar row | "Surface only what the moment needs" — the cockpit is always-on. This is the *operate* posture, not *perform through*. |
| No command affordance anywhere | Talk-to-Moshi is the PRIMARY interaction and has zero pixels. |
| Undo/Redo buttons but no ledger | Agent actions are invisible-after-the-fact — violates hard constraint #2. |
| REC state: doesn't exist visually; position: red hairline + bar numbers only | The two non-negotiables are solved at dashboard-grade, not at eyes-closed grade. |
| System font everywhere, generic chrome | No display voice, no mono discipline for timecodes. Reads as the "generic dark dashboard" the brief forbids. |
| No Moshi. Anywhere. | The product's entire fiction is absent from its face. |

## The migration thesis (what 008 demonstrates)

**Possession, not replacement.** Keep the skeleton — lanes, clips, chain, generative
drawer, transport — and change the *materials and the resting state*:

1. **Materials:** panels become ink slabs with lume seam-light (field-notes motif 2);
   one accent (lime) carries everything; heavy display for section/track names; tabular
   mono for every number.
2. **Resting state:** toolbar dissolves — actions live in the command line (talk-first)
   and bloom contextually; the stage defaults to near-empty with Moshi resident.
3. **The two non-negotiables, upgraded in place:** REC = ember heat on the creature +
   the room's edges run hot; position = the playhead becomes a peristaltic pulse in the
   lane body + a halo/perimeter lume — while keeping the mono `BAR x.y` for the skeptic.
4. **Constraint #2 productized:** every MoshOps command the agent issues becomes a
   visible, poppable deed (spore ledger), powered by the existing JSONL log.
5. **The drawer dialect:** GENERATIVE becomes the parameter-poetry rack (motif 4) —
   same sliders, new voice; takes land as glass capsules (motif 6).

Cost honesty: this is a reskin + three behaviors (command line, ledger, creature),
not a rebuild. The MoshOps seam means the C++ binary doesn't change at all — the same
swappability we proved at Stage 2.
