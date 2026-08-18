# Finish My Song — Lyrics v1 Build Spec

> **⏸️ Finish-My-Song development is PAUSED 2026-08-11, indefinitely** — see
> `FINISH_MY_SONG_ROADMAP.md` for why and the bar to reopen. v1 (this doc) shipped and is
> live in the app already; this is a stop on further investment, not a rollback. Do not
> start new work here without the owner reopening it.

> **Status: Build-ready.** Implementation spec for **v1 = text-first lyric completion** — the
> invariant core under every later phase. Supersedes the scoping spec
> (`FINISH_MY_SONG_LYRICS_SPEC.md`) on *implementation detail*; read that first for the *why*. The
> full mumble→own-voice arc lives in `FINISH_MY_SONG_ROADMAP.md`. Suggested home: `docs/`.

---

## 0. What the research changed

Two prior-art passes (lyric-completion + voice-pipeline) converged on three things that lock this spec:

1. **Assemble, don't fork.** No end-to-end product/repo completes a *partial* lyric to a *fixed cadence*. The closest research systems — **REFFLY** (NAACL 2025, arXiv 2409.00292, the "revise a draft to fit constraints" framing) and the **SNU syllable-control + infilling** paper (Interspeech 2025, arXiv 2411.13100) — are templates to study, not code to wrap.
2. **The architecture is a validator loop, not a smarter prompt.** Raw LLMs cannot count — GPT-4 reportedly hits only **~57.6%** on syllable counting (PhonologyBench, ACL 2024), because subword tokenization hides phonology. Every system that gets exact counts uses external machinery. So a deterministic phonology layer is the **source of truth**; the LLM proposes; a **generate → check → repair** loop drives constraint satisfaction toward ~100% *by construction*.
3. **The stack is now chosen** (§2), and the engine only ever consumes a `LineSpec` (§3) — which is why Phase 2 (mumble→skeleton) and Phase 3 (voice) are purely additive and never touch this engine.

---

## 1. The architecture in one line

> A **deterministic phonology validator** wrapped around a **general LLM** in a
> **generate → check → repair** loop. The LLM proposes lines; `pronouncing`/`g2p` is the source of
> truth for syllables, stress, and rhyme; failing lines are repaired or resampled. Same
> `propose → validate → commit` shape MoshOps already uses everywhere.

```
LineSpec ──► [ propose: LLM via BrainProxy ] ──► candidate
                        ▲                            │
                        │                            ▼
              repair (specific diagnostic)   [ check: phonology judge ]
                        │                            │
                        └──────── fail ◄─────────────┤
                                                pass ▼
                                          rank → top-N proposals
```

---

## 2. Component stack (chosen)

| Component | Pick | Role | Runs |
|---|---|---|---|
| Syllables / stress / perfect rhyme | **`pronouncing`** (CMUdict) | gold standard in-dictionary | native + service |
| Slant / assonance / consonance | **`Phyme`** + **Datamuse** `rel_nry`,`rel_cns` | graded near-rhyme | service (Datamuse = free, no key) |
| OOV / slang / names g2p | **`g2p-en`** (+ `phonemizer`/eSpeak-ng fallback) | dictionary-miss fallback (non-optional for rap) | service |
| Topic-constrained rhyme candidates | **Datamuse** `ml=` + `topics=` | "rhymes with X *and* about Y" in one call | service |
| Full metrical scansion (optional) | **`prosodic`** | stress/meter detection, scheme naming | service |
| Rhyme-scheme detection (eval) | **RhymeTagger** | scheme tagging for tests | CI |
| Rhyme-density metric | implement from **DopeLearning** (~30 lines over ARPAbet vowels) | automatic rhyme-quality score | service / CI |
| LLM (proposer) | via **`BrainProxy`** (deepseek/openai/xai) | candidate generation | service → brain proxy |
| Style RAG | **LyricsGenius** scrape → embed → retrieve | "sounds like me" | service |

> The phonology core is small + deterministic, so **embed a copy native/client-side** for *instant*
> UI features (rhyme lookup, live syllable meter) and run the **same dictionary in the service** for
> generation-time validation. One source of truth, two call sites.

Stale-but-usable warning: `Phyme` (2018) and `pincelate` are alpha/unmaintained — budget minor fixups. CMUdict tools miss OOV → always wire the g2p fallback.

---

## 3. Phase 1 — the constraint judge (build first, no LLM)

The keystone: deterministic pass/fail + diagnostics, reusable under every LLM and every later phase. Ships on its own as `get_rhymes` / the Rhyme Tool.

