# UI-REACH closed — 16 → 0, and two commands that were never about a button (2026-07-26)

**PRs:** #455–#458 (wave 2, merged via `integration/uireach-wave2`), **#454** (bounce undo fix, merged
to main first), **#459** (this session's close-out). Branch `claude/midi-editor-ui-ux-cleanup-be52d8`.

`UI_REACH_GAPS` (in [`ui/src/agent/commandClassification.ts`](../../ui/src/agent/commandClassification.ts),
enforced by [`uiReachability.test.ts`](../../ui/src/agent/uiReachability.test.ts)) is a shrink-only
ratchet asserting that every command in the agent catalog is reachable by a **mouse-only** producer
from the shipped v2 shell. It is now **0**, and the assertion is `toBe(0)` rather than
`toBeLessThanOrEqual` — from here the guard's job is to fail the build when the next command ships
without a control.

## The headline finding: a gap entry is a claim about the code, not the code

Nine of the sixteen entries described an **assumption** that turned out to be wrong. This is the
reusable lesson — the list had been read many times and believed each time.

| entry | what the reason said | what the code said |
|---|---|---|
| `list_takes` | needs a takes UI | never a gap — `cmdListTakes` and `clipToVar` run identical engine calls into an identical shape, and the Inspector's Takes tab already read it |
| `move_annotation` | "can be created and edited but not dragged" | v2 rendered **no annotation UI at all**; `AnnotationRuler.tsx` was imported only by classic `Arrange.tsx` |
| `delete_time_range` | "wants an action in the timeline's **range tool**" | there was no range tool — v2 had no time-span selection of any kind |
| `load_drum_kit` | "swapping it needs a kit picker" | exactly one bundled kit, no enumeration command, no kit name in the snapshot. **Nothing to pick between**; it shipped as "Reset kit" |
| `freeze_layer` | a missing control | the command was **inert** (below) |
| `bounce_layer_to_clip` | a missing control | a **no-op relabel** on every reachable path (below) |

## The guard itself had a live false positive

`ui/src/v2/lanes/ClipView.tsx` imports four *presentational* clip renderers (`ClipWave`, `ClipMidi`,
`ClipDrumGrid`, `isDrumClip`) from classic's `ui/src/ui/Arrange.tsx`. The probe walks the module graph
from `AppV2.tsx` and string-searches every file in it — so the whole classic subtree came along, and
`remove_track` plus the three annotation commands read as **reachable** for their entire existence.

**A mouse-only v2 user could not delete a track.** Not a nicety — a basic DAW operation, reported green.

Fixed with a reviewed `CLASSIC_ONLY_MODULES` set (one entry = one path = one written reason) and a
boundary-stopping `moduleGraph(entry, stopAt)`: the excluded module stays in the *walk* (so its own
imports are still reached) but is not *searched*. An anti-vacuity test asserts each declared path
exists, was in the unstopped graph, and that excluding it genuinely shrinks the searched surface — a
typo'd path that excludes nothing must fail, not silently pass.

The ratchet rose **7 → 11** as a documented correction. A probe change is the one legitimate reason
the number moves upward; it is recorded in the ratchet comment beside the shrink history so the next
reader can tell a correction from a regression.

## `freeze_layer` was inert, and its own test was why nobody noticed

It wrote `status="frozen"`. Nothing anywhere read that value — the only other mention in the tree was
`SelfTest.cpp` asserting the label had been written. Meanwhile `reactiveTouch` gates on
`ids::reactive`, which `Ids.h` has declared as the per-layer opt-out **since Phase 3** while no
command ever wrote it. So a "frozen" layer went right on re-rendering on the next edit, spending
exactly the service time the name promises to save. There was also no way back: nothing moved status
off `"frozen"`, so a freeze was permanent for the life of the project.

Fix: `cmdFreezeLayer` also writes `ids::reactive=false`; `cmdUnfreezeLayer` is the thaw; snapshot
carries `reactive` (absent ⇒ true, for existing projects).

**`reactive` is load-bearing, not convenience.** `status` and `reactive` agree until the first param
edit, which overwrites status with `"dirty"` while the layer stays frozen — both true at once. A UI
keyed on `status` silently drops the badge at the first knob turn and claims the layer thawed itself.
RED-proved exactly that: switching the badge to `status` fails two tests, and it was confirmed against
the running app (status → `dirty`, badge held `◉ Frozen`).

`unfreeze_layer` reports `"dirty"`, never `"ready"` — edits made while frozen deliberately skipped
their re-render, so freshness cannot be claimed.

### `--selftest` structurally cannot prove this

`reactiveTouch` returns on `!eng.hasAudio() && !MOSH_REACTIVE_DEBOUNCE_MS` — the hermetic-harness
guard — **before** it reads any of the state it gates on. A headless run cannot distinguish a working
reactive feature from a completely broken one. That is how the command stayed inert.

