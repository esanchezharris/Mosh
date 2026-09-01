# Overnight report — 2026-09-01 (branch `claude/music-generation-workflow-19ca09`)

Everything landed as commits on this branch for your review; nothing merged, nothing
pushed. Verification status at the bottom. Deliberately uncommitted file (per plan).

## What shipped (4 commits on top of yesterday's un-fence)

1. **`55d37b30` — Template-aware session render** (flywheel pillar 2). The agent's
   prompt now shows every track's instrument, fx chain, and `[drum]` type
   (`ui/src/agent/sessionRender.ts`) — it can finally see WHAT it writes for.
   All segments conditional → Python SFT mirror stays byte-parity without change.
2. **`7efd68d6` — Preset seam** (P1-A2). New MoshOps commands `list_presets` /
   `load_preset` with the full five-registration checklist. `.vital` presets load
   into a hosted Vital via the byte-verified VC2!/IComponent envelope through a
   UAF-safe whole-state UndoableAction (Vital-only targeting — a .vital can never
   hit Serum); `.json` presets drive the built-in 4OSC (params by display name +
   per-osc waveShapes, one undo step, G14-safe). Rack instrument cards got a
   **Presets… picker** (mouse path, both shells; reachability ratchet stays 0).
   Bundled bank: 5 starter 4OSC patches (`resources/presets/4osc/`, staged into
   the app bundle) — **UN-AUDITIONED, your ear pass needed.**
3. **`40f36765` — Produce lane v1** (P1-B2/B3), behind settings flag **`produceLane`
   (default OFF)**. Explicit asks ("produce me a beat", "full beat", "production
   pass") get PROMPT-trap-v4's genre rules translated to MoshOps idioms (lane-map
   drums from the gen001 reference, sustained 808s in MIDI 62-70, presets-before-
   judging, recipe-first foundation, your r1 lessons) + raised budgets (24 steps /
   480s). Default lane stays byte-identical (pinned by test).
4. Plus yesterday evening's **`203b5fdb` — generate_beat_recipe un-fenced**
   (two-phase WebBridge hop; agent-callable; v2 add-track "Recipe beat" entry).

## Verification

- **vitest: 4348 passed / 0 failed** (contract, classification, txn pairs,
  reachability-ratchet-at-0, new produce/preset/trackKinds specs). `tsc` clean.
- **Built app selftest: 3 × 3305/3305, 0 failed; `--selftest-undo` 18/18.**
  Full app build clean.
- **Official `gate.sh` did NOT run** — its memory preflight tripped twice on
  machine state, never on code: first ~70GB swap (the leaked servers, below),
  then the Codex-children guard (79 children of YOUR ChatGPT/Codex app-server vs
  cap 64 — owner territory per CLAUDE.md, untouched). **Re-run the gate when
  you're up**; code-level equivalents above are all green:
  `scripts/auto-loop/gate.sh native <this worktree> origin/main`
- Not yet covered: selftest checks for list_presets/load_preset (count still
  3305 = baseline); Vital preset audibility (state round-trip is in, but Vital
  applies patches asynchronously — needs the running app + your ear).

## The 3 AM memory incident (root-caused)

You spotted 5×17GB pythons: four were **orphaned Mosh local-brain servers**
(fused-model `mlx_lm.server`, ports 8091-8094) spawned by Mosh app launches at
03:13-03:52 and never cleaned up — together ≈ the 70GB of swap. Killed; swap fell
70GB→2.4GB. Root cause: your launch agent `com.emilio.mlx-qwen3-4b` holds port
8091 (RunAtLoad+KeepAlive) — the exact port Mosh's owner runtime prefers — so
every app launch cascaded to a fresh spawn on the next port, and app exit
orphaned them. **Task chip filed** ("Fix owner-runtime brain-server port
collision and orphan leak"). Also: your 8321 Qwen3.5 server is supervised
(`com.emilio.mlx-qwen36-35b-abliterated`, KeepAlive) — it respawned itself after
the stop you approved, so no restart needed; it's running.

## palette-v2 candidates (your morning by-ear pass)

SA3 one-shot batch at `~/Library/Mosh/palette-v2-candidates/` —
`CURATION-CHECKLIST.md` + `manifest.json` there have the final counts (batch was
still rendering at report time; 18 first-wave renders salvaged + the rest
resumed on the clean machine). Detour worth knowing: the SA3 MLX weights
(`stabilityai/stable-audio-3-optimized`) had been DELETED from the HF cache
(the load-bearing entry from the Aug-18 cleanup memo) — all four `.npz` were
re-downloaded at the pinned revision and the `~/AI/stable-audio-3` symlinks work
again.

## Your queue (owner-gated, in rough order)

1. Rerun the gate (command above) — should be green now that the machine is clean;
   the Codex-children guard may still need your Codex app quit or your explicit
   `MOSH_MAX_CODEX_CHILDREN` call.
2. Curate palette-v2 candidates by ear (checklist in the folder) — keepers become
   the rights-clean library seed.
3. Audition the 5 bundled 4OSC patches + one Vital `.vital` load in the running
   app (drop any of your .vital files in `~/Library/Mosh/presets/vital/`).
4. First produce-lane live run: flip `produceLane` ON in settings, say
   "produce me a beat", judge by ear — that's the first Mosh-vs-flywheel data
   point. (Frontier model key must be configured; local model stays on the
   assistant lane.)
5. Decide merge timing for this branch once the gate is green.