**The `LineSpec`** — the contract every input path produces and the engine consumes (Phase 2 will emit this same shape from audio):

```jsonc
{
  "bpm": 142, "grid": "1/16",
  "lines": [
    {
      "role": "verse",                       // verse | hook | bridge | adlib
      "syllables": { "target": 9, "tol": 1 },
      "stress": "x X x x x X x x x",          // X = stressed, x = unstressed, ? = free
      "rhyme_group": "A",                     // lines sharing a group must rhyme
      "rhyme_strictness": "slant",            // perfect | slant | free
      "locked": [ { "pos": 8, "word": "flame" } ],     // hard-fixed tokens / positions
      "seed_text": "yeah I came back ___ ___ the ___",  // ___ = gap
      "topic": "comeback after being counted out",
      "mood": "defiant",
      "explicit": "allow"                     // allow | clean | mild
    }
  ],
  "style_ref": "user_corpus:emilio"           // optional RAG handle (§5)
}
```

**The judge interface:**

```
judge(line_spec, candidate_text) -> {
  pass: bool,
  syllables: { count, target, ok },
  stress:    { pattern, target, ok, distance },
  rhyme:     { group, score: 0..1, kind: perfect|slant|none, ok },
  locked:    { ok, missing: [...] },
  diagnostics: ["10 syllables, need 9 — trim one", ...]   // fed back to the LLM on repair
}
```

Checklist:
- [ ] Vendor CMUdict + `pronouncing` (syllables / stress / perfect rhyme).
- [ ] g2p fallback (`g2p-en`) for OOV — non-optional for rap.
- [ ] Graded rhyme scorer over the **rime** (perfect → slant → none), phoneme-based **never spelling-based** (`Phyme` + Datamuse for slant).
- [ ] Stress-contour matcher with tolerance.
- [ ] Locked-word/position check.
- [ ] DopeLearning rhyme-density scorer.
- [ ] Golden test set (known counts / stresses / rhyme pairs incl. slant); deterministic; **run 3×**.

---

## 4. Phase 2 — the generation loop

Two techniques from the research baked in: **reverse generation** (rhyme word first — DeepRapper, ACL 2021) and **generate-and-check + repair** (the validator loop).

Per gap/line:
1. **(optional) Lock the rhyme word first.** Query the phonology layer for end-word candidates fitting *topic* (Datamuse `ml=`) + *rhyme group* (`rel_nry`) + *syllable budget*. Pick one (or let the user). The DeepRapper reverse trick — guarantees the landing.
2. **Propose.** Prompt the LLM (via `BrainProxy`) with: surrounding real words, the `LineSpec` (count, stress, locked words, the chosen end-word), topic/mood, and RAG-retrieved style exemplars.
3. **Check.** Run the judge.
4. **Repair / resample.** On fail, re-prompt with the *specific* diagnostic ("10 syllables, need 9 — trim one") or resample. Cap attempts at *N*, then **gracefully relax the slant threshold** rather than failing.
5. **Rank + return top-N** proposals (not one answer) — rhyme quality, naturalness, distance-from-cliché, style fit.

Proposer prompt skeleton (concrete):
```
You are completing a rap verse. Fill ONLY the gaps (___).
Hard constraints for this line:
  • exactly {target} syllables (±{tol})
  • stress pattern: {stress}
  • the last word must be: {locked_end_word}
  • keep these fixed words at their positions: {locked}
Context (lines already written): {neighbors}
Topic: {topic}   Mood: {mood}
Write in this artist's style — examples of their lines:
{rag_exemplars}
Return 4 candidates, one per line, nothing else.
```

Decisions:
- [ ] **RAG + the validator loop for v1 — NOT fine-tuning.** The validator guarantees fit; a strong general model supplies fluency. Defer SNU-style `<SYL:n>` control tokens and LoRA until you hit a quality ceiling and have data.
- [ ] LLM access routes through `BrainProxy` (one key story across the app).
- [ ] Generation is a **service job** (`GenerativeJobManager` async pattern, `localhost:8770`) — never on the audio thread. Phonology-only calls (`get_rhymes`) run in-process/native for instant response.

---

## 5. Style conditioning — RAG (the anti-slop lever)

- [ ] Scrape the user's catalog with **LyricsGenius**; index lines/verses.
- [ ] Retrieve top-k stylistically/semantically similar lines as few-shot exemplars in the proposer prompt.
- [ ] **Hard rule:** generation + RAG filtered against near-verbatim matches to third-party catalogs; corpus is the **user's own** material only.
- [ ] On-ramp to the existing type-beat **LoRA** path (`docs/type-beat-trainer.md`) — RAG ships now with no training; LoRA is the v2 depth pass.

