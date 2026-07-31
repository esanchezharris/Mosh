# Agentic loop — owner playtest checklist

The `agenticLoop` setting ships **default OFF**. This session is the gate for
flipping it: Settings → Moshi → "Agentic loop (experimental)".

## Setup

1. Flip the flag ON (v2 shell; the loop is auto-disabled in multiplayer).
2. Configure a brain provider or proxy. A packaged app without one reports setup
   failure and performs no steps; the deterministic script exists only in Vite/e2e.

## What to drive (20 minutes)

| try | watching for |
|---|---|
| "build me a lofi sketch" | drawer opens above the composer, plan appears, chips tick, done + auto-collapse; the Moshi face reopens it |
| "mute the vocal" | does NOT enter the loop — stays the instant single-shot path (the router keeps small asks cheap) |
| "set 90 bpm then lay a boom bap groove then tuck the drums" | sequential clauses in one task; watch step chips vs your expectation |
| "make the drums hit harder and widen the keys and clean the low end" | taste work — does the plan feel musical or mechanical? |
| a long creative ask of your own | the real test — phrase it how you'd talk to a collaborator |
| hit **Stop** mid-task | it stops before the next step; "stopped — kept what's done"; ONE undo reverts the partial task |
| **Undo task** after a finish | reverts EVERYTHING the task did in one step |
| ask something only you can answer ("delete the bad one") | it should PARK (needs you), never guess |

## The #1 question (the known hazard)

**Edit something yourself WHILE a task is running** (drag a clip, nudge a
fader). Then undo the task. Your mid-task edit is currently coalesced into the
task's undo unit — it will revert too. Does that feel acceptable ("undo what
just happened") or wrong? The specced fallback (per-step batches + an
interleave-guarded task-undo) trades one-click-undo for edit isolation — your
call decides which ships.

## Also worth noting

- Latency feel: planning pause vs step ticks — where does it drag?
- The say lines + creature beats: too chatty, too quiet?
- Any task where the bench would have said "pass" but it FELT wrong — log it
  in a copy of `SESSION_NOTES_TEMPLATE.md`; that disagreement is bench fuel.

## After

Verdict options: flip the default ON (one-line follow-up) · keep opt-in ·
changes first (list them). Loop transcripts are already archiving locally
(source `agent-loop`) for the future loop-SFT lane either way.
