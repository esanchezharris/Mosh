# Mined skills v1

This is an offline candidate library for evaluating a future router. Read [REPORT.md](REPORT.md) for measured coverage, validation verdicts, failures and limitations. Nothing loads these files into the existing runtime or router.

## Artifacts

- `skills/*.json`: one file per selected command shape, full provenance and 5–10 verbatim training utterances.
- `ui/src/skillMining/`: deterministic mining, native dispatch parsing, typed rendering, substantive snapshot predicates, r4 mock replay and reporting.
- `service/skills/mined_schema.py`: additive `MinedSkill.load(path)` / `from_dict` / `from_json` loader. `to_dict()` preserves metadata and predicates; `.base` exposes the existing `Skill` representation. The old predicate evaluator cannot execute the new predicates.
- `measurements.json` / `shapes.json`: hashes, thresholds and exhaustive shape-to-row IDs.
- `row-validation.jsonl`: every selected row's exact-rendering result, behavioral verdict and reasons. The validator derives each full group from the SHA-verified corpus, rejects shortened provenance, and retains missing setup in the full denominator.
- `corpus-audit.json`: all-corpus native command/argument-name checks, explicit nulls, HUH-with-commands and unresolved extraction records.
- `FREEZE.json`: file-by-file hashes of skills, schema, validator rules, native source, the full UI source tree (covering the mock dependency closure), package manifests and evidence before held-out coverage.
- `heldout.json`: each held-out row's one-skill, two-skill or uncovered outcome for candidate and validated libraries.

## Run locally

Use the existing dependencies in `ui/node_modules`; no packages are added. Corpus paths below are private local inputs, verified against pinned SHA256 values. `--root`, `--train`, `--evalA`, and `--frozen300` accept explicit alternatives with the same bytes.

```sh
cd ui
npm exec -- tsx src/skillMining/cli.ts --help
npm exec -- tsx src/skillMining/cli.ts check
npm exec -- tsx src/skillMining/cli.ts verify
npm exec -- tsx src/skillMining/cli.ts report
npm run typecheck
npm test
cd ../service/skills
python3 -m pytest -q
```

`check` regenerates measurements and skills in memory, compares their exact bytes/provenance/examples, and records `determinism.json`. `report` regenerates only the report. `verify` checks the frozen file inventory and hashes. The original construction order was `measure`, `mine`, `validate`, `check`, `freeze`, `heldout`, `report`, `verify`. After freezing, the CLI refuses `measure`, `mine`, and `validate`; it never silently replaces a frozen library.

`validate` uses an empty authentic-setup map because none could be recovered. The exported `validateLibrary` API accepts a map of genuinely recovered per-row `ReplaySetup` records; fabricated states are not eligible. `replaySkill` uses the existing `runBound`, `__resetMockForTests`, `mockExecute` and `mockSnapshot` under the existing Vitest jsdom environment. Synthetic unit fixtures exercise this path but contribute zero corpus passes. No replacement mock exists.

## Router-neutral input contract

The existing Python schema stores primitive/list `slots[].type`, `template.commands`, `{slot}` references, and snake-case command names. This library preserves that representation. The six requested input categories live in `slots[].input.kind`: `choice_static`, `choice_snapshot`, `set`, `flag`, `number`, `text`. Numeric finite enumerations can have primitive type `number` and input kind `choice_static`.

Each slot carries a producer-facing question. Optional slots also carry a presence question. Omission removes an argument; explicit `null` does not become omission. Native defaults are informational, never injected by the renderer. Numeric musical judgments, including constant values, carry `NEEDS_OWNER_VALUE` and observed min/median/max. Their actual values must be supplied before rendering. Absent numeric bounds mean the native handler provides no bound; they do not represent guessed limits. Units and source lines remain explicit.

Snapshot selectors return live identifiers from supplied snapshots, with parent track/clip scoping. The kit selector requires the actual `list_drum_kits` result at snapshot key `list_drum_kits`; no kit catalog is invented. All choice values remain typed and carry plain-English descriptions where static. Set/list support remains explicit but no selected shape requires a set slot.

`fillGold(skill, commands)` extracts values using recorded positional bindings. `render(skill, filled)` handles independent commands. For a template using `{stepN.result.field}`, call `renderStep` sequentially with actual successful result envelopes; the field is resolved under result `data`. Missing, future, unsuccessful or unresolved results fail. Newly created IDs are never predicted. The selected library's only repeated-command shape is eight `add_note` commands targeting an existing clip; it requires no newly created-ID reference.

Preconditions use `snapshot_choice`; postconditions use `command_effect` tied to a specific step. These are machine-run checks implemented by the offline validator. A success-only mock branch, unchanged setter, unavailable save/editor evidence or unknown undo target remains unverified. Exact names, order, repetitions, argument presence, types and values are checked separately from behavioral evidence.

This library expands trajectories without batching. Undo count is the number of native undoable transactions actually materialized, potentially fewer than command count. Eight note insertions can produce eight undo steps. A router's classification accuracy, numeric extraction and musical judgment are outside this report.
