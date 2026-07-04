# Finish My Song — Full-Arc Roadmap (mumble → own-voice)

> **Status: Strategic roadmap.** Captures the phase plan, the build-vs-fork-vs-wait decisions, and
> the prior-art findings while fresh. **Phase 1 (text lyrics) is the invariant core and is specced
> separately** in `FINISH_MY_SONG_LYRICS_BUILD_SPEC.md`. This doc is *why the arc is sequenced this
> way* + *what to reuse when each phase arrives*. Suggested home: `docs/`.

---

## 0. The thesis

The take is a **specification, not a prompt.** Both prior-art passes converge: **nobody ships the
end-to-end chain** (wordless mumble → auto-written lyrics that scan → re-sung in the artist's own
voice); every sub-capability exists only in isolation. The moat is the **integration + the
constraint-first framing**. The arc is sequenced so **each phase ships value alone** and each later
phase is **purely additive** to the one before.

---

## 1. The phase map (the spine)

| Phase | What | Research risk | Ships value alone | On critical path |
|---|---|---|---|---|
| **1 — Text lyric engine** | Type partial lyric + gaps → engine fills to the cadence | **None** (pure IP) | ✅ | ✅ (the core) |
| **2 — Mumble → skeleton → engine** | Hum/mumble the flow → extract rhythmic skeleton → engine fills. Original "enthusiastic mumble" magic, **no voice synth** | Medium (gibberish→skeleton is noisy) | ✅ | ➖ additive front-end |
| **3 — Own-voice render** | Re-sing the finished lyric in the artist's cloned voice | **High** (CUDA-first, licensing, demo-grade quality) | ✅ | ❌ separate research track |

The load-bearing insight: **every phase produces or consumes the same `LineSpec`.** Phase 2 is a
new *front-end* that emits the `LineSpec` the Phase-1 engine already eats. Phase 3 is a new
*back-end* that renders the finished sheet. **The engine never changes.** That is the payoff of
building the engine spec-first.

---

## 2. Phase 2 — mumble → rhythmic skeleton

Key unlock from the voice research: **the lyric stage only needs the *skeleton*** — syllable count,
onset times, a stress proxy — **not synthesis.** So the mumble can drive the lyric engine without
touching a single render landmine.