The real guard is `verify.py`'s **`check_freeze_stops_rerender`**, the inverse of
`check_reactive_rerender`: a live service, `MOSH_REACTIVE_DEBOUNCE_MS=1`, and a count of rendered
files across a frozen edit and a thawed edit. Exactly **2** — 3 means the freeze never held, 1 means
the thaw never re-armed. RED with the `ids::reactive` write removed reads **3**.

## `bounce_layer_to_clip` needed a surface, not a button

A pure relabel on every path a producer could reach: for whole-clip wave (`appliedInPlace`) and the
MIDI/drum beneath-model, `cmdAcceptRender` takes a no-op branch. It does real work **only** for a
section-scoped render — and no shell could create one. `create_render_layer` has accepted
`regionStart`/`regionEnd` since it was written; **nothing ever sent them.**

Wave 2's time-range selection became the source. `ui/src/v2/timeline/sectionRender.ts` resolves a span
to a target, declining a span covering a whole clip (the engine would apply that in place, so calling
it a section would be a lie), a clip that already carries a layer (`create_render_layer` would error),
and a span that misses. Scoped to the **selected** track, since a range selection crosses every lane
by design. The drawer grows a section branch whose Bounce is gated on `isSectionScoped`; Live / A-B /
Reset are withheld there, because all three describe a render that IS the clip's audio.

`isSectionScoped` **compares** the region against the clip rather than checking for its presence: the
snapshot always emits a region (a whole-clip layer reports the clip's own span), so a presence check
would call every layer section-scoped.

Its undo bug was fixed separately in **#454**: the status was written with `nullptr` instead of
`&undoManager()`, so `"bounced"` outlived an undo that deleted the clip it described.

## Mock drift kept blocking honest tests

Four drifts were fixed across the campaign. The worst was here: `bridge.mock.ts` ignored
`regionStart`/`regionEnd` entirely and auto-applied **every** wave render in place, so the sub-region
branch was unrepresentable — any test built on it would have been green against a backend behaviour
that does not exist. It now mirrors `MoshOps.cpp`: clamped region, degenerate range falls back to the
whole clip, sub-region skips in-place apply, and accept/bounce land one clip on a shared "Neural
Renders" lane. The landed-clip bookkeeping is module-local, **not** a snapshot field — native's
`landedClipId` is internal and `snapshot()` does not emit it, so a mock field would be drift in the
other direction.

## The full gate is what caught the last defect

Catch2 was the one step not yet run when #459 was ready to merge. Its **AL-011 drift guard**
(`test_multiplayer_lock_manager.cpp`) failed: every dispatched command must resolve to a lock scope or
be explicitly allow-listed, and `unfreeze_layer` was in neither. Unclassified means **unguarded** — in
a multiplayer session a peer could thaw a layer on a clip another producer holds. Fixed by classifying
it Clip-scoped beside the rest of the render-layer family.

Everything else was green; running the last step anyway is what turned it up.

## Verification

Each guard RED-proven — shown failing on unmodified code — at every layer:

| | |
|---|---|
| `--selftest` | **1843/1843**, deterministic ×3 (identical signatures after normalising the session name); 1824 before. RED with the engine reverted: **7** failures |
| `verify.py --gate` | **20/20**, incl. the new freeze check. RED: `layer_audio_files_total: 3` |
| Catch2 | **2212 assertions / 207 cases** |
| vitest | **1986** |
| e2e | **242** (isolated config) |
| visual | 4 unchanged |
| `tsc` | clean · `grep SABOTAGE` clean |

## Gotchas earned here

- **`verify.py` must be run from the repo root.** `GenerativeJobManager` resolves `service/server.py`
  **CWD-relative**, so running it from `scripts/verify-hardware/` fails every service-dependent check
  with "generative service unavailable" — including pre-existing ones, which reads as though your
  change broke nine things.
- **Selftest check *labels* embed `MOSH_SELFTEST_SESSION`**, so a ×3 determinism comparison must
  normalise the session name before hashing, or three identical runs look divergent.
- **Don't copy a hash out of a truncated assertion message.** vitest elides with `…`; a guessed suffix
  matched for 37 characters and was wrong. Re-run and read `Received:`.
- **A prompt byte-stability pin moving is not always a failure.** `loopPrompt.test.ts` pins
  `systemPrompt(FIXTURE)`; adding a catalog command moves it legitimately. Update it *consciously*,
  recording why and the previous value — that is the pin's stated purpose.
- **jsdom cannot catch a focus/blur gesture bug.** Wave 2's tempo field opened on `pointerdown`, and
  the following `mousedown` blurred the input, whose `onBlur` committed and closed it. Only the
  real-mouse e2e caught it. Open inline editors on **click**.