---

## 6. MoshOps command surface

Each follows the law: **validate → one undo txn → mutate the lyric doc → JSONL line → emit events → result envelope.** The lyric sheet is project state (ValueTree under `src/state`), flows through `snapshot()`, attaches to a clip/track.

- [ ] `complete_lyrics` — fill all gaps in a section → proposals.
- [ ] `suggest_next_line` — single-bar ghost (engine, 1-line horizon).
- [ ] `fill_lyric_gap` — fill one bounded hole.
- [ ] `get_rhymes` — phonology-core only; **fast, in-process**; agent- + UI-callable.
- [ ] `set_lyric_line` / `set_lyric_section_role` / `set_lyric_constraint`. *(As shipped: per-line
  role is folded into `set_lyric_line`'s `role` arg — there is no separate `set_lyric_section_role`
  command; song-section roles are the separate `create_section`/`rename_section` ribbon feature.)*
- [ ] `accept_lyric_proposal` / `reject_lyric_proposal` / `regenerate_lyric` — the review envelope (mirrors render-layer accept/reject).
- [ ] Register in `commands.contract.test.ts`; add `--selftest` + `--selftest-undo` coverage; pass `validate-command-log-contract.sh`.
- [ ] **Agent exposure:** `complete_lyrics`, `suggest_next_line`, `fill_lyric_gap`, `get_rhymes` → Moshi-callable. Corpus/provider config → backend-only.

Two execution paths:
- **Heavy (generation):** UI → WebBridge → MoshOps → service job → poll → events.
- **Instant (phonology):** UI → WebBridge → MoshOps → in-process phonology → result. (No round-trip; powers the live meter + rhyme tool.)

---

## 7. UI surface + the shippable ladder

Pure client (view state stays UI-local). In the default **v2 shell**:
- [ ] Lyric panel/drawer.
- [ ] **Flow meter** — syllable slots drawn against the bar grid (the visible "does it fit the beat").
- [ ] Gap markers + lock-a-word affordance.
- [ ] **Proposal review** — A/B the top-N, accept / reject / regenerate (mirror render-layer UX).
- [ ] **Inline ghost line** — greyed next-bar suggestion, tab-to-accept.

---

## 8. Verification (your conventions)

- [ ] **Constraint judge:** unit tests vs the golden set (syllable / stress / rhyme incl. slant); deterministic; **run 3×**.
- [ ] **Generation:** a **validator pass-rate** metric (% of returned lines meeting *all* hard constraints) over golden seeds — the automatable floor. Benchmark vs the raw-LLM baseline (~57.6% syllable accuracy); you should approach ~100% by construction.
- [ ] Track rhyme density (DopeLearning), syllable-match rate, meter accuracy.
- [ ] **MoshOps:** `--selftest`, `--selftest-undo`, command-log contract, `commands.contract.test.ts`.
- [ ] **UI:** vitest + Playwright for the panel/review flow.
- [ ] **Honest gap:** "are these lyrics *good* / do they sound like me" is a **taste gate**, not automatable — Deep-speare (ACL 2018) showed meter/rhyme can be near-perfect while expert-judged quality lags. Treat like your audio A/B gates: human eval, saved evidence. **Pass-rate proves *fit*, not *quality*.**

---

## 9. Build order (the rungs — each ships value, each a strict subset)

0. [ ] **Constraint judge + golden set** (no LLM). → ships as `get_rhymes` / the Rhyme Tool.
1. [ ] **Flow / syllable visualizer** — proves grid alignment; lays the groundwork the Phase-2 skeleton reuses.
2. [ ] **Ghost line** — single-line generate → check → repair.
3. [ ] **Gap-fill** — bounded span.
4. [ ] **Finish the verse/section** — the full v1 feature.

→ then **Phase 2** (`FINISH_MY_SONG_ROADMAP.md`): the mumble→skeleton front-end that emits the *same* `LineSpec`.

---

## 10. Open forks (the few left — decide at implementation)

1. **Gap syntax** — `___` blanks vs per-bar `[8 syll, rhyme A]` tags vs type-what-you-have + infer. *(Lean: blanks + grid-inferred counts.)*
2. **Default rhyme strictness** — default **slant** for rap; let users tighten.
3. **Lyric doc attachment** — per-clip (travels with a take) vs per-track vs project sheet.
4. **Proposer provider** — cost / quality / latency per call via `BrainProxy`.
