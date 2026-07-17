# Stale job-dir re-render audit (2026-07-16)

## The bug class

A render layer's job dir (`sessionDir/renders/<layerId>/`) is **reused across renders**, and
every render poller treats an existing `output.wav` + manifest pair as the **durable completion
signal** (deliberately — real SA3 can finish and write both files while `/status` is already
unreachable during service teardown). The two signals combine badly: a RE-render submitted into
a dir still holding the previous render's pair "completes" on the **first poll** with the stale
audio, while the command result still reports an honest-looking cache MISS. Found live on the
LoRA-rack branch (an SA3 rack re-render landed the base render verbatim).

## Audit: every submit that could reuse a completion path

| Call site | Files | Reuses a path? | Exposed? |
|---|---|---|---|
| `cmdRenderLayer` → `jobManager.submitJob` (MoshOps.cpp) | `renders/<layerId>/output.wav` + `output_manifest.json` | **Yes — same pair every render of the layer** | **YES** — both the `wait:true` inline loop and the `wait:false` async poller break on the pair |
| Render-ahead `renderAheadSubmitWindow` → `submitJob` (MoshOps.cpp) | `renders/<layerId>/live/win_<k>_e<epoch>_out.wav` + manifest | Epoch-stamped stems: arm, disarm, and `renderAheadParamChanged` all bump `ra.epoch`, so within a session every submit gets a fresh name | **Cross-restart only** — `epoch` is in-memory (resets to 0) while `live/` persists in the session dir, so re-arming the same layer after an app restart repeats `win_0_e1_*` and the window polls (async + `render_ahead_tick wait:true`) hit the previous session's pair |
| `TrainingJobManager::submitJob` (cmdStartTraining) | training output dir | n/a | **No** — completion is HTTP `/training/status` only; no file-pair signal |
| Transcribe / lyrics / skeleton / sketch / stitch flows | — | n/a | **No** — synchronous HTTP round-trips (response body), no job-dir polling. The only `output.existsAsFile() && manifest.existsAsFile()` checks in the tree are the four in `cmdRenderLayer` (wait ×2, async ×2) and the two render-ahead window polls |
| Local bounces (`bounceClipToWav`, stitch grow, `accept_render` copy) | various | Yes | **No** — each already `deleteFile()`s its destination before writing |

## The reactive loop (P3) is covered by construction

`reactiveTouch` → debounce → `reactiveFire` → **`cmdRenderLayer ({clipId, wait:false})`** — the
reactive path is a plain re-entry into cmdRenderLayer, so it shares whatever submit hygiene
cmdRenderLayer has (and shares the bug before the fix: every reactive re-render of an SA3 layer
would land the previous audio instantly). No separate submit to patch.

## Fix (this PR)

Delete the `outputWav` + `manifest` pair in **`GenerativeJobManager::submitJob`** itself,
immediately before the `/submit` POST — the single choke point both callers go through. This
covers cmdRenderLayer (wait + async + reactive) **and** the render-ahead cross-restart case in
one place, and any future submit caller inherits it. The deleted files are per-job transients:

- in-place / beneath-MIDI applies copy the render to a durable fingerprint-named file
  (`audio/<layerId>-<fp12>.wav`) at finalize;
- `accept_render` copies the artifact to `audio/<layerId>.wav` before landing the lane clip;
- the only file lost is an **un-accepted legacy/sing audition** while its own re-render is in
  flight — and pre-fix that re-render never actually rendered (it broke on the stale pair), so
  nothing playable is being taken away that the producer was entitled to keep.

(The equivalent cmdRenderLayer-local delete currently sits uncommitted in the LoRA worktree;
once this lands on main that hunk is redundant — safe to drop on rebase, harmless if kept.)

## Test gap + the new guard

No existing test could catch this: the selftest's Stage-5 loop asserts cache **MISS/HIT and
status only** — a stale re-render reports MISS + ready and passes. The fake adapter's output is
a deterministic function of its params (seeded gain), so the selftest now hashes the clip's
applied source after the first render (seed 1) and after the param-change re-render (seed 2)
and asserts the **bytes actually changed**. RED-proven against the unfixed tree (the stale pair
makes the two hashes identical), GREEN with the fix.
