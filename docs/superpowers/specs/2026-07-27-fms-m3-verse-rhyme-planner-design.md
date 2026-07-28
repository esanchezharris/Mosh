# FMS M3 — verse-level rhyme planner (design)

*2026-07-27. Bar frozen before any number is read, per program convention.*

## 1. Problem, and the evidence for it

I3a measured the same split twice and got the same answer both times: a dictionary
out-rhymes a language model, and the language model out-*means* the dictionary.

| arm | exact | rhyme_perfect | multi_depth |
|---|---|---|---|
| `rhyme-floor` v2 (pure phonology, n=400) | 10.9% | 93.0% | 1.14 |
| `llm-constrained` v1 (n=150) | 38.4% | 35.3% | 0.83 |
| `prompt-rhyme-menu` v1 (n=150) | 32.2% | 52.1% | 0.94 |

The owner's sitting 5 read the same gap by ear: the artist's real word "works" 86%
of the time, a formally-perfect phonology rhyme 29% — **+57 points on works, +71 on
keep**. And `prompt-rhyme-menu` shows the naive fusion does not work: putting the
menu in the *generation* prompt moved `rhyme_perfect` +16.7 points and moved
`exact` **down**, because it anchored the model onto dictionary rhymes.

Nothing in the arm set fuses the two. The planner is that fusion moved to verse
scale: phonology proposes a small ranked set of anchors up front, the model writes
meaning *around* a chosen anchor, and the decoder enforces landing on it.

**Pre-registered honesty, before any number exists.** A pure-phonology anchor
ranker *is* `rhyme-floor` promoted to verse scale, and the floor's output is
already on record as not working. The planner's value proposition is therefore
**not** "picks a better word". It is: *narrow an open-vocabulary decision to a
small, deterministic, user-editable set that the model then writes meaning around.*
If the first measurement is read as "phonology ranking doesn't beat the LLM", that
is a result already on the board, not a new finding.

## 2. Data-model delta

Two additions, deliberately on opposite sides of the persist/transient line the
sheet already draws.

**`lyricRhymeAnchor`** — new per-line `MOSH_DECLARE_ID` in `src/state/Ids.h`,
beside `lyricRhymeGroup` / `lyricRhymeStrictness`. String; `""` ⇒ auto/unset.
Persisted, undoable, user-editable, defaulted in `mosh::LyricLine::create`.
**It MUST join `LyricSheet::lineFingerprint`** (`src/state/Lyrics.h:79`).

**`lyricAnchorPlan`** — new sheet-level id. Transient, non-undoable, recomputable
— the exact posture of `lyricAnalysis` and `lyricProposals`. JSON blob:

```json
{"v":1,"groups":{"A":{"seed":"…","fixed":true,"strictness":"slant",
                      "candidates":[{"word":"…","syllables":1,"grade":"perfect",
                                     "depth":2,"freq":812,"score":0.71}]}},
 "ungrouped":[3,7]}
```

### Why NOT `lyricScore`

`src/state/Ids.h:161-167` documents `lyricScore` as the persisted render-ready
articulation score from the take, and says in as many words: *"NOT a generation
constraint — excluded from `lineFingerprint`"*. Putting an anchor there would

1. mix take truth with generation constraint,
2. **silently escape `lineFingerprint`**, so editing an anchor would not
   invalidate cached proposals — the failure would look like "the model ignored
   my edit", and
3. collide with the `hasScore` boolean the sing drawer counts
   (`MoshOps.cpp:1703`, `Dock.tsx:575`).

Fingerprint membership is exactly the test for which side of the line a field
belongs on. `lyricScore` fails it; `lyricRhymeGroup` passes it; so does the anchor.
Recorded here because this will be proposed again.

## 3. Command registrations: **zero**

Verified against the tree, not assumed:

