# Mosh — Ground-Truth Status & Context (2026-07-02)

**Written:** 2026-07-02 (evening) · **Trunk:** `origin/main` @ `fc36d97ca955e88c4d6810c8e2d837c603ce2281` ("The Long Pass era-0", PR #215) · **Authoring checkout:** branch `claude/status-doc` at that same commit.
**Tags:** every claim is marked **[measured]** (ran or read this session), **[inferred]**, or **[could-not-find]** (with where I looked). Self-contained by design — no claim requires opening a file.

---

## Part 0 — Deltas vs. the stale picture (most important first)

1. **An entire subsystem the stale picture doesn't contain: the taste-training program ("the Long Pass").** Since 2026-07-02 morning, main carries a **beat factory** (`service/recipes/` + `scripts/verify-hardware/beat_factory.py`): a 72-candidate generation grid (4 owner-named styles × 6 minor keys × 3 seeds) → hard audio gates → auto mix-balance → FX → a 14-beat "taste pack" the owner rates in ~10 min (KEEP/KILL + defect chips + ONE top pick + new idea/mix split verdicts). Seven packs exist (~/mosh-beats/pack-001..007); the owner has rated six (label ledger: **108 rows, 84 keep/kill, 3 top picks** [measured]). On top: a persistent CLAP+MuQ embedding store (**217 rows** post pack-007 [measured]), an **advisory taste ranker** (L2 logistic over MuQ-PCA-12 + Audiobox axes + symbolic + corpus-similarity features; LOPO 0.554 vs a pre-registered 0.65 adoption bar [measured]), and **era mechanics**: generation code is **physically frozen** per-era via a git worktree (`~/mosh-eras/era-001` @ fc36d97c) with pinned data inputs, so labels accumulate on one stable distribution. Era-001 (packs 006–009) is OPEN; prequential (stamped-before-hearing) AUC on pack-006, the first frozen-era pack: **0.6458** vs pack-005's 0.5714 [measured]. Promotion ladder and a Stage-2 learned-proposer gate are pre-registered on main (`docs/bench/RANKER_PROMOTION.md`, `docs/plans/STAGE2_GATE.md`) [measured].
2. **Every "open" infra gap in the stale picture is closed except two.** Autosave (30 s timer, `src/Main.cpp` `saveIfDirty()`), save-on-quit, Recents (capped 10), last-project restore — shipped (#32 + later) [measured, code read]. Project-format versioning + migration + newer-file refusal — shipped (`src/state/Migrations.h`, `moshFormatVersion`, `migrateOrRefuse`, PR #155-era hardening) [measured]. Notarization — a full `./run-mosh.sh release` → notarized DMG+zip pipeline exists (PR #152); still **pending the Developer ID certificate** (Team ID ZYT77F9B27) [measured docs; cert state inferred]. Windows/CUDA port — in-tree and preset-complete but **still not hardware-verified** [measured docs]. The bundled brain key is **by design**, not a leak (see Part 1.3c).
3. **Training-stack corrections to the stale picture** (each detailed in Part 2): GRPO is **frozen** (PR #176 open, never merged; the audio smoke earned reward **exactly 0.0** and the reward it chased was later measured at ρ≈0.007 vs owner blind ratings, pull component anti-correlated at −0.129) [measured: audit doc + PR state]. The "LoRA 0.62" was really the honest local score **0.6192 vs cloud 0.8754**, and the celebrated 0.889 was a wrong-tokenizer serving artifact [measured: audit]. **A post-audit SFT retrain exists**: `v3-final` adapters (29.4 MB) + fused model (2.26 GB), dated 2026-07-01 21:17 [measured ls] — the stale picture predates it. **The 24-clip validity pack has now been rated** (24/24 rows, mean 2.88 on a 1–6 scale) [measured CSV] — the audit's "never rated" is out of date. **Live tuple-harvest remains at zero ever** [measured: no tuples.jsonl anywhere]; do not confuse it with `~/Library/Mosh/session/trajectory.jsonl` (96 rows: 2 session headers + 93 steps + 1 tutorial, consent=false) which is the raw session recorder, not harvested training tuples [measured].
4. **Counts moved:** MoshOps commands **173** (dispatch table read) with **78 agent-callable**; selftest today **1146/1148** from the deployed app (both failures are brain-proxy "no key configured" checks that *cannot* pass on a deployed bundle that ships `brain.env` inside — dev builds pass; see 1.1) [measured, ran twice]; newest recorded UI gates: vitest **666**, Playwright e2e **116**, Catch2 **298** (CLAUDE.md 2026-06-28 entries; not re-run — Playwright needs the dev server) [measured docs]. Recipe library on main: **542 recipes** (all `reconstruction_class: "deterministic"`) [measured grep]; a stale checkout (`claude/amazing-varahamihira-480e90`, 9 commits behind) shows 560 — the delta is an unmerged r7-promotion lane (open PR #197) [measured + inferred].
5. **The "two data fronts" reality check:** the SFT corpus's "back-translation" is **4 cached template shapes with `brainCalls: 0`** in the v3 manifest — templated paraphrase, not LLM back-translation [measured manifest]. The nine-agent YouTube→Recipe teardown lane produced the recipe *schema and compiler* (working) but the scout mining queue is **dead** (13 queued jobs point at a stage that doesn't exist; catalog is synth-tutorial-only — per the audit and re-verified paths) [measured]. What actually fills the library is the **owner's own FL Studio catalog** via the importers (~460 `owner_*` recipes of the 542) [measured filename prefixes].
6. **GitHub Actions**: `.github/` exists, workflows deleted 2026-06-15 (billing; local gates are the CI) — matches the stale picture [measured].
7. **UI shell**: v2 default (`uiShell: "v2"` in `ui/src/settings/schema.ts`), classic preserved verbatim in `AppLegacy.tsx` — matches [measured].

---

## Part 1 — State of the world

### 1.1 Repo snapshot [measured]

- **Trunk:** `origin/main` @ `fc36d97c` — "The Long Pass era-0: dictated fixes + era freeze mechanics + taste corpus + ranker v2 + pre-registrations (#215)".
- **main since 2026-06-27** (one-liners, newest first):
  ```
  fc36d97c 07-02 The Long Pass era-0 (#215)
  25edab68 07-02 latent-space training pass — embed store, advisory ranker, journal (#214)
  6fcb6bbb 07-02 FX knowledge-base scrape pilot — NO-GO verdict (#213)
  9e5cf030 07-02 song-form v0 — A A' B A arrangements (#212)
  c025b2e7 07-02 mix-polish v0 — native FX chains, delta-gated (#211)
  68e1dc77 07-02 TOP PICK rating replaces stars (#210)
  a6bee044 07-02 owner style vocabulary v0 + measured-key tripwire (#209)
  14e77b89 07-02 owner keep/kill source priors (#208)
  395ab46b 07-02 grid-lock — snap transcription timing (#207)
  f9ec498a 07-02 scale-reference MIDIs poisoned the library (#206)
  2713c562 07-02 pack-001 audition round fixes (#205)
  a746be64 07-02 beat factory + taste packs + eval research (#204)
  (06-28..07-01: #198–#203 training Stage 0/1 + audition-round fixes; #190/#194 restart Phase 0 + scout recovery;
   #178/#179/#180 Finish-My-Song lyrics phases; #175 TCC-plist fix; #174 lyric ladder)
  ```
- **Open PRs** [measured `gh pr list`]: #197 (r7 recipe-corpus promotion), #185/#184/#183/#181 (re-imagine/UI/compiler lanes), **#176 (GRPO Rung-1/Rung-2 — frozen by policy, never merge/run)**, plus 8 auto-generated draft stubs (#142–#150).
- **Command surface:** **173** MoshOps commands (dispatch table `src/moshops/MoshOps.cpp`), **78** agent-callable (`ui/src/agent/commands.ts`) [measured].
- **Fresh gate runs this session** [measured]: `Mosh --selftest` from `/Applications/Mosh.app`: **1146/1148**, twice, deterministic. The 2 failures are `brain: an incomplete requested provider falls back to a configured one` and `brain: nothing resolves when no key is set` — both in the "Moshi brain proxy" section and both premised on a *keyless* environment; the deployed bundle ships `Contents/Resources/brain.env` (see 1.3c), so keys always resolve there. Not a regression; dev builds without the sealed env pass 1148/1148 [inferred from mechanism; cheapest confirmation = run selftest on a dev build]. `verify.py --gate` (golden audio PCM): **12/12 ×3** earlier this session — with the gotcha that verify auto-prefers a stale local build if one exists; pin `--bin /Applications/...` [measured].
- **Platform posture:** macOS arm64 canonical (M-series, MLX); CMake presets for macos-arm64 and windows-x64 families; `MOSH_ENABLE_ANIRA` (RT RAVE insert) OFF by default; Windows presets in-tree, hardware-unverified [measured].

### 1.2 Doc drift [measured]

README.md and ARCHITECTURE.md headline claims were checked against code: **no material drift** (native arm64 DAW, Tier-B generative + gated RAVE insert, VST3/AU hosting, v2 shell default, Windows port "not yet verified on hardware" — all still true). Two soft understatements: ARCHITECTURE says "150+ commands" (now 173), and neither doc yet describes the beat-factory/taste-program subsystem (it lives in `docs/bench/`, `docs/TRAINING_JOURNAL.md`, and `scripts/verify-hardware/` — a reader of ARCHITECTURE.md alone would miss it entirely).

### 1.3 Infra-gap status board

| Gap (stale picture) | Reality today | Evidence |
|---|---|---|
| (a) Autosave / save-on-quit / recents / restore | **All shipped** | `src/Main.cpp` 30 s `saveIfDirty()` timer + shutdown flush; `MoshEngine.cpp` `session.recentProjects` (deduped, cap 10); `startupEditFile()` restore [measured] |
| (b) Schema versioning | **Shipped** | `src/state/Migrations.h`: `moshFormatVersion` stamped every save; `migrateOrRefuse()` at all 3 load sites; newer-file refusal latches `loadError` → save no-op; `tests/test_migrations.cpp` + selftest PRJ-FMT section [measured] |
| (c) Bundled brain key | **Deliberate design** (#129): `run-mosh.sh deploy` writes `ui/.env.local` (gitignored) → `Contents/Resources/brain.env`; `BrainProxy` env-var-first then bundle fallback. Provider chain **deepseek → openai → xai**, first configured wins; the shipped brain model is **gpt-5.4-mini** (audit: "KEEP as serving brain", 0.875 eval, ~$0.0015/turn). Python mirror: `service/brain_client.py` | [measured code+docs] |
| (d) Network surfaces | Generative service: `127.0.0.1:8770` (env-gated host/port, port-collision fallback to next ports), no auth/TLS — localhost-only by design. RemoteCompanionServer (iPhone): LAN port 47873, short-lived pairing token. Multiplayer relay: HTTPS on the relay side (Supabase or stdlib server), session token. No internet-exposed unauthenticated surface found | [measured `service/server.py`, `src/remote/`, `src/multiplayer/`] |
| (e) Notarization | Pipeline **built** (`./run-mosh.sh release` → notarized DMG+zip, PR #152); blocked only on the Developer ID Application cert (Team ZYT77F9B27) | [measured docs; cert = could-not-find on this machine] |
| (f) Windows verification | Port in-tree (presets, WebView2, `stable_audio3_cuda.py` auto-selected sans MLX, `verify-pc-build.ps1`), **no hardware run recorded anywhere I looked** (docs/, scripts/, PROGRESS) | [measured absence] |

### 1.4 Training-effort map (what runs today vs. aspirational)

| Lane | What it is | Status today | Artifacts (size, date) |
|---|---|---|---|
| `service/sft/` | Moshi SFT: chat-JSONL datasets + MLX LoRA configs + curate/eval tooling | **Runs** (train/fuse/serve proven; latest retrain 07-01) | `.sft-data/`: v3 24,277/3,079/2,990 rows; v3-daw 2,266/448/290; **v3-final 7,444 train (4,568 filtered) / 1,911 valid**; corrective-pilot 20 pairs. `.adapters/v3-final/adapters.safetensors` 29.4 MB; `.fused/v3-final/model.safetensors` **2.26 GB** — both 2026-07-01 21:17 [measured] |
| `service/training/` + `src/training/` | On-device LoRA trainer **scaffold** (rights registry, corpus bundler, job orchestration, 10 MoshOps commands) behind a **fake** backend | Scaffold only; real training deferred | `~/Library/Mosh/session/training/{adapters,corpora,rights_registry.json}` [measured ls] |
| `service/rl/` (branch `claude/funny-mendel-aeca12`, PR #176) | GRPO Rung-1 (symbolic reward) / Rung-2 (audio reward via `MOSH_RL_REWARD=audio`) | **FROZEN** by audit ruling; no runtime artifacts survive on any local disk | code only: `grpo.py` (359 ln), `reward.py` (62 ln), scorers [measured via `git show`] |
| `ui/src/harvest/` | Own-usage tuple harvest (14 TS files: CLI, generator, verifier, schema) | Code exists; **zero tuples ever captured** | no `tuples.jsonl` anywhere [measured]. Raw `trajectory.jsonl` = 96 rows (distinct mechanism) |
| `ui/src/import/` + `service/flp/` | RPP/ALS/FLP → MoshIR → MoshOps replay | **Works, 100% note fidelity** on all 5 test projects | fixtures local-only (rights); counts in Q12 [measured docs+code] |
| Beat factory / taste program (`service/recipes/`, `scripts/verify-hardware/`) | Retrieval+recombination generation → owner-rated packs → advisory ranker → eras | **Runs daily**; the active training loop in practice | `~/mosh-beats` ≈ 3.8 GB (7 packs, labels, embeddings 2.8 MB index, journal); `~/mosh-eras/era-001` worktree [measured] |
| Parked agent-training worktree | `.claude/worktrees/laughing-grothendieck-22549c` | **Does not exist on this machine** — likely cleaned; its landed outputs are on main via the #79–#89 PR series | [measured absence; looked in `.claude/worktrees/`] |
| Type-beat LoRA experiments | SA3 LoRA exps A–E | Parked post-audit | `~/AI/type-beat-lora-exp{A..E}`: 3 checkpoints each (~43–64 MB) + demo WAVs [measured] |

---

## Part 2 — Numbered questions

### A. GRPO forensics

**1. Do GRPO reward logs exist?** **[could-not-find — this is itself the finding.]** The trainer (`service/rl/grpo.py` on the PR #176 branch) writes `rollouts.jsonl` / `rewards.jsonl` into a run `workdir` and `gate_eval.<tag>.jsonl`; I searched `~/Library/Mosh` (all depths ≤4), `~/mosh-*`, `service/sft/.adapters` (only `v3-final` exists — no `rl-v1`), `/tmp`, and the branch tree itself. **No runtime GRPO logs survive anywhere on this machine.** The recorded outcomes live only in the audit doc (`docs/plans/moshi-training-audit-2026-07.md`): the audio smoke's reward was "exactly 0.0" and no full run ever completed. Cheapest regeneration: check out the PR #176 branch and run `service/rl/run_grpo.sh` in smoke mode (~minutes) — but note the audit **froze** this lane; regenerate only for forensics, not training.

**2. Per-group reward variance (advantage-collapse test):** **[could-not-find]** — requires the rewards.jsonl that doesn't exist. What IS known [measured, audit]: the Rung-1 symbolic reward "saturated at 1.0" (all-identical rewards within groups ⇒ zero advantage — collapse by construction), and the Rung-2 audio smoke returned 0.0 (also uniform ⇒ collapsed). So both recorded observations imply ~100% near-zero-variance groups, but the underlying per-group data is gone.

**3. Fraction of rollouts with nonzero reward:** **[could-not-find]** directly; the audit's recorded smoke = **0.0 reward** on the audio rung, i.e. ~0% nonzero on that run. Same regeneration path as Q1.

**4. Composite reward weighting — code, verbatim** [measured, `git show claude/funny-mendel-aeca12:service/teardown/flywheel/reward.py`]:

```python
def composite(self, scores: dict[str, float]) -> float:
    """Standardized, conservative aggregation. clean==0 (broken/amateur) → 0."""
    pq = max(0.0, min(1.0, scores.get("pq", 0.0) / 10.0))
    clean = scores.get("clean", 1.0)
    pull = scores.get("pull", pq)
    return round(clean * (0.5 * pq + 0.5 * pull), 4)
```

The taste ("pull") term is nominally **50% of the weight**. The stale picture's "taste moves only ~3% of composite spread" is about *observed spread*, not weight — pull values clustered so tightly that PQ dominated variation [inferred from prior session records; the underlying rollout set is gone — could-not-verify numerically]. Independent validity data that postdates it [measured]: the owner's blind reward probe (`~/mosh-reward-probe`, 38 clips, RATINGS 1–7, mean 4.21) measured composite-vs-owner correlation **ρ≈0.007** with pull anti-correlated at −0.129 (audit-recorded).

**5. Top-5 highest-reward rollouts, classified:** **[could-not-find]** — no rollout log survives. Not reconstructible without re-running (Q1 path).

**6. Learning curves (reward/KL/entropy):** **[could-not-find]** — same. The trainer has a KL leash (`--beta 0.04`) and logs to stderr; no run logs were preserved.

### B. Policy capability

**7. Current SFT eval + what the frozen eval measures** [measured]. Eval set: `service/sft/.sft-data/v3/test.eval.jsonl`, **2,990 rows**, each `{id, utterance, startCommands, goldCommandNames}` — it grades *command-emission* (multiset recall of gold command names, `fairRecall`-capped for populate tasks), not audio quality. Three representative rows:

```json
{"id": "38caad…#0",     "utterance": "set the tempo to 106",   "startCommands": [], "goldCommandNames": ["set_tempo"]}
{"id": "38caad…#0~bt0", "utterance": "Lock the tempo to 106.", "startCommands": [], "goldCommandNames": ["set_tempo"]}
{"id": "f1ec47…#0",     "utterance": "add a MIDI clip to the \"Track 2\" track", "startCommands": […], "goldCommandNames": ["add_midi_clip"]}
```

Recorded scores (audit-verified, byte-identical 300-id subsample, temp 0): **local Qwen3-4B-4bit LoRA 0.6192** (57 deferrals) vs **cloud gpt-5.4-mini 0.8754** (18); the 0.889 "win" was a wrong-tokenizer serving artifact; per-category floor example: `set_track_volume` **0.000×16** (a data defect — 420/708 train rows paired "up a little" with `db=0`). Post-audit `v3-final` retrain (07-01) exists but **no eval-results file for it was found** (`eval_results.*.json` absent from `.sft-data/v3-final/`) [could-not-find; cheapest: `npm run eval-sft` against the fused model, ~30 min].

**8. 30 fresh generations from v3-final (sampled this session, temp 0.7, held-out valid prompts)** [measured]:
- **Latency:** median **8.3 s/generation** (min 5.2, max 14.0) on the M1 Max via mlx-lm (fused 4-bit, ~3k-token system prompt).
- **Parse:** 28/30 emitted syntactically-parseable JSON; **26/30 schema-conformant** (2 truncated mid-JSON at the token cap; 2 emitted commands as strings — `"add_midi_clip(\"17\")"` — instead of `{command,args}` objects).
- **Catalog:** all commands in all 26 conformant replies were real MoshOps commands (0 invented command names).
- **Execution** (each reply replayed through the real engine via `Mosh --run-script` on a fresh 3-track session): of 23 replies with ≥1 command — **10 clean-apply, 8 partial, 5 all-failed**. Failure taxonomy: **id-mismatch dominates** ("no track" ×10, "no midi clip" ×6 — the model addresses track ids from its *training* snapshot, e.g. `"17"`, that don't exist in the live session; partly a harness artifact since real serving injects the live snapshot into the prompt), plus genuine **grounding hallucinations**: invented audio files (`beatbox.wav`, `https://example.com/beatbox.wav`, `beats/short_pattern.wav`) passed to `import_clip` (3 cases). Render-judging of clean-apply cases was skipped (they're mostly single deterministic ops — tempo/volume — where audible-improvement judging is vacuous) [judgment call, stated].
- **Reading:** the fork answer is **"mostly CAN act, syntactically"** — parse/catalog are strong; the capability gaps are *grounding* (session ids, file references) and *content* (the known populate weakness), not JSON emission.

### C. Data inventory

**9. Counts per front + per-command coverage** [measured]:
- SFT instruction data: v3 = 24,277/3,079/2,990 (train/valid/test); v3-daw = 2,266/448/290; **v3-final (the trained set) = 7,444 train / 1,911 valid**, curated with caps (`populate` 2500, `add_midi_clip` 2500, `set_tempo` 2000…). Command coverage in v3-final train: **19 distinct commands** of the 173 surface. Top: `add_note` 19,780 · `add_midi_clip` 2,500 · `set_tempo` 1,119 · `set_track_volume` 828 · `set_track_pan` 358 · `set_time_signature` 111. **13 commands have <10 examples** (`rename_track` 1, `add_test_tone_clip` 1, `split_clip` 1, `move_clip` 1, `trim_clip` 1, `remove_clip` 1, `set_track_mute` 2, `create_section` 2, `undo` 2, `remove_track` 2, `create_track` 3, `set_transport` 4, `set_track_solo` 6). 154 commands have **zero** examples.
- **10. Template vs back-translated:** the v3 manifest says `backtranslated: 23,888` of 24,277 — but `"backtranslation": {"enabled": true, "brainCalls": 0, "shapes": 4, "variants": 4}` and `bt_cache.json` holds exactly **4 entries**. So ~98% of instructions are *nominally* back-translated but generated from **4 cached template shapes with zero LLM calls** — functionally templated phrasing variety, not model paraphrase [measured manifest + cache]. (The audit separately recorded that shape-cached BT with ~10 brain calls lifted balance 0.42→0.62 on an earlier corpus.)
- **11. Recipe JSON:** **542** recipes on main, **100% `reconstruction_class: "deterministic"`** [measured grep]. Source split: ~460 `owner_*` (the producer's own FL catalog), ~77 `pack_*` (two rights-cleared MIDI packs), 5 `seed_*` templates [measured filename tally]. (A stale branch shows 560 — the +18 are an unmerged r7-promotion lane, open PR #197.)
- **12. Project-file corpus:** **no corpus — 5 local fixture projects** (kept out of git for rights): 1 .rpp (19 tracks/1,046 cmds/895 notes), 2 .als (109 tr/5,575 cmds and 32 tr/1,681 cmds), 2 .flp (15 tr/1,404 cmds and 12 tr/281 cmds) — **100% clean-apply on all five** [measured docs/MOSHI_IMPORTERS.md + code]. Genre skew: the owner's own dark/experimental trap [inferred from titles]. A drop-folder lane for more owner projects now exists (`~/mosh-taste/projects/`, empty as of tonight [measured]).
- **13. Own-trajectory harvest:** **tuple harvest = 0 rows ever** [measured absence of tuples.jsonl]. Raw session recorder `~/Library/Mosh/session/trajectory.jsonl` = **96 rows** (2 sessions, 93 steps, 1 tutorial; `consent: false` on both sessions) [measured]. Separate accepted-lyrics corpus flywheel exists but is owner-opt-in and tiny.

### D. Loop economics + hardware

**14. One full render-and-compare cycle, measured tonight** (create track → test-tone clip → create render layer → render `wait:true` → accept → export, fake adapter, via `Mosh --run-script`): **2.1 s cold, 1.6 s warm** [measured ×2]. Reference points: real SA3 render ≈ +1.5–2 s/render warm (+~1.7 s one-time model load) [measured in prior gates, docs]; a full *beat-factory* candidate (generate → render full beat → balance re-renders → gates) ≈ **8 s** [measured from pack build logs: 72 candidates ≈ 10 min].
- **15. Feasible rollouts/hour** (serial, this Mac): fake-adapter command-level cycles ≈ **1,800–2,200/h**; SA3-real re-imagine cycles ≈ **~900/h**; full-beat factory candidates ≈ **~450/h**. If the rollout includes *policy generation* (Q8: median 8.3 s), the LLM dominates: ≈ **350–430 policy+render rollouts/h**.
- **16. Hardware** [measured]: **Apple M1 Max, 64 GB unified memory**, macOS 26.4.1. `mlx 0.31.2 / mlx-lm 0.31.3 / mlx-metal 0.31.2` (in `~/AI/comfy/.venv`; torch 2.13-dev CPU alongside). CUDA box: **[could-not-find locally]** — the Windows/CUDA port docs don't record the GPU; resolution = ask the owner or read `nvidia-smi` on that box. **30B-MoE viability:** an 18 GB 4-bit Qwen3.5-35B-A3B-class checkpoint already sits at `~/AI/models/mlx/` and fits comfortably in 64 GB unified memory — locally viable for inference; LoRA training at that scale on 64 GB is tight but plausible with A3B activation sparsity [inferred].
- **17. Best-of-8 rerank for one user action** (8 candidate sequences → render → score): generation 8 × 8.3 s ≈ 66 s serial + render/score 8 × ~2 s (fake/command-level) ≈ 16 s → **~80–90 s serial, $0** (all local). With SA3-real renders: ~2.5–3 min. Batching the 8 generations in one mlx forward pass would cut the LLM share substantially [inferred; mlx-lm batch generation exists but is unmeasured here]. Against the cloud brain instead: 8 × ~1 s + renders ≈ ~25 s and ~$0.012.

### E. Readiness gaps + licensing

**18. Exists vs missing** [measured]:
- *Execution-filtered rejection sampling:* *nearly assembled* — `Mosh --run-script` (real-engine replay with per-command ok/error, env-var driven: `MOSH_RUN_SCRIPT`/`MOSH_RUN_SCRIPT_OUT`), the eval verifier (`ui/src/sft/evalSft.mts` ladder: parse→catalog→args→clean-apply→snapshot), and datasets exist. Missing: a driver that samples N per prompt, filters on clean-apply, and writes back to chat-JSONL (~a day of glue).
- *Batch/headless render CLI:* **exists** — `--run-script` + `scripts/verify-hardware/` render harness + the factory's candidate loop (72 renders unattended, proven nightly-scale).
- *Best-of-n serving:* **does not exist** — `BrainProxy` and `service/brain_client.py` are single-shot; no candidate-ranking path anywhere in serving. The taste ranker's `score_candidate` could serve as the scorer seam.
- *DPO under MLX:* **missing in the installed toolchain** — `mlx_lm lora --help` shows plain LoRA SFT only (no dpo/orpo/train-type flag in mlx-lm 0.31.3) [measured]. Options: mlx-community `mlx-lm-lora`-style forks, a hand-rolled DPO loss on mlx (the GRPO branch already implements per-token logprobs — reusable), or trl+peft on the CUDA box. Note the pre-registered Stage-2 gate (`docs/plans/STAGE2_GATE.md`) requires ≥300 owner labels + ranker rung ≥1 before any DPO pilot; labels are at 84.
- **19. Licensing inventory** [measured where noted]:

| Model / weights | Where used | License (as found) | Commercial? |
|---|---|---|---|
| Qwen3-4B-Instruct-2507-4bit (SFT base, `config.yaml`) | training + local serving column | Apache-2.0 [measured config comment; matches upstream] | ✅ |
| "Qwen3.6-35B-A3B-abliterated-uncensored-mlx-4bit" (18 GB, `~/AI/models/mlx/`) | fallback/experimental LLM | **[could-not-find]** — community "abliterated" derivative; provenance + license unverified | ⚠️ verify before any product use |
| Stable Audio 3 (medium, MLX port at `~/AI/stable-audio-3/optimized/mlx`) | product Tier-B re-imagine | repo LICENSE = MIT (code) [measured]; **weights license not on disk** [could-not-find] — SA weights are historically Stability Community License (revenue-capped commercial) | ⚠️ resolve from the download source |
| RAVE TorchScript ×18 (`~/AI/rave-models`) | optional transform targets (user-installed) | **[could-not-find]** per-model; IRCAM pretrained RAVE models are typically CC-BY-NC | ⚠️ non-commercial risk; product posture is "user drops in their own models" |
| Audiobox-aesthetics 0.0.4 (judges venv) | quality gate/judge only | pip metadata: "Attribution 4.0 International" (CC-BY-4.0) [measured] | ✅ as judge |
| LAION-CLAP 1.1.7 + `630k-audioset-best.pt` (1.7 GB) | embeddings/judge only | pip: "Creative Commons Legal Code" (CC0 for code; ckpt CC-BY-ish) [measured pip; ckpt license could-not-find on disk] | ✅ likely, verify ckpt |
| MuQ 0.1.0 (`OpenMuQ/MuQ-large-msd-iter`) | taste-ranker embeddings (training-side only) | pip License field **empty** [measured]; upstream MuQ is CC-BY-NC-4.0 [inferred from public release] | ⚠️ NC — fine as an internal judge, not shippable |
| Basic Pitch / Whisper / FCPE / g2p-en (service venvs) | transcription/lyrics utilities | Apache-2.0 / MIT / MIT / Apache-2.0 [inferred from upstream, pip-verifiable] | ✅ |
| gpt-5.4-mini + deepseek + xai (cloud brain chain) | product serving brain | API terms; key sealed in bundle (spend-capped by owner) | ✅ contractual |

### F. Catch-all

**20. Material items the questions didn't ask** [measured unless noted]:
- **The owner's active feedback loop is the beat factory, not the LLM lanes.** Six rated packs in ~6 days; keep-rate arc 50%→67%→43%→71%→71%→57%; the newest signal is that the *first frozen-era pack* scored prequential 0.6458 against a 0.65 adoption bar. The next external-planning conversation should treat "taste data accumulation under frozen distribution" as the live program.
- **The two selftest brain-check failures on deployed bundles** (1.1) will recur for anyone gating on `/Applications` runs — the checks assume keyless environments.
- **`verify.py` binary resolution prefers stale local builds** over `/Applications` — cost me a false golden failure tonight; pin `--bin`.
- The **listening room** (owner-facing rating UI) is a plain static server on `127.0.0.1:8188` over `~/mosh-beats`; a fail-closed **ratings watcher** (launchd WatchPaths → auto-build next pack) is written but deliberately **not installed** pending owner go-ahead.
- **Validity-pack verdict now exists** (mean 2.88/6 over 24 clips) and the reward-probe ratings (38 clips, mean 4.21/7) — the two owner-labeled audio validity sets the reward lanes were missing; nobody has yet re-benchmarked any reward model against them [could-not-find such an analysis; cheap: ~an hour with the existing bench harness].
- **Trajectory consent is `false`** on both recorded sessions — any future harvest-to-training path must gate on that flag.

---

## Part 3 — Could-not-determine ledger

| Item | Where I looked | Cheapest resolution |
|---|---|---|
| GRPO runtime logs (rewards/rollouts/curves; Q1–3, 5–6) | `~/Library/Mosh` (≤4 deep), `~/mosh-*`, `/tmp`, `service/sft/.adapters`, PR #176 branch tree | Re-run `service/rl/run_grpo.sh` smoke on the frozen branch (forensics only, ~minutes) |
| Numeric re-check of the "~3% taste spread" | reward code (have it); needs a rollout population | Same smoke run; compute pull-vs-pq spread on its rewards.jsonl |
| v3-final eval score (post-retrain) | `.sft-data/v3-final/` (no eval_results files) | `npm run eval-sft` vs the fused model, ~30 min |
| CUDA box GPU/VRAM | Windows-port docs, scripts | `nvidia-smi` on the box, or ask the owner |
| SA3 *weights* license (repo code is MIT) | `~/AI/stable-audio-3` tree | Check the HF/Stability source the weights were pulled from |
| RAVE per-model licenses; CLAP ckpt license; abliterated-Qwen provenance | model dirs (no license files) | Upstream model cards (IRCAM/acids, LAION HF, the mlx-community upload) |
| Developer ID cert status | this machine | Owner's Apple Developer account |
| Dev-build selftest 1148/1148 confirmation (brain checks) | ran deployed only | one `--selftest` on a dev build (~4 min after build) |
| Windows hardware verification | docs, PROGRESS | `scripts/verify-pc-build.ps1` on the Windows box |
