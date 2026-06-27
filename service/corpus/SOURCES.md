# Mosh SFT corpus — provenance ledger

The corpus lives at **`~/mosh-corpus/`** (gitignored; never committed, never redistributed).
It is **imitation-only cold-start data** for local, non-commercial research training of the
Moshi command-emission model — symbolic DAW *actions* (MoshOps commands), not audio. The trained
LoRA adapter and the corpus both stay on the owner's machine.

Re-acquire with `service/corpus/get_datasets.sh` (MIDI) and `service/corpus/scrape_packs.py`
(DAW project repos). Both are idempotent — they skip anything already present.

## Inventory (as built)

| Format | Count | Role in training |
|---|---:|---|
| `.mid`  | ~179,700 | bulk note-content + tempo/timesig/track structure (note-population signal) |
| `.flp`  | ~544 | full FL arrangements — adds mixer (vol/pan/mute/solo) + multi-track structure |
| `.als`  | ~27 | Ableton arrangements — mixer + audio/midi clips |
| `.rpp`  | ~35 | Reaper arrangements — mixer + MIDI note events |

## MIDI datasets (CC-BY 4.0)

- **Lakh MIDI Dataset (LMD-full)** — 176,581 MIDI files. Colin Raffel,
  <https://colinraffel.com/projects/lmd/>. License: CC-BY 4.0 (cite the page + thesis).
  Mirror: `http://hog.ee.columbia.edu/craffel/lmd/lmd_full.tar.gz`.
- **Groove MIDI Dataset (GMD, midi-only)** — real-drummer performances. Google Magenta,
  <https://magenta.tensorflow.org/datasets/groove>. License: CC-BY 4.0.
  `https://storage.googleapis.com/magentadata/datasets/groove/groove-v1.0.0-midionly.zip`.

## DAW project repositories (public GitHub — `<user>_<repo>` dir naming)

Project files (and parser test fixtures) collected from public repos. Cloned by
`scrape_packs.py`; licenses are per-repo (mixed; research/non-commercial use only).

- **FLP:** `pepsifx357/FL-Studio-Projects`, `clrke/flstudio-projects`,
  `YamatoRyou/chiptunes-flp`, `numberoneboybiggiefj/FL-Studio-Producer-pack`,
  `demberto/PyFLP` (parser test `.flp`s).
- **ALS:** `danielbayley/Ableton-Live-tools`, `kiddikai/ableton-parser`,
  `offlinemark/dawtool` (test `.als`s).
- **RPP:** `CharlesHolbrow/rppp`, `GriffinSauce/reaper-project-parser`, `Perlence/rpp`,
  `danielmkarlsson/rpp`, `andrewrk/PyDaw`, `offlinemark/dawtool` (test `.rpp`s).

## Rights posture

Per the repo's existing data-rights stance (`docs/MOSHI_IMPORTERS.md`,
`docs/MOSHI_TRAINING_RUNG_SCOPE.md`): importer-derived data is imitation-only cold-start, kept
local/internal, never redistributed. The owner explicitly cleared this corpus for
**non-commercial research** use. The model learns command/arrangement *structure*, and the
artifacts (`~/mosh-corpus/`, `service/sft/.adapters/`, `service/sft/.fused/`) are all gitignored.
