# Finish My Song — Lyric Completion (v1 Spec)

> **This is the "why" (scope) doc.** For the **"how" (implementation)**, read
> [FINISH_MY_SONG_LYRICS_BUILD_SPEC.md](FINISH_MY_SONG_LYRICS_BUILD_SPEC.md) — it supersedes this on
> implementation detail. The full mumble→own-voice arc is in
> [FINISH_MY_SONG_ROADMAP.md](FINISH_MY_SONG_ROADMAP.md). **Status (2026-06-28): v1 shipped on `main`**
> (L0–L3 + L1 + §7 + Bar-IQ via #174/#178); Phase 2 (mumble→skeleton) is the active build.

> **Status: Proposed.** Scope locked to **lyrics only** (the writing). Voice synthesis,
> arrangement "spice" (tape-stop / pitched-down intros, section fills), and full master are
> **explicitly out of v1** and parked below. This spec is architecture-native to Mosh: the engine
> runs as a Tier-B service job, every mutation crosses the MoshOps seam, the UI is a pure client.
> Suggested home: `docs/` (peer to the `plans/wave-*` specs) — assign a number when you place it.

---

## 0. The one idea this rests on

The partial take is a **specification, not a placeholder.** A producer who's out of gas has
already laid down the hard part — the *flow*: how many syllables per bar, where the stresses land,
which words are locked (especially rhyme words), the topic. The engine's only job is to fill the
gaps **subject to those constraints** while sounding like the writer.

That constraint is *why this can be good instead of slop.* "Write a verse about X" is unbounded;
"write 9 syllables, stress on 2 and 6, ending on a slant rhyme for *flame*, in my vocabulary" is a
solvable, checkable problem. This is the same shape MoshOps already uses everywhere:
**propose → validate → commit.** Build it that way.

---

## 1. Scope

**In (v1):** complete the lyric to a finished, performable sheet, aligned to the beat grid,
returned as reviewable proposals.

**Out (parked, named so they're not lost):**
- Voice synthesis / singing clone — the uncanny-valley + consent-wall problem; survey models fresh when you reach it.
- Arrangement spice (tape-stop intro, pitched-down intro, section fills) — leans on the existing re-imagine layer; later.
- Radio-ready mix/master.

---

## 2. Assumptions (the forks I locked — push back on any)

| # | Assumption | Why | If wrong |
|---|---|---|---|
| **A1** | **v1 input = structured text + the beat grid.** The audio mumble take is **Phase 3**, on the *same* engine. | Audio→constraint extraction (onsets, stress, ASR on non-words) is a separable **research risk**. The engine is pure IP and shouldn't wait on it. | If you want the mumble take *in* v1, Phase 3 moves up and §6's parser grows an MIR front-end — engine unchanged. |
| **A2** | **Primary target = rap / melodic rap** (slant-rhyme tolerant). | Where the audience is, the *more* tractable target, and dense internal rhyme is where the constraint engine looks like magic. | Sung target tightens rhyme/meter rules and adds pitch-target data later. |
| **A3** | **Output = reviewable proposals** (accept / reject / regenerate), non-destructive. | Mirrors the render-layer ethos; keeps the human in the chair (the positioning shield). | If you want one-shot overwrite, drop the proposal envelope (not recommended). |
| **A4** | **The lyric sheet is project state** — flows through `snapshot()`, attaches to a track/clip. | So it's undoable, logged, agent-visible, and survives save. | — |

---

## 3. Where it lives (the stack)

```
UI lyric panel (ui/)              ── pure client, view-state local
   │  execute_command / snapshot + events   (THE SEAM)
   ▼
MoshOps (src/moshops)             ── complete_lyrics, get_rhymes, fill_lyric_gap, …
   │   validate → 1 undo txn → mutate lyric doc → JSONL → events → result
   ▼
Lyric engine (service/, Python)   ── Tier-B job over localhost:8770, like SA3
   │   propose → validate → retry → rank
   ├─ Phonology core (cmudict + pronouncing + g2p)   ← the deterministic IP
   └─ LLM (reuse brain-proxy providers/keys: deepseek/openai/xai)
```

Two placements worth calling out:

- **The phonology core is small (~few MB) and deterministic, so it lives in two places from one
  source of truth:** embedded client-side/native for **instant** live features (rhyme lookup,
  syllable meter as you type — zero round-trip), and in the service for generation-time validation.
  Same dictionary + rules, two call sites.
- **Generation is a job, not a keystroke** — it belongs in `service/` behind the existing async job
  pattern, never on the audio thread. The tier wall holds.

---

## 4. Phase 1 — the phonology core (the actual IP)

Deterministic, testable in isolation, no LLM. This is what makes everything else possible and is
the first thing to build.

- [ ] Vendor **CMUdict** + the `pronouncing` library (syllable count, stress string, phoneme list, rhyme part).
- [ ] Add a **g2p fallback** (`g2p-en` / `phonemizer`) for out-of-vocabulary words — **non-optional for rap** (slang, ad-libs, names are mostly OOV).
- [ ] **Syllable counter** from phonemes (count vowel phonemes), routing unknown tokens through g2p.
- [ ] **Stress extractor** → per-word stress (0/1/2) → line-level stress contour.
- [ ] **Rhyme scorer over the rime** (final stressed vowel + coda), graded: perfect → slant (assonance / consonance) → none. Phoneme-based, **never spelling-based** ("love/move" must not rhyme; "orange/door-hinge" should slant).
- [ ] Rhyme **search**: word/constraints → ranked candidates, filterable by syllable count + part of speech.
- [ ] Golden test set (known syllable counts, stresses, rhyme pairs incl. slant) — deterministic, run 3×.

> Ships on its own as the **Rhyme Tool** (§9 ladder, rung 1) before any LLM exists.

---

## 5. The constraint spec (the contract)

The data structure every input path produces and the generator consumes. Getting this right
decouples *how we read the seed* from *how we generate*.

```jsonc
{
  "bpm": 142, "grid": "1/16",
  "lines": [
    {
      "role": "verse",                       // verse | hook | bridge | adlib
      "syllables": { "target": 9, "tol": 1 },
      "stress": "x X x x x X x x x",          // X = stressed slot, x = unstressed, ? = free
      "rhyme_group": "A",                     // lines sharing a group must rhyme
      "rhyme_strictness": "slant",            // perfect | slant | free
      "locked": [ { "pos": 8, "word": "flame" } ],   // hard-fixed tokens / positions
      "seed_text": "yeah I came back ___ ___ the ___", // partial; ___ = gap
      "topic": "comeback after being counted out",
      "mood": "defiant",
      "explicit": "allow"                     // allow | clean | mild
    }
  ],
  "style_ref": "user_corpus:emilio"           // optional RAG handle (§7)
}
```

- [ ] Define + **version** this schema (it's effectively a mini-contract, like the MoshOps result envelope).
- [ ] Beat grid supplies **default** `syllables.target` per bar (bars × grid density) so the user can leave it blank.
- [ ] Per-line overrides win over grid defaults.

---

## 6. Phase 2 — the generation loop

The propose-validate-retry loop. This is where "LLM + phonology" beats "LLM alone."

- [ ] **Parse seed → constraint spec** (text path: gap syntax + grid; audio path deferred to Phase 3).
- [ ] **Propose**: LLM generates candidate line(s) given constraints + style context. The prompt carries locked words/positions, syllable target, stress contour, the rhyme group's already-chosen end-words, topic/mood, and retrieved style snippets.
- [ ] **Validate** each candidate against the **phonology core** — syllable count within tol, stress within tolerance, rhyme score ≥ threshold for its strictness, locked words present at position.
- [ ] **Retry / repair**: reject failures, re-prompt with the *specific* failure ("10 syllables, need 9 — trim one"), or use **constrained decoding** to bias toward valid completions. Budget the retries (N attempts → best-effort + flag).
- [ ] **Rank** survivors: rhyme quality, naturalness, distance-from-cliché, fit to style. Return **top-N** (proposals, not one answer).
- [ ] **Decision: RAG + constrained generation for v1, not fine-tuning.** Wrap a strong general model; the phonology validator is what guarantees fit. Revisit a fine-tune / your **LoRA** path only after you hit a quality ceiling and have data. Don't pre-spend the fine-tune.
- [ ] **LLM access:** route through the **brain proxy's** providers/keys for one consistent key story across the app.

---

## 7. "Sounds like me" — style RAG (the anti-slop flywheel)

The single biggest lever against "AI lyrics are generic." Opt-in.

- [ ] User lyric **corpus** (past sheets / pasted bars) → embedded + retrievable.
- [ ] Retrieval biases vocabulary, rhyme habits, recurring themes, line length.
- [ ] **Hard rule:** RAG must **not** regurgitate third-party copyrighted lyrics. Corpus is the **user's own** material; filter/flag near-verbatim matches to known catalogs (see §10).
- [ ] This is the on-ramp to the LoRA "learns your sound" story — RAG first because it ships now and needs no training.

---

## 8. MoshOps command surface

Each command follows the law: **validate → one undo txn → mutate the lyric doc → JSONL line →
emit events → result envelope.**

- [ ] `complete_lyrics` — fill all gaps in a section, return proposals.
- [ ] `suggest_next_line` — single-bar ghost suggestion (engine on a 1-line horizon).
- [ ] `fill_lyric_gap` — fill one bounded hole.
- [ ] `get_rhymes` — phonology-core only; fast; agent- and UI-callable.
- [ ] `set_lyric_line` / `set_lyric_section_role` / `set_lyric_constraint` — edit doc + constraints.
- [ ] `accept_lyric_proposal` / `reject_lyric_proposal` / `regenerate_lyric` — the review envelope.
- [ ] Register all in `commands.contract.test.ts` (so the agent catalog can't drift) and add `--selftest` coverage.
- [ ] **Agent exposure:** `complete_lyrics`, `suggest_next_line`, `fill_lyric_gap`, `get_rhymes` → Moshi-callable. Corpus management / provider config → backend-only (the safety wall).

---

## 9. UI surface (default v2 shell) + the ladder

Pure client. View state (focused line, panel open) stays local — not commands.

- [ ] **Lyric panel/drawer** in the default **v2 shell**.
- [ ] **Flow meter**: syllable slots drawn against the bar grid — the visible "does this fit the beat" view.
- [ ] **Gap markers** in the editor; a lock-a-word affordance.
- [ ] **Proposal review**: A/B the returns, accept / reject / regenerate (mirror render-layer UX).
- [ ] **Inline ghost line** (greyed next-bar suggestion, tab-to-accept).

**Ship value before the moonshot — each rung is a strict subset of the next:**

1. [ ] **Rhyme tool** — phonology core only, *no LLM*. Proves the core, useful day one.
2. [ ] **Flow / syllable visualizer** — proves grid alignment; lays groundwork for Phase-3 extraction.
3. [ ] **Ghost lines** — next-bar suggestion (engine, 1-line horizon).
4. [ ] **Gap-fill** — fill a hole in a verse (engine, bounded span).
5. [ ] **Finish the section / verse** — the full feature.

→ then **Phase 3: audio mumble-take front-end** — onsets via the known tempo grid +
confidence-thresholded ASR for the real words → auto-builds the constraint spec. This is where the
original "enthusiastic mumble" magic lands, *on the engine you already proved.*

---

## 10. Safety / rights

- [ ] **Explicit-content** control per A1's `explicit` field + a global filter.
- [ ] **No copyrighted-lyric reproduction** — generation *and* RAG filtered against near-verbatim matches to known catalogs; corpus is user-owned only.
- [ ] **Voice-clone consent wall** — parked *with* synthesis, noted here so it isn't forgotten in that phase (locked-to-self + watermark, non-negotiable then).

---

## 11. Verification (your conventions)

- [ ] **Phonology core**: deterministic unit tests vs the golden set (syllable / stress / rhyme incl. slant); run 3×.
- [ ] **Generation loop**: a **validator pass-rate** metric (% of returned lines meeting all hard constraints) over golden seeds — your automatable quality *floor*.
- [ ] **MoshOps**: `--selftest` coverage for new commands, `--selftest-undo`, `validate-command-log-contract.sh`, `commands.contract.test.ts`.
- [ ] **UI**: vitest + Playwright for the panel / review flow.
- [ ] **Honest gap:** "are these lyrics *good* / do they sound like me" is a **taste gate**, not automatable — treat like your audio A/B gates (human eval, saved evidence). Pass-rate proves *fit*, not *quality*; only ears prove quality.

---

## 12. Open forks (back to you)

1. **Gap syntax for v1** — `___` blanks? per-bar `[8 syll, rhyme A]` tags? type-the-words-you-have + auto-infer the rest? (Lowest-friction wins; I lean **blanks + grid-inferred counts**.)
2. **Default rhyme strictness** — I'd default **slant** for rap and let users tighten.
3. **Where the lyric doc attaches** — per-clip (travels with a take) vs per-track vs project-level sheet?
4. **Which provider** for generation via the brain proxy (cost / quality / latency per call).
