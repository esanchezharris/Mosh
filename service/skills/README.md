# Mosh skills — v1 mining + routing scaffold

This is the first rung of the brain's pivot from **weights to skills**:
mine a typed skill library out of the real demonstration corpus, and
scaffold a small deterministic router/composer that dispatches over it.

**This module is a SCAFFOLD.** It is self-contained under `service/skills/`,
touches nothing else in the repo, and is **not wired into the app**. No
MoshOps command handlers, engine, state, or `ui/` code changed. Wiring the
router into the live agent loop (`ui/src/agent/`) is explicitly future work
— see "What this is not," below.

There is **no model training** anywhere in this module. Mining is
deterministic corpus clustering (string/structure matching + IDF-weighted
keyword statistics). Routing is deterministic lexical retrieval + regex/
lookup-based slot filling. Both are plain Python over the demonstration
corpus and the real MoshOps command catalog.

## Files

| File | Purpose |
|---|---|
| `schema.py` | The `Skill`/`Slot`/`TemplateCommand` dataclasses, JSON (de)serialization, structural validation, and the shared `eval_predicate` used by preconditions/postconditions/`emit_if`. |
| `textutil.py` | Tokenizer, IDF table, note-name↔MIDI parser, and small regex extractors (dB, %, fraction, bpm, track/note numbers) shared by mining and routing. |
| `moshops_catalog.py` | A small bracket/string-aware parser that reads `ui/src/agent/commands.ts` (read-only) into `{command: {desc, args:[{name,type,required}]}}` — the ground truth every mined/routed command is checked against. |
| `mine.py` | Reads the corpus, clusters recurring task→command patterns, emits `library.jsonl`. |
| `router.py` | Given a task string + a snapshot, selects skill(s), fills slots, checks preconditions, expands the template into a MoshOps command sequence. |
| `library.jsonl` | The mined v1 skill library (36 skills as of this writing — regenerate with `python3 mine.py`). |
| `contract_test.py` | The catalog-boundary guard: `moshops_catalog.py` must be a *faithful* projection of `commands.ts` (it wasn't — an escape-unaware `desc` regex truncated 2 of 124), and the **shipped** `library.jsonl` must validate against it (nothing checked that before). |
| `*_test.py` | The gate — `cd service/skills && python3 -m pytest -q`. |

## The schema

```
Skill := {
  name, description,
  slots:          [{name, type, required, description, source, default}],
  template:       {commands: [{command, args, repeat_over?, emit_if?}]},
  preconditions:  [predicate],
  postconditions: [predicate],
  provenance:     [corpus row refs],
  triggers:       [retrieval keywords],
}
```

This is the schema named in the brief, plus small, explicitly-scoped
extensions a router needs to be more than a toy — every one of them is
still provenance-derived, never hand-invented per skill:

- **`slots[].source`**: `"user"` (parsed from the task text or looked up in
  the snapshot by name) or `"computed"` (derived by a router-side transform
  from other slots + existing snapshot state — e.g. "the notes already in
  this clip, transposed").
- **`slots[].default`**: a real value mined straight from provenance (the
  mode value of that arg across the cluster's own rows — e.g. `type:"drum"`
  for the make-drum-track skill, or the exact EQ params the corpus
  demonstrated for a `highpass` preset). The router falls back to this when
  the text doesn't say, instead of guessing.
- **`template.commands[].repeat_over`**: a command can repeat once per item
  of a list-typed slot — e.g. one `add_note` call per note in a pattern.
- **`template.commands[].emit_if`**: a command can be conditionally skipped
  based on a predicate over the snapshot — e.g. skip `create_bus` if a bus
  with that name already exists. Reuses the same predicate vocabulary as
  pre/postconditions (`schema.PREDICATE_TYPES`).
- **`triggers`**: a small (≤16 token) bag of the skill's own provenance
  vocabulary, IDF-weighted (see below) — `description` alone is too short
  and uniform for good retrieval recall across paraphrases ("map"/"put"/
  "assign"/"drop" all meaning the same `assign_sample` action).

## Mining algorithm (`mine.py`)

Deterministic, no randomness, no ML:

1. **Load** the four `service/sft/*.jsonl` demonstration files (189 raw
   rows: `assist_demonstrations.jsonl` 35, `r5_train_additions.jsonl` 105,
   `add_note_corrective.jsonl` 40, `a3b-r4-cuda_next_run_examples.rendered.jsonl`
   9). Each row is `{system, user: <task text>, assistant: {commands: [...]}}`
   — the system message is the same agent catalog prompt every time; only
   `user`/`assistant` are used.
2. **Dedupe** literal `(task, commands)` repeats across files (the corpus
   reuses some rows for SFT weighting) into 174 examples, keeping every
   source row as provenance.
3. **Structural clustering** — run-length-compress each example's command
   sequence into `(name, multiplicity, arg-key-signature)` tuples.
   `multiplicity` is `"1"` (called once) or `"+"` (called 2+ times), so e.g.
   `load_builtin`+`set_plugin_param`×1/×2/×3 (brighten/highpass/compress —
   different param counts) generalizes to one shape while staying distinct
   from `load_builtin` alone.
4. Within a bucket that contains a repeated run **only** (a command called
   exactly once per row is already fully disambiguated by its shape;
   splitting it further would just fragment one skill by which verb
   synonym a demo happened to use — this is what stopped `assign_sample`,
   with 51 examples across 6+ verbs, from fragmenting into one skill per
   verb):
   - **Note-name traceability presplit**: for `add_note`/`set_note` buckets
     whose repeated run sets `pitch`, separate rows whose pitches are
     *exactly* reconstructible from explicit note names in the text
     ("A1, C#2, E2") from rows that aren't (a generated pattern, or a
     transform of notes already in the clip).
   - **Greedy TF-IDF keyword-anchor split**: repeatedly pick the token that
     covers the most still-unassigned rows, weighted by corpus-wide rarity
     (`ln((N+1)/(df+1))+1`, computed over the whole 174-row corpus), bucket
     every row containing it, repeat. A self-derived slot-noun blocklist
     (`textutil.derive_slot_nouns` — capitalized mid-sentence words, plus
     words recurring as `"the X"`/`"X track"`) additionally keeps incidental
     track/instrument-name nouns (e.g. "hats") from ever winning an anchor
     over the true operation verb ("swing" vs "humanize" both say "the
     hats" — only the rare word should decide the split).
5. **Generic skill construction** — for each cluster, every argument key
   that's constant *within* a row's own repeats becomes a scalar slot
   (type/required from the real catalog); every key that *varies* on a
   repeated run becomes a repeat-body field on a `list<param>` slot.
   Descriptions are pulled **verbatim** from the MoshOps catalog's own
   per-command `desc` (never authored ad hoc). `Slot.default` is the modal
   value of that arg across the cluster's own provenance.
6. **`SEMANTIC_REFINERS`** — a small, explicitly-scoped set of overrides for
   the ~9 clusters whose slots need router-*computed* values instead of
   user-provided ones: transpose/harmonize/crescendo/swing/humanize/layer
   ("the notes already in this clip, transformed"), mute-all-but ("every
   track except these, computed from the snapshot"), and the bus family
   ("reuse this bus if it already exists" — 5 shapes: route-to-new-bus,
   adjust-send-level, remove-from-bus, one-track-to-many-buses, many-
   tracks-to-one-bus). Every other cluster (the majority) ships exactly as
   the generic build produces it.

Every skill's `provenance` cites the exact corpus rows that produced it
(`mine_test.py` checks every ref is real, and that the cited row's own
commands actually overlap the skill's template — the anti-fabrication
check). No skill in `library.jsonl` was hand-authored; **`create_track`
does not exist as a skill** despite being a valid catalog command, because
no corpus row ever demonstrates the agent calling it.

### Rejected clustering approaches

- **Pure command-name-sequence clustering** (ignore arg keys entirely):
  conflates `add_note`-repeated "write a pattern" with `add_note`-repeated
  "double the melody up an octave" and "harmonize with thirds" — they're
  the same command called a variable number of times but mean three
  different things. Rejected: too coarse.
- **Exact full-tuple clustering** (name+mult+argkeys, but treat `mult`
  count itself as part of the key): would split `highpass` (2 params),
  `compress` (3 params), and `brighten` (1 param, no repeat at all — a
  different shape already) into artificially separate 1-example skills
  even where a shared shape genuinely exists. Rejected in favor of the
  `"1"`/`"+"` multiplicity abstraction.
- **Naive keyword-anchor split on every bucket, unconditionally**: over-
  fragments `assign_sample` by incidental verb ("map"/"put"/"drop" each
  becoming their own skill) and `load_drum_kit` similarly, since a command
  called *once* per row is fully disambiguated by its shape already — any
  further split is fragmenting on phrasing, not meaning. Rejected in favor
  of only splitting buckets that contain a genuine repeated run.
- **Plain word-frequency anchors (no IDF)**: within the ambiguous
  `add_note`-repeated bucket, raw frequency picks "melody" or "hats" as the
  anchor before "octave"/"swing"/"humanize", because incidental subject
  nouns are shared by *more* rows than the rare operation verb that
  actually defines the skill. Rejected in favor of corpus-wide IDF
  weighting, which correctly demotes generic recurring nouns.

## Router (`router.py`)

Given a task string + a snapshot (see `router.py`'s module docstring for
the minimal shape — `tracks`/`clips`/`buses` plus optional
`selectedTrackId`/`selectedClipId` for deictic references like "keep this
take"):

1. **Retrieval** — every skill is scored by lexical overlap between the
   task's tokens and its mined `triggers`, weighted by *cross-skill* IDF
   (`router._trigger_idf`): how many *other skills'* trigger bags also
   contain each token, computed fresh from the loaded library. This is a
   second IDF pass distinct from mining's corpus-text IDF — a token can be
   rare within its own cluster's source text (mining's pass already
   handles that) and *still* legitimately appear in many different skills'
   trigger bags (e.g. "track" belongs in `assign-sample`'s, `rename-track`'s,
   and `set-track-type`'s triggers all at once). Without this second
   weighting, a tiny 3-word trigger bag sharing 2 generic words could
   outscore a properly-matching 16-word bag sharing 4 specific ones — an
   early cut of this router made exactly that mistake and the held-out
   accuracy suite caught it.
2. **Slot filling** — a handful of skills (the same families
   `SEMANTIC_REFINERS` special-cased) dispatch to a matching filler,
   matched *structurally* against the skill's own slot names/sources/types
   and template shape (never by name string, for the same reason mining
   avoids fabricating skills: the code should recognize "this needs
   computed values" the same way twice). Every other skill fills
   generically: `trackId`/`clipId` resolve by name or number against the
   snapshot (falling back to `selectedTrackId`/`selectedClipId` for
   deictic references), everything else through a small `(command,
   arg-name) -> extractor` table, falling back to the slot's mined
   `default` when the text doesn't say.
3. **Preconditions** are checked against the snapshot before a skill is
   accepted — a missing clip surfaces as a routing error, not a bad command.
4. **Template expansion** substitutes `{slot}`/`{item.field}` placeholders,
   honoring `repeat_over` and `emit_if`.
5. **Composition** — `route()` tries the whole task text as one skill
   first. It does *not* stop there: a compound sentence like "solo the
   drums and set the tempo to 90" can still score well against a single
   skill (`set-tempo`, which only needs a bpm number and doesn't care what
   else is in the sentence) while silently dropping the other clause. So
   whenever there's a conjunction, `route()` also computes a composed
   alternative — split on `"and"`/`";"`/`", then"`, route each clause
   independently (clauses under 2 content tokens don't count, so "bass" in
   "mute everything but the drums and bass" can't hijack composition), and
   only prefer the composed result when it resolves to 2+ genuinely
   distinct skills. Two guards prevent over-splitting a single intent that
   happens to contain "and": (a) if the whole-text match's trigger
   vocabulary exactly equals the query's tokens, it's a complete match
   (verbatim provenance text) and wins outright; (b) if the matched skill's
   triggers overlap *every* clause (not just one), it's already using the
   whole sentence and wins outright. Composition is bounded to `max_chain`
   (default 3) skills.

Every emitted command is checked against `moshops_catalog.validate_command`
before `route()`/`route_single()` return it — the router never hands back a
command the real agent-catalog validator would reject.

## Known limitations (honest, not hidden)

- **Numeric fidelity on the note-transform family is approximate, not
  exact.** Swing/humanize in particular: the corpus has exactly one
  demonstration of each, and the precise curve (which notes get nudged, by
  how much) isn't fully recoverable from one example. The router's fillers
  implement a documented, deterministic approximation (nudge every note
  that isn't a group anchor, for swing/humanize; linear velocity ramp for
  crescendo) rather than overclaiming exact reproduction. Router accuracy
  is graded on *skill selection* + *command validity*, not on matching the
  original demo's exact numbers — see `router_test.py`.
- **Anaphora across composed clauses isn't resolved.** "rename the melody
  track to Lead and pan it a bit to the left" fills `it` in the second
  clause via `selectedTrackId`, not "whichever track the first clause just
  named." Each clause is filled independently.
- **The bus family's `busIndex` for a brand-new bus is a "would-be" index**
  (`len(existing buses)`), not a real command result — there's no
  execution happening in this scaffold to bind an actual return value.
  This matches every case observed in the corpus (a fresh session always
  gets bus 0, 1, ... in creation order) but a real integration would want
  the same `bind`/`$VAR` mechanism `a3b-r4-cuda_next_run_examples.eval.jsonl`
  and `--run-script` already use for exactly this.
- **The snapshot shape here is hand-rolled**, not `MoshOps::snapshot()`.
  Mapping the real one is Wave 2.

## What this is not

- Not wired into `ui/src/agent/` or the live brain loop.
- Not a fine-tuning or RL pipeline — see `CLAUDE.md`'s "SETTLED — do not
  revive" note on the RL/GRPO loop and SFT r5. Mining is corpus statistics;
  routing is regex + lookup.
- Not a replacement for `ui/src/agent/commands.ts`/`skills.ts` — this reads
  the former as ground truth and doesn't touch either. That separation is now
  a tested invariant, not a convention: see
  [`docs/first-stranger-program/SKILL_CATALOG_BOUNDARY.md`](../../docs/first-stranger-program/SKILL_CATALOG_BOUNDARY.md)
  for why the mined library and `skills.ts` are deliberately NOT merged (zero
  skill-name overlap; 5 of 40 shared commands; different artifact kinds), and
  `contract_test.py` + `ui/src/agent/skillCatalogBoundary.test.ts` for the
  guards that fail when they drift.

## Running the gate

```
cd service/skills
python3 mine.py          # regenerate library.jsonl (deterministic)
python3 -m pytest -q     # the gate — stdlib + pytest only, no venv needed
```
