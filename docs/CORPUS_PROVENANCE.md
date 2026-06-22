# Moshi SFT corpus — provenance & rights registry

Records every source used to build the Phase-4 SFT training corpus, so any subset
can be **re-derived or excised later by rights status**. This is an experimental
personal-research corpus; nothing here is redistributed. Two facts shape the rights
posture:

1. **The pipeline trains on *operations/structure* (MoshOps command sequences), not
   audio bytes.** The importers extract arrangement/MIDI/mixer structure; no sample
   or rendered audio enters the dataset. This sidesteps most embedded-sample/preset
   licensing. The residual open question is *arrangement-as-derivative-work*.
2. **Corpus data lives outside the repo** (`~/mosh-corpus/`, gitignored by being
   external) and the derived datasets are gitignored. Only the importer code + this
   registry are committed.

`rights` column legend: **open** = permissive/OSI or CC-BY/CC0 (safe to keep);
**copyleft** = GPL/MPL/CC-BY-SA (keep, but derivative terms apply); **nc** =
non-commercial / no-derivatives (exclude for any commercial use);
**unlicensed** = no license stated (research-only; exclude if rights matter).

## DAW project files (cloned to `~/mosh-corpus/`)

| Source | URL | Formats | ~Count | License | rights |
|---|---|---|---|---|---|
| offlinemark/dawtool | https://github.com/offlinemark/dawtool | .flp, .als | 5 + 16 | BSD-3 / GPL-3 | copyleft |
| CharlesHolbrow/rppp | https://github.com/CharlesHolbrow/rppp | .rpp | 16 | MPL-2.0 | copyleft |
| andrewrk/PyDaw | https://github.com/andrewrk/PyDaw | .flp | 13 | GPL | copyleft |
| demberto/PyFLP | https://github.com/demberto/PyFLP | .flp | 1 | GPL-3 | copyleft |
| Perlence/rpp | https://github.com/Perlence/rpp | .rpp | 2 | BSD-3 | open |
| GriffinSauce/reaper-project-parser | https://github.com/GriffinSauce/reaper-project-parser | .rpp | 3 | MIT | open |
| kiddikai/ableton-parser | https://github.com/kiddikai/ableton-parser | .als | 1 | open-source (stated) | open |
| danielbayley/Ableton-Live-tools | https://github.com/danielbayley/Ableton-Live-tools | .als | 1 | LICENSE present | open |
| danielmkarlsson/rpp | https://github.com/danielmkarlsson/rpp | .rpp | 13 | none stated | unlicensed |
| clrke/flstudio-projects | https://github.com/clrke/flstudio-projects | .flp | 10 | none stated | unlicensed |
| numberoneboybiggiefj/FL-Studio-Producer-pack | https://github.com/numberoneboybiggiefj/FL-Studio-Producer-pack | .flp | ~20 | none ("royalty-free") | unlicensed |
| pepsifx357/FL-Studio-Projects | https://github.com/pepsifx357/FL-Studio-Projects | .flp | 200+ | none (personal backup) | unlicensed |
| YamatoRyou/chiptunes-flp | https://github.com/YamatoRyou/chiptunes-flp | .flp (zipped) | ~30-50 | CC BY-NC-ND 4.0 | nc |

Cloned totals (verified on retrieval): **~542 .flp, ~27 .als, ~35 .rpp**.

## MIDI arrangements (downloaded to `~/mosh-corpus/midi/`)

| Source | URL | Format | Count | License | rights |
|---|---|---|---|---|---|
| Lakh MIDI Dataset (lmd_full) | https://colinraffel.com/projects/lmd/ · http://hog.ee.columbia.edu/craffel/lmd/lmd_full.tar.gz | .mid | **178,561** | CC BY 4.0 | open |
| Groove MIDI Dataset | https://magenta.tensorflow.org/datasets/groove | .mid | 1,150 | CC BY 4.0 | open |

MIDI is the corpus's volume — both CC BY 4.0, the cleanest rights tier here.

## Cataloged but NOT ingested (gated / for later, manual acquisition)

These need email walls / file-host gates / accounts and were intentionally **not**
auto-scraped (we don't bypass gates). Listed so they can be acquired manually later.

| Source | URL | Formats | License | note |
|---|---|---|---|---|
| John Bartmann (Bandcamp/Gumroad) | https://johnbartmann.bandcamp.com/ | .als (~200) | CC BY-SA 4.0 | free tier, account-gated |
| Open Multitrack Testbed (QMUL) | http://multitrack.eecs.qmul.ac.uk/ | .rpp + stems | per-track CC | expired SSL; per-song download |
| Cambridge-MT Mixing Secrets | https://www.cambridge-mt.com/ms3/mtk/ | some .rpp | educational-only | not cleared for ML as-is |
| BVKER free FLP/ALS | https://bvker.com/free-flp/ | .flp/.als (~140) | royalty-free, no-redist | email gate |
| ProducersBuzz 134 FLPs | https://www.producersbuzz.com/category/downloads/fl-studio-project-files/ | .flp (134) | royalty-free | email/click gate |
| Image-Line FLP Exchange | https://forum.image-line.com/viewforum.php?f=1944 | .flp (~1900 threads) | IL-stock-only | per-thread file hosts |

## Supplementary (future — needs extension)

| Source | URL | Format | License | note |
|---|---|---|---|---|
| GigaMIDI | https://huggingface.co/datasets/Metacreation/GigaMIDI | .mid (2.1M) | CC BY-NC 4.0 | HF terms-agreement gate |
| GiantMIDI-Piano | https://github.com/bytedance/GiantMIDI-Piano | .mid (10K) | CC BY 4.0 | direct, piano-only |
| Slakh2100 | http://www.slakh.com/ | .mid + audio (2,100) | CC BY 4.0 | direct |

---

To rebuild an open-only corpus: include rows with rights ∈ {open, copyleft} (drop
`nc` + `unlicensed`). The MIDI tier alone (Lakh + Groove, CC BY 4.0, ~180k files) is
both the largest and the cleanest, so a rights-clean run is also the high-volume run.
