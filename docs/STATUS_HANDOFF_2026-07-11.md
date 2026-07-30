# Mosh — Status & Handoff (2026-07-11)

> **Frozen dated snapshot — audited 2026-07-11, not updated since.** Current
> state lives in [`CURRENT_STATUS.md`](CURRENT_STATUS.md) (the one rolling
> status doc).

*A ground-truth snapshot for starting an informed conversation (esp. in web chat) without re-deriving
context or accepting stale assumptions. Audited against git/GitHub + the live repo on 2026-07-11.
Where a number came from a prior session's gate run rather than a rebuild in this audit, it says so.*

---

## 0. Read-me-first — the corrections web chat keeps getting wrong

1. **What Mosh is.** A native macOS DAW (JUCE 8 app + Tracktion engine) with a **React/WebView UI**
   and a **Python generative service** sidecar. **One mutation path:** every user-visible change is a
   **MoshOps command** (validate → Tracktion undo txn → emit events → JSONL log → structured result).
   The frontend couples to the backend **only** through `execute_command()` + a snapshot/events feed
   (the "swappable seam"). Read `ARCHITECTURE.md` first; `CLAUDE.md` is the build-status manifest.

2. **Current HEAD is `origin/main` = `50c24ad0` (#315, 2026-07-10 19:30).** ⚠️ The **local `main`
   branch in the `~/Documents/ClaudeMosh` checkout is a STALE ref at `b43add91` (#290), 28 commits
   behind** — it just wasn't fast-forwarded. Don't trust `git log main` in that checkout; use
   `origin/main` (or the worktrees, which sit at `50c24ad0`). DRM-002 and every hardening PR are on
   `origin/main`, NOT on local `main`.

3. **Zero open PRs, zero open issues.** The entire Codex→Claude backlog + the #289–#317 hardening
   sprint were reviewed and merged 2026-07-09→11.

4. **The neural story is ONE tier now, not two.** The synthetic "Tier-A" real-time neural insert
   (`NeuralInsertPlugin`, an untrained MLP saturator) was **removed 2026-06-21**. Dramatic
   timbre/instrument transfer comes from either a hosted VST3 or the Route-B/C RAVE work (real-time
   RAVE insert exists behind `-DMOSH_ENABLE_ANIRA=ON`, OFF by default). If web chat talks about
   "Tier-A neural," it's out of date.

5. **Generative beats: the reward/RL model is FROZEN.** The owner judged generated beats "all sound
   the same." The approved pivot (2026-06-30) is **retrieve + recombine real per-element motifs from a
   library of real producer recipes**, not a learned audio reward (prior reward attempts came back
   ρ≈0). The rules "verifier" is demoted to a validity gate with no taste. Don't propose reviving the
   audio-reward RL loop.

6. **Platform canon: macOS / Apple-Silicon (arm64) + MLX is canonical.** Windows+CUDA is an additive,
   `#if`-guarded port (owner builds it). Linux x86_64 is an **exploratory CI-only spike** (headless
   tests + service), not a supported GUI target.

7. **iCloud is a proven data-destroyer — nothing a build reads lives under `~/Documents` anymore.**
   The git object store, per-feature venvs, and the CMake dep-cache were all moved out to
   `~/Library/Mosh/…` after iCloud eviction corrupted each in turn (2026-07-03, -07-09, -07-10). See §5.

---

## 1. Build & repo state

| Item | Value |
|---|---|
| True HEAD | `origin/main` **`50c24ad0`** — "reset_rave RT-safe (#315)", 2026-07-10 |
| Local `main` (Documents checkout) | `b43add91` (#290) — **stale, 28 behind**; fast-forward it before using |
| Open PRs / Issues | **0 / 0** |
| Deployed app | `/Applications/Mosh.app` — built **2026-07-11 01:10** (from the sprint, incl. the `MOSH_ENABLE_ANIRA=ON` verify of #315) |
| Git store (real) | `~/Library/Mosh/repo/ClaudeMosh.git` (fsck-clean; checkout points at it via `gitdir:`) |
| Dep cache / patched tracktion | `~/Library/Mosh/work/cpm-cache` + `~/Library/Mosh/work/deps/tracktion_engine-src` (carries engine patches 0001–0003) |

**Last recorded gate baselines** (from the sessions that landed the work — *not* rebuilt in this audit):
`--selftest` ≈ **1254–1260 ×3 deterministic** (1254 at DRM-002, 1260 post-hardening-sprint), Catch2 ≈ **494**,
vitest ≈ **874**, e2e **125/125** (isolated config), `tsc` clean, `verify.py --gate` green.

**Build recipe (fresh worktree, verified 2026-07-10, cmake 4.3.2):**
```
cmake --preset macos-arm64-release \
  -DCPM_SOURCE_CACHE=$HOME/Library/Mosh/work/cpm-cache \
  -DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=$HOME/Library/Mosh/work/deps/tracktion_engine-src
cmake --build --preset macos-arm64-release-app   # or -tests
```
Selftest binary: `build-macos-arm64-release/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh --selftest`.
(`~/.mosh-auto-loop/auto-loop.env` was healed to these paths; a plain no-flag configure is now iCloud-safe too.)

**Uncommitted on the Documents `main` checkout** (housekeeping, not blocking):
- `service/lyrics/core.py` — modified (+73/−5), uncommitted.
- New untracked source that looks real (not iCloud dupes): `service/lyrics/verse_gen_test.py`,
  `service/sft/r5_train_additions.jsonl`, `src/webview/UiResourcePathGuard.{cpp,h}` +
  `tests/test_webbridge_resource_guard.cpp`, `ui/src/sft/evalABoundFilter.{ts,test.ts}`,
  `ui/scripts/renderExamplePatch.mts`, `patches/0002-juce-headless-vst3-host-context-refcount.patch`.
- ~23 iCloud sync-conflict dupes (files literally named `… 2.md/.swift/.cmake/.py`) — safe to delete.

---

## 2. Threads IN PROGRESS (active worktrees / unmerged branches)

There are 5 git worktrees. Two are live dev threads, one is UI R&D, one is this audit, one is stale cleanup.

### A. SFT — the Moshi/A3B DAW-command model (r4 → r5)  ·  *biggest active thread*
- **What:** Stage-1 supervised fine-tune of `Qwen3-30B-A3B` (LoRA, last-16-layers) to emit MoshOps
  command trajectories from natural language — the on-device "brain" that would replace/augment the
  cloud brain for command generation. Tracked in `docs/bench/PROGRAM_STAGE1_2026-07.md` +
  `service/sft/`. Cloud brain stays the serving default regardless per program invariants.
- **State:** r4 completed on a RunPod CUDA pod (12,889 iters, ~5h). Its exit-gate read **MISSED** the
  per-command floor leg. A **fix-first gate RERUN on the same archived adapter through a repaired
  harness** (2026-07-10) cleared the harness-caused misses (`split_clip` 0.0→0.833,
  `set_track_type` 0.42→0.50); the two **model-caused** misses that survive are **`assign_sample`
  0.333** and **`load_drum_kit` 0.333** (over-deferral on fully-explicit asks). Context bars all hold
  (frozen300 0.989, agg 0.919, §B 0.892).
- **Ready to go:** **r5 is fully pre-registered** (`PROGRAM_STAGE1 §P9`, 2026-07-10). Data =
  `s2-mix-v5` (12,994 rows: v4 verbatim + 15 assist rows + a 90-row engine-validated drum-sampler
  corrective batch targeting exactly those two families, PR #287). Recipe = the r4-CUDA lane verbatim
  (RunPod A100, ~5h, ~$7). Gate re-registered verbatim, **one clean read, no retry.**
- **NEXT (owner-gated):** launch r5 on the pod → single gate read on the **post-id-fix `evalA`** (sha
  `d68ec636…`; see the id-fix note below). Registered caveat: if the two families still over-defer,
  the next lever is intent-level (ACK-vs-DEFER prior), not more rows.
- **Artifacts:** r4-cuda adapter archived + sha-verified at `~/AI/adapters/a3b-r4-cuda-pull`
  (sha `2f29b655…`). Pods terminated.
- **⚠️ evalA id-fix:** the frozen `evalA` eval set was repaired 2026-07-10 (29/210 rows referenced
  real-engine ids that never exist in the mock → now `${VAR}` placeholders). **Any r5 gate read must
  use the post-fix file (sha `d68ec636…`)**; never compare pre-fix floor reads on the affected
  families to post-fix reads. (`docs/bench/PROGRAM_STAGE1 §P9 amendment 1`.)

### B. FMS Phase 3 — own-voice render (the ACE-Step Cover spike)  ·  *worktree `used2-ace-step-cover-spike-be9519`, branch not merged (4 ahead / 33 behind)*
- **What:** the endgame of Finish-My-Song — an owner-ear-validated re-sing of real material in the
  owner's own voice. Prior guide (Voicebox-cloned TTS) got "close but revise — the TTS voice is
  throwing us off, base it on the actual raw mumble." The spike tests **ACE-Step 1.5 Cover** (raw take
  = structure, 16 asserted words = lyrics) as a go/no-go gate.
- **State:** a controlled 8-seed batch harness + lexical/contour/F0 diagnostics on the "Used2" opening
  take; a review page (`:8189`); a **flow-edit lane** and melody-adherence sweeps explored by ear.
  Recent commits work on melody-lock (cns 0.5–0.7 breakthrough on torch DiT), an FX/auto-tuned source
  override, and a full-song sonic-check player. Local ACE install at `~/AI/ace-step-1.5-mac`
  (turbo DiT only, MLX/MPS, ~13 GiB disk → "no new downloads" guard is live).
- **NEXT (owner-gated, verdict-dependent):** owner listens to the 8-seed cover renders →
  **PASS** = promote ACE cover-guide + voice conversion toward the product sing pipeline;
  **FAIL** = SoulX PC bring-up becomes the path (ACE stays a generic-voice scratch mock).
- **Stacked idea (spec-only, gated on the above passing):** an **ACE-Step voice LoRA** trained on the
  owner's own catalog (`docs/superpowers/specs/2026-07-10-ace-voice-lora-experiment-design.md`).
  Needs a rented 24 GB pod (the owner's 4070 Super @ 12 GB can't train it). Not started.

### C. Type-beat SA3 LoRA trainer  ·  *worktree `sa3-lora-training-bad030`, branch not merged (24 ahead / 2 behind)*
- **What:** advancing the type-beat LoRA thread from scaffold toward a real **LoRA rack + runtime GPU
  application** of trained LoRAs to Stable-Audio-3 renders. New service surface (`service/loras/`,
  `service/sa3/lora_merge.py`), MoshOps additions, a UI Dock "LoRA rack," e2e + mock coverage.
- **State:** unmerged WIP, ~24 commits ahead of main. The **real on-device LoRA-base training +
  vector layering was the long-standing deferred item**; this branch is the seam/plumbing for
  applying LoRAs. Not gated/verified in this audit — treat as in-flight.
- **NEXT:** unclear ownership status — confirm with the owner whether this is being actively pushed or
  parked; it overlaps the `#277` transform-backend-install work already on main.

### D. Mosh Designer Arena — UI taste bench  ·  *worktree `move-checkout-icloud-f8fee2`, branch `claude/daw-ui-upgrade-317ab2` (this branch also carries origin/main's tip)*
- **What:** a **dev-only** Vite/React app at `arena/` (`:5273`) that mass-produces AI-generated UI
  design candidates (HTML shells + GLSL waveform shaders) for the owner to judge — the "iPhone of
  DAWs" push. Never ships in Mosh.app (0 refs from `ui/`; sandboxed candidates, no-network CSP).
- **State:** **Stage 0 + Round 2 DONE + verified (2026-07-11).** ~38 candidates across 6 live
  designers (Claude/GPT/Grok/OpenRouter/DeepSeek/Kimi). Real Moshi creature embeds in candidates;
  lightbox + native-size preview fixed. **NOT committed** (`arena/` is untracked; only
  `.claude/launch.json` changed).
- **NEXT (owner-gated):** owner judges the wall + runs "Summon" across designers → **Stage 2** = port
  winners into `ui/src/v2/shell.css` and land the winning waveform on every clip via one shared
  WebGL2 context. **Blocker:** Gemini designer fails 429 — the provided `AQ.…` key isn't an AI-Studio
  `AIza…` key; owner needs one from aistudio.google.com/apikey (Gemini works via OpenRouter meanwhile).

### E. Beat-recipe generation ("packs")  ·  *not a worktree — a stable, physically-frozen loop*
- **What:** the real-recipe beat factory (retrieve→recombine→transpose→bind→render) + a taste
  ranker, driven by owner keep/kill labels. Tracked in `docs/bench/ROUND_CHANGELOG.md`,
  `~/mosh-beats`, `~/mosh-taste`.
- **State:** through **pack-006** ("Era-1, the Long Pass" — the generation pipeline is deliberately
  FROZEN for packs 006–009 so labels accumulate on one stable distribution). Ranker at LOPO 0.52
  (advisory mode; 0.65 bar).
- **NEXT:** owner rates packs; ratings trigger the next pack build. This is a steady-state listening
  loop, not a blocked thread.

### Housekeeping worktrees
- `happy-mclaren-284867` — **this audit** (branch `claude/mosh-build-status-audit-1305be`).
- `consolidate-codex-threads-f0f58a` (detached `d279d5a3`) — leftover from the #316 consolidation
  merge; likely safe to remove after a glance.

---

## 3. Shipped & stable — don't re-litigate these

- **Stages 0–6 all GATE PASSED** (skeleton → engine+MoshOps+state feed → WebView arrangement → VST3
  hosting → [Tier-A removed] → generative layer w/ real Stable Audio 3 → consolidation). The full
  producer loop (import → arrange → host VST3 → generative transform → mix → export → undo/redo) is
  proven with real rendered audio (`docs/VERIFICATION.md`).
- **Finish-My-Song Phases 1 & 2** (text lyric engine + mumble→skeleton) are **on main**.
  **Phase 3 Stages 1 & 2** (skeleton promotion + SoulX sing adapter, fake-first) are **on main**;
  the real own-voice render is thread **B** above.
- **DRM-002 `add_drum_pattern`** (whole drum grid in one MoshOps command, opendaw-style pattern DSL) —
  on origin/main (#291).
- **Hardening / bug-hunt sprint** (#289–#317): RT-safety, concurrency, lifecycle-leak, mock-fidelity,
  and native-robustness fixes — merged.
- **v2 UI shell** is the default; classic preserved in `AppLegacy.tsx`.
- **Multiplayer, iPhone companion, real-time RAVE (anira, opt-in), PC-port prep (FIT-010), Linux CI
  spike (FIT-011)** — all landed/prepared and documented.
- **Route B/C transform** (native timbre/instrument transfer; real RAVE backend + real-time insert) —
  landed; real models are owner-dropped into `~/AI/rave-models`.

---

## 4. Open questions / owner decisions pending

1. **Launch r5?** Data + gate are pre-registered and ready; ~5h / ~$7 on a pod. Or take
   **accept-with-exceptions** on r4 (it beats the cloud brain on §C/§B and every other floor; the two
   surviving misses are documented). Cloud stays the serving default either way.
2. **FMS own-voice verdict:** listen to the ACE-Step cover seeds → ACE-cover path vs SoulX-PC path.
3. **Voice LoRA experiment:** go only if the cover guide passes words+contour by ear (needs a rented pod).
4. **Designer Arena Stage 2:** which candidates win → port into `ui/src/v2`; and the Gemini API key.
5. **SA3 LoRA trainer branch (thread C):** actively pushing, or park?
6. **Housekeeping:** fast-forward local `main`; commit or discard the uncommitted `service/lyrics/core.py`
   + the untracked new source files; delete the iCloud `… 2.*` dupes; prune the stale consolidate worktree.

---

## 5. Infra hazards & gotchas (bit us before — will again)

- **iCloud eviction.** `~/Documents` is iCloud-synced and silently evicts file *contents* (leaves
  zero-byte stat-visible files) → corrupted the git store (07-09), venvs (07-03), and the cmake dep
  cache (07-10, the "Unknown CMake command juce_add_modules" failure). **Rule: nothing a build reads
  lives under `~/Documents`.** Everything moved to `~/Library/Mosh/…`. Diagnosis docs:
  `docs/2026-07-10-cpm-cache-icloud-eviction.md`, `docs/CONSOLIDATION_2026-07-09.md`.
- **GitHub Actions billing block.** Mid-sprint, CI stopped starting jobs ("recent account payments
  have failed / spending limit"). Account-wide, owner-only fix. Fallback = **local gate + admin
  squash-merge** (documented in the hardening-sprint memory). Assume CI may be down.
- **`FETCHCONTENT_SOURCE_DIR_*` bypasses `PATCH_COMMAND`** → the pointed-at tracktion clone must
  already carry engine patches 0001–0003 in its working tree (the blessed one at
  `~/Library/Mosh/work/deps` does).
- **Interrupted app build → false selftest failures.** A partial app build can skip the POST_BUILD
  drumkit/UI staging, leaving `Resources/drumkits/mosh-kit/kick.wav` absent → a deterministic 2-fail
  in "portable projects + relink (gap 3)" that looks like a regression but is staging state. Fix:
  `cd ui && npm install` then a CLEAN app build; confirm `find … -iname kick.wav` first.
- **e2e config.** Use `ui/playwright.isolated.config.ts` (port 5191) whenever another session owns
  `:5173`, or a foreign bundle false-fails all specs.

---

## 6. Doc map (where the truth lives)

- `ARCHITECTURE.md` — what Mosh is / module map (read first).
- `CLAUDE.md` — build-status manifest + the long "Working notes" ledger (dense but authoritative).
- `docs/02_MOSHOPS_CONTRACT.md` — the command contract; `docs/ENGINE_API_NOTES.md` — Tracktion API resolutions.
- `docs/VERIFICATION.md` — how "real audio" is proven; `docs/FEATURE_AUDIT.md` — DAW-parity scoreboard.
- **Training:** `docs/bench/PROGRAM_STAGE1_2026-07.md` (§P9 = r5), `ROUND_CHANGELOG.md` (beat packs),
  `service/sft/` (SFT run state, gate reads).
- **FMS:** `docs/FINISH_MY_SONG_ROADMAP.md` + `FINISH_MY_SONG_LYRICS_BUILD_SPEC.md`;
  used2 spike specs under `docs/superpowers/specs/2026-07-{09,10}-*`.
- **Platform:** `docs/WINDOWS_PARITY.md`, `docs/WINDOWS_RUNBOOK.md`, `docs/2026-07-07-linux-build-spike.md`.
- ⚠️ `docs/RESTART_HANDOFF.md` and `docs/CURRENT_STATUS*.md` are **older** (2026-07-01 and earlier) — this
  file supersedes them for current state.