Pipeline (mostly on Apple Silicon — MLX/MPS):
1. **Capture** → existing take-lane infra.
2. **Source-separate** (if recorded over the beat) → Demucs-class MSS → clean vocal stem.
3. **F0 contour** → **RMVPE** (robust standard for vocal pitch in noisy/polyphonic material) or **FCPE** (fast, light, Apple-Silicon-friendly). *(CREPE = accurate but heavy; pYIN = clean monophonic.)*
4. **Onsets + syllable nuclei** → spectral-flux onset detection + sonority/energy-peak nucleus detection (~250–2500 Hz band). **The hard novel part:** gibberish has no text, so Montreal Forced Aligner and text-dependent aligners **don't apply** — the skeleton is derived bottom-up from the signal. Nearest prior art: query-by-humming / "la-la" alignment.
5. **Stress proxy** → duration + energy + pitch prominence (REFFLY's prominent-note heuristic).
6. **Emit `LineSpec`** → the *same* contract the Phase-1 engine consumes. Engine untouched.

- [ ] **Human-in-the-loop grid editor** — a "confirm the syllable grid" step. **Non-optional:** the research flags syllable-nucleus detection as noisy / unsolved-as-turnkey, and a mis-counted syllable propagates into a mis-scanned lyric. Ship the skeleton as an *editable proposal*, not ground truth.
- [ ] Runs on-device (FCPE is light; a pure-MLX RVC port exists at ~8.71× MPS — precedent that this class of model runs well on Apple Silicon).
- [ ] **Purely additive** — no change to the Phase-1 engine, commands, or `LineSpec`.

---

## 3. Phase 3 — own-voice render (captured for later, off the critical path)

Re-sing the finished sheet in the artist's voice. The voice research is decisive; capturing it so the decisions aren't re-litigated when this phase arrives.

**Build-vs-fork-vs-wait:**

| Decision | Systems | Why |
|---|---|---|
| **FORK** (open, commercial-safe weights) | **SoulX-Singer** (Apache-2.0, weights license re-verified 2026-07-02) · *(demoted)* **YingMusic-Singer-Plus** | SoulX: score/melody-conditioned zero-shot SVS + a transcription-free SVC variant; ~12 GB VRAM; 24 kHz mono; known risks = English WER 0.151 vs zh 0.065, sustained-note re-articulation (issue #37), melody mode unreliable (#33) → score mode. **YingMusic-Plus licensing CORRECTED 2026-07-02: NOT MIT** — weights CC-BY-4.0 *except the VAE under the Stability AI Community License* (SA3-class encumbrance); the original YingMusic weights are CC-BY-**NC**. Plus also wants a *sung melody clip*, not a score — a mumble-native shape, but a different pipeline. |
| **AVOID as shipping components** | Vevo2 / Vevo1.5 (CC-BY-NC-ND — non-commercial *and* no-derivatives) · Seed-VC (GPL-3.0 copyleft) | Best research quality, but the *weights* licenses are unusable in a closed product. Prototype/benchmark only. **Verify the weights license, not just the code** — Amphion ships MIT code with NC-ND weights (and "MIT" YingMusic proved the same lesson). |
| **SVC fallback (shippable)** | **RVC** (MIT code + MIT bases: lj1995 HF repo incl. ContentVec-variant hubert; VCTK data; verified 2026-07-02) | Own-timbre conversion pass over any generic vocal (SoulX base voice, ACE-Step, or the owner's take); ~10 min clean voice to train a personal clone. |
| **SCRATCH mock** | ACE-Step 1.5 (**MIT**, corrected from "Apache-2.0" 2026-07-02; MLX on Mac) | Instant generic-voice render for "is this line worth finishing?" while the real CUDA job runs. Melody control is cover/reference-audio only (no score). |
| **Closed benchmark** | Seed-Music (ByteDance) | Proves the capability (lyric-edit-preserving-melody + 10s zero-shot SVC); no public weights/API. A quality bar, not a component. |

- **Data needs:** zero-shot 10–30s reference; per-artist clone 10–60 min clean vocals.
- **Failure modes to engineer around:** harmony/backing-vocal leakage, F0 instability, HF spectral artifacts, reverb contamination. Mitigations: stronger separation front-end, F0-perturbation augmentation, dereverb, energy-balanced loss.
- **Where it runs:** **PC-CUDA Tier-B adapter** — these models are CUDA-first; no CoreML/MLX ports exist yet. Fits the existing PC-CUDA service adapter; the Mac stays the host.
- **Consent/rights wall (non-negotiable when this ships):** locked-to-self + watermarked. Someone *will* try to upload Drake.
- **Phased:** 3A zero-shot audition-quality → 3B per-artist fine-tune refinement pass (SoulX-Singer-SVC / RVC-style).
- **Kill-shots (pre-registered 2026-07-02, run before any pipeline code):** [`2026-07-02-fms-killshot-a-verdict.md`](superpowers/specs/2026-07-02-fms-killshot-a-verdict.md) (SoulX English + own-voice on the CUDA box) · [`2026-07-02-fms-killshot-b-verdict.md`](superpowers/specs/2026-07-02-fms-killshot-b-verdict.md) (skeleton quality on real mumble takes; harness `scripts/fms-killshot/`).

---

## 4. Decision log (one table)

| Build | Fork | Wait / avoid |
|---|---|---|
| The mumble→skeleton front-end (Phase 2) + the lyric-constraint engine (Phase 1) — **the moat; nothing off-the-shelf does this** | The render model (Phase 3) via commercial-safe weights: **SoulX-Singer (Apache-2.0)**; YingMusic-Singer-Plus demoted — **NOT MIT** (CC-BY-4.0 + Stability-Community-License VAE, see §3) | NC-ND / GPL weights (Vevo2, Seed-VC) as shipping deps; closed APIs as core deps |

---

## 5. Thresholds that change the plan

- Validator-loop latency/cost too high → **SNU-style trained control tokens** (`<SYL:n>`) for guaranteed counts.
- RAG style too weak ("doesn't sound like me") → **LoRA** on the user's corpus (the type-beat trainer path).
- Need provable structural conformance → **grammar-constrained decoding** on open weights (Outlines / XGrammar / GBNF).
- Gibberish syllable-nucleus accuracy stays low → ship Phase 2 with the **human-in-the-loop grid editor** (already planned).
- An open SVS render relicenses to Apache/MIT **with a CoreML/MLX port** → collapse the Tier-B dependency, run render on-device.
- A commercial API exposes **artist-grade singing** clone + melody-preserving edit → evaluate buy-over-build **for the render stage only**.

---

## 6. Parked / out of scope

- **Arrangement spice** (tape-stop intro, pitched-down intro, section fills) — leans on the existing re-imagine render layer; later.
- **Radio-ready mix/master.**

---

## 7. Consolidated risks

- **Quality ceiling is real** — zero-shot SVC on professionally-produced material is demo-grade (harmony leakage, F0 jitter, HF artifacts). A per-artist fine-tune narrows but doesn't close the gap.
- **Gibberish alignment is unsolved as a turnkey component** — budget iteration + the human-in-the-loop editor.
- **Licensing is a landmine** — verify *weights* licenses, not just code; only MIT/Apache are safe.
- **Constraint-pass ≠ quality** (Deep-speare, ACL 2018) — don't optimize only the automatic metrics; keep human eval in the loop.
- **Commercial frontier moves** — re-validate any external API before depending on it.