- **Write** — `set_lyric_line` (dispatch `MoshOps.cpp:1091`, handler `:1537`)
  already takes an open bag of optional per-line constraint args, and is already
  Track-scoped at `src/multiplayer/LockManager.cpp:72`. `rhymeAnchor` is one more
  `if (args.hasProperty(...))` branch plus one entry in the existing `args` array
  at `ui/src/agent/commands.ts:165`. Both are edits to registered things, not new
  registrations.
- **Propose** — `analyze_lyrics` (dispatch `:1102`, scoped at `LockManager.cpp:77`)
  is already the "phonology computes deterministically, transient blob lands, no
  LLM" command. It gains `anchorPlan` in its result envelope.
- **Read** — `lyricSpecForTrack` (`MoshOps.cpp:1738`) emits `rhymeAnchor` per line
  so `lyrics.core` sees it; the snapshot builder (`:1680`) emits it too;
  `ui/src/types.ts` gets `rhymeAnchor?: string` and `anchorPlan?`. Data layer only
  — **no UI wiring in M3**.

A dedicated `plan_rhyme_anchors` command would cost the full three registrations
(dispatch + `commandClassification.ts`/agent catalog + a lock scope pinned in
`tests/test_multiplayer_lock_manager.cpp`). Not worth it: `analyze_lyrics` already
has this exact shape.

## 4. `plan_anchors`

New module `service/lyrics/planner.py` — not `phonology/core.py` (which stays
LineSpec-agnostic) and not `lyrics/core.py` (which stays free of the bench's
frequency table).

```python
def plan_anchors(spec, *, per_group=8, freq=None, pronouncer=None) -> dict
```

Returns `{"ok":True, "groups":{…}, "ungrouped":[…]}`. Pure phonology,
deterministic, no LLM, no network.

**Seeding** reuses `core._group_anchors(by_index)` *verbatim*, so the planner and
the generation loop can never disagree about which word anchors a group — the same
reason `_analyze_line` reuses `_evaluate`. A group with no fixed end word seeds
from `core._topic_ends(spec)` or the highest-frequency content word in the group's
seed texts.

**Candidates** come from `Pronouncer.rhyme_search(seed, strictness, max_n=200)`.

**Ranking terms**, each with its reason:

| term | why |
|---|---|
| `multisyllabic_depth` vs the seed | the craft axis; already a scoreboard column |
| perfect > slant | already `rhyme_search`'s primary sort |
| **log** corpus frequency | plausibility, NOT a maximand — raw frequency ranking answers *been, an, a, they, but* (PROGRAM.md 2026-07-26). Reuse `mask.STOP_AND_FILLER` and arms.py's `len(w)>=3` filter; import them, do not re-derive, or the two drift |
| syllable fit vs the line's REMAINING budget | a 4-syllable anchor cannot end a bar with 5 syllables left |
| rime-family diversity cap | so the 8 returned are not 8 spellings of one sound |

## 5. Anchor semantics: a fixed end word, via a third state

`_evaluate` (`core.py:159`) branches materially:

- `_fixed_end_word(line)` non-null → prompt says *must END on the word "X"*, **and
  `must_rhyme = anchor is not None and fixed is None` makes the rhyme check
  vanish**, with `grade` hardcoded to `"anchor"`.
- fixed null, anchor non-null → *must end on a {strict} rhyme with "{anchor}"*,
  and `rhymes(end, anchor, strict)` is enforced.

**Decision: the planned anchor is a fixed end word, one per line, drawn from the
group's ranked list.** Three reasons: (1) "a decoder-level constraint enforces
landing on it" is only formulable against a *word* — you cannot enforce an
equivalence class at the decoder without phoneme-level beam control; (2) it turns
the model's job from recall into composition, the direction the evidence points;
(3) it is the only version with a coherent user contract — pick "gold", the bar
ends on "gold". Under rhyme-target semantics an anchor edit nudges a sound class
and the output is unpredictable, which is worse than no field at all.

**Do NOT implement it by writing the anchor into `seedText` or `text`.** That
makes `_fixed_end_word` return it, which makes `_group_anchors` adopt it as the
group anchor, which sets `must_rhyme = False` for **every line in the group** —
silently turning the phonology gate into a no-op across the whole verse. This
design is one careless commit away from that bug; it is written down so the commit
is caught in review.

Instead, a third state:

- `_fixed_end_word` unchanged (the producer's lock — highest precedence).
- new `_planned_end_word(line)` reads `line["rhymeAnchor"]`.
- `_build_messages` precedence: **producer-fixed > planned > group rhyme target**;
  the planned case emits the same *must END on the word "X"* sentence.
- `_evaluate` gains a distinct **`endWordOk`** gate: with a planned anchor,
  `end.lower() == planned.lower()` is required and contributes to `passes`, while
  `grade` still reports the honest `rhyme_grade(end, group_seed)` rather than the
  `"anchor"` shortcut — so analysis and the scoreboard keep seeing real rhyme
  quality.
- `_failure_reason` gains: *the line must end on the word "X", not "{endWord}"*,
  feeding the existing 3-attempt re-prompt loop.
- `_analyze_line` (`core.py:414`) needs the same third state, or the flow
  visualizer disagrees with the loop — the divergence its own comment warns about.

## 6. Enforcement scope

M3 ships **validator-level** enforcement: propose → `endWordOk` → re-prompt with
the specific failure → deterministic repair via `_assemble` (substitute the anchor
as the final word, re-check syllables).

True **decoder-level** enforcement needs logit access. `brain_client.chat_json` is
a stdlib urllib POST to `/chat/completions` with `response_format: json_object` —
there is no logit-bias, grammar, or beam seam on the API path. It is reachable
only through the M1/M2 local backend, where `local-constrained-endword` already
enforces exactly this constraint at one slot. Wiring the planner's per-line anchor
into that arm is the natural M3+M2 join, and it is **out of scope here**.

## 7. Invalidation

Anchor edits dirty the line through `lineFingerprint` (§2). The plan blob does not
participate — it is recomputable, like `lyricAnalysis`.

## 8. Pre-registered bar

The rhyme-word `exact` metric does **not** apply at verse scale: `constrained_fit`
reads 100.0 for the shipped loop at line granularity, which is why the program
pivoted away from line-level in the first place. Proposed instead:

1. **`endWordOk` landing rate** — did the bar end where the plan said.
2. **`multi_depth` vs the PREVIOUS BEST ARM** — not vs the floor. The floor
   optimizes depth by construction; demanding arms match it was the mis-specified
   clause the I3a verdict already corrected.
3. **Owner acceptability, ~15 pairs** on the retained I2c page — which PROGRAM.md
   describes as the right residual use of that instrument.

A change that lifts (1) or (2) while (3) is flat or down is dead, per the standing
rule that keep-rate decides.

## 9. Data policy

Anchors derived from a corpus-conditioned spec are corpus-derived. Plans stay
under `{data_root}`; no anchor word from third-party lyrics enters a fixture, a
commit message, or PR text.

## 10. Test plan

Hermetic, system python3, fake backend, injected `_testlex` lexicon.

- `planner_test.py` — determinism; stopword/short-token filter; syllable-budget
  fit; diversity cap; **seed agreement with `core._group_anchors`** (the two must
  not drift).
- additions to `lyric_gen_test.py` — precedence order (producer > planned >
  group); `endWordOk` failing a wrong end word and feeding `_failure_reason`;
  `_analyze_line` agreeing with `_evaluate` under the third state.
- **The sabotage that must go red**: write the anchor into `seedText` instead of
  the third state, and assert that a *different* line in the same group still has
  its rhyme gate enforced. That is the group-wide nullification in §5, caught by a
  test rather than by a reader.
- C++: `tests/test_lyrics.cpp` — `lyricRhymeAnchor` round-trips, is undoable, and
  **changes `lineFingerprint`** (the last one is the guard that `lyricScore` would
  have failed).

## 11. Ledger

PROGRAM.md gets an append-only entry when this lands. The repo's convention is
that decisions live in the ledger, not only in a spec.
