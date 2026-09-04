# Reference material, free-first (2026-09-02)

Companion to [SHORTLIST-2026-09.md](SHORTLIST-2026-09.md), which is the paid
basket. Owner decision this session: **prove the strategy on free material
before spending.** FL Studio is in play (owner's PC), which widens the free
pool a lot — free `.flp` is far more common than free `.als`.

Nothing here was downloaded, bought, signed up for, or email-gated by the
agent. Everything below is either already on the owner's disk or a verified
public URL for the owner to fetch.

---

## Tier 0 — the corpus already on this Mac (zero downloads, zero licence risk)

Measured this session with the repo's own importers:

| | count |
|---|---|
| `.als` on disk (excluding Ableton backups) | 54 |
| `.flp` on disk | 24 |
| **usable references** (≥6 tracks, ≥200 notes or a real gain spread) | **25** |
| parse failures | 1 (a macOS `._` AppleDouble stub, not a real project) |

Richest sets, by what the importer actually returned:

| Format | Tempo | Tracks | Notes | Track-gain spread | File |
|---|---|---|---|---|---|
| als | 128 | 109 | 1 429 | 37.4 dB | `BY MYSELF STMPD DECONSTRUCTED.als` |
| als | 120 | 46 | 2 921 | 26.4 dB | `Adriatique, Samm, Jaimes — Back To Life` |
| als | 160 | 32 | 1 307 | 21.3 dB | `Gravitas Create — Catalyst Demo.als` |
| als | 126 | 23 | 1 206 | 19.7 dB | `Adriatique, Vincent Vossen, Yubik — Never …` |
| als | 126 | 20 | 10 165 | 19.3 dB | `Tattoo.als` |
| flp | 150 | 47 | 9 060 | — | `Crush.flp` |
| flp | 152 | 46 | 1 956 | — | `yummy152 23.flp` |

Nine of these sit in the **145–160 BPM jerk/drill band** with real note data —
the exact genre the paid research found has no purchasable reference at all.

### The jerk reference we could not buy is already here

`~/Music/MonsterSamples/15drtt Dieweak Stashkit/flps/for educational purposes only/`
holds two `.flp` projects by **@15drtt** — the same producer whose drum kit is
already the labkit reference (`15drtt-jerk-r0.json`, the samples behind the
round-2 and round-3 passes). The folder name is the licence statement.

- `drums/kitty_157_@15drtt.flp` — 157 BPM, 19 channels, 1 255 notes, 108 MIDI clips
- `melody/kitty_loop_151_@15drtt.flp` — 151 BPM, 17 channels, 989 notes

Both ship with the `.wav` files they reference, so they open complete.

**What the drums project actually says (extracted, not inferred):**

1. **A soft clipper sits on insert 0** — `FruitySoftClipper`, FL's master
   insert. This is independent confirmation of the owner's round-2 note
   ("standardclip … particularly characteristic for making rage and jerk
   beats"), which round 3 acted on by ear alone. The reference agrees.
2. **Every channel fader is at FL's default (10 000).** The producer does not
   ride channel volumes at all.
3. **All balancing happens at the mixer inserts, and the spread is small.**
   Raw insert values 11 695 → 15 050 against unity 12 800. Under FL's standard
   cubic fader approximation that is about **−2.4 dB to +4.2 dB, a ~6.6 dB
   total spread**. (The curve is approximate; the raw values are exact.)

That third point contradicts our current preflight. Round 3 applies a
**synthetic 19 dB spread** (drums 0, 808 +3, lead −10, arp −16). The reference
producer's spread is a quarter of that, and the balance comes from
pre-gained one-shots rather than faders — which is what a "stash kit" is.

**Caveat, stated plainly:** these are two loop/kit demo projects, not finished
arrangements, so they may not represent a mastered mix. This is n=2. It is a
signal to test, not a rule to adopt. It is exactly the kind of thing a third
and fourth reference would settle.

### What our importers proved they can extract today

Verified by running them, not by reading the code:

| Data | `.als` | `.flp` |
|---|---|---|
| Tempo | yes | yes |
| Track names, count | yes | yes |
| **Per-track volume in dB** | **yes** | **no — 0 of 24 files** |
| Pan, mute | yes | yes |
| MIDI notes (pitch, start, length, velocity) | yes | yes |
| Clip positions, audio clip paths | yes | yes |
| Device chains / plugin parameters | no | no |
| Return/send tracks | logged as unmappable | — |

Two gaps, one cheap and one not:

- **`.flp` mixer levels are missing from our IR** (`service/flp/flp_cli.py`
  never reads them), yet PyFLP exposes `insert.volume`, `insert.pan` and named
  native plugin slots — that is how the numbers above were obtained. Since
  every jerk reference we have is FL, this is the single highest-value fix on
  the extraction side, and it is small.
- **Plugin parameters** (the actual highpass frequency, compressor settings)
  are not reachable in either format today. PyFLP names FL's own plugins
  (`FruitySoftClipper`) but reports third-party VSTs only as `_PluginBase`, so
  even a full FLP extractor will identify *that* a clipper is on the master,
  not what a Serum patch is doing.

FLP import was **not set up on this Mac before today**; the PyFLP venv is now
installed (`service/flp/setup-flp.sh`), self-test and importer tests pass.

---

## Tier 1 — free downloads worth fetching (ranked)

Owner action. Gates flagged; nothing here was fetched.

### Best free, on-genre, open link

1. **Just Producer forum, FLP-projects board** — https://justproducer.com/community/flp-projects/ — a purpose-built free-sharing forum rather than a sales funnel; carries UK drill templates and "2 free trap FLPs by Doctor B". The most legitimate community infrastructure found.
2. **W.A. Production — Free Trap FLPs by Doctor B** — https://www.waproduction.com/sounds/view/free-trap-flps-by-doctor-b — two FLPs (808 Mafia and Metro Boomin styles) with samples and presets, first-party, "100% royalty free". Email gate.
3. **Cymatics — Free Yeat FLP** — https://cymatics.fm/pages/free-yeat-flp — rage/plugg-adjacent, first-party Cymatics content.
4. **ToneDen UK drill FLPs**, three separate producers, plain open links — Seventh' Beats https://toneden.io/seventhbeatprod/post/free-uk-drill-flp · DM Makes Beatz https://toneden.io/dm-makes-beatz/post/free-flp-how-to-make-uk-drill-beat-fl-studio-tutorial · Chirac Beats https://toneden.io/chirac-beats-2/post/free-flp-wait-uk-drill-x-cloud-rap-type-beat
5. **Image-Line forum FLP Exchange / Epic Sound Recreation** — https://forum.image-line.com — board rule requires stock Image-Line plugins only, so these open with **zero missing-plugin placeholders**. Best "it just opens" guarantee anywhere on this list.
6. **Busy Works Beats UK drill tutorial project files** — https://busyworksbeats.com/blogs/music-production-tutorials/fl-studio-uk-drill-beat-tutorial-free-project-files
7. **FL Studio's own bundled demo projects** — already on the PC under `…\Image-Line\FL Studio <version>\Data\Projects`. Zero download.

### Best free non-FL, and stems (stems still give measurable per-track level)

8. **Magenta Groove MIDI Dataset** — https://magenta.tensorflow.org/datasets/groove — 1 150 human-performed drum MIDI files, 13.6 h, with velocity and microtiming, genre-labelled. **CC BY 4.0**, the cleanest licence on this entire page. Directly relevant to the drum-feel problem that has come up every round. Get this first of anything.
9. **Cambridge MT "Mixing Secrets" library** — https://cambridge-mt.com/ms3/mtk/ — 500+ songs of raw multitrack WAV, no login. Educational/non-commercial use only. The largest free multitrack corpus that exists.
10. **Ableton's own Downloads blog** — https://www.ableton.com/en/blog/categories/downloads/ — genuine `.als` Live Sets from real artists (Artefakt, The Black Dog, Sakura Tsuruta, Noémi Büchi). The index loaded fine on re-check; the earlier maintenance placeholder was transient.
11. **Ableton Live 12 Suite bundled demo sets** — already on this Mac: right-click the app → Show Package Contents → `Contents/App-Resources/Core Library/Lessons/Demo Songs`.
12. **Nine Inch Nails official multitracks** on archive.org (Ghosts I-IV, Year Zero, The Slip) — CC-licensed stems from released records. Verify the exact CC variant per release.
13. **Telefunken multitracks** — https://www.telefunken-elektroakustik.com/multitracks/ — free, real studio sessions, home/educational use only.
14. **E-GMD** (expanded Groove MIDI) and **Lakh MIDI** — scale-ups of 8 for feel and arrangement respectively; Lakh's matched files carry the underlying songs' copyright, so internal analysis only.

### Written references that are still data

For jerk specifically, where files are thin, breakdowns with explicit numbers
are usable input:

- Soundtrap "Jerk Trap": 140–160 BPM (150–152 the sweet spot), keys Bm/Gm/Am/Fm, two to four chords, 808 EQ'd with a 60–80 Hz pocket carved for the kick, kick↔808 sidechain, light 808 saturation, triplet/stuttered hats. Our lane runs 148 BPM in D minor, inside that band.
- Audeobox on 808 glides: portamento 80–150 ms for a trap slide versus 20–35 ms for a tight drill slide; mono mode required; notes must overlap.
- DJ Mag on MKthePlug's UK drill technique — trade press, named producer.

---

## Legitimacy notes

- **Avoid anything labelled "leaked."** The research surfaced a YouTube entry claiming to be a real artist's session; that is a stolen private file, not a free share. One entry, flagged and excluded.
- **"Remake" FLPs are recreations, not originals.** Skrillex/Drake/Travis Scott FLPs on YouTube are producers' reconstructions. Fine for technique, not the real thing, and should never be described as such.
- **Aggregators are the weak link.** ProducersBuzz, Kits4Beats and JustProducer circulate the same community-submitted pool (the Image-Line forum's 134-FLP thread). Fine for study; do not assume commercial rights without a per-file licence statement.
- **Splice sells no project files.** Confirmed again; its samples "must be part of a finished musical work."
- Paid-but-noted so they are not mistaken for free: isolated-tracks.com (hip-hop multitracks, paid), Radiohead stems (paid, two songs), ADSR's FL project catalogue (mostly paid), LANDR dark plugg samples (paid).

---

## Recommended order of work

1. **Extract from Tier 0 now.** 25 usable local projects, 2 of them real jerk sessions with explicit educational permission, cost nothing and settle whether the extraction pipeline produces rules worth having.
2. **Fix `.flp` mixer-level extraction** — small change to `service/flp/flp_cli.py`, and it is what turns the jerk projects from note references into *mix* references.
3. **Fetch Groove MIDI (CC BY) and two or three free FLPs from Tier 1** to test whether outside material adds anything the local corpus does not.
4. **Only then revisit the paid basket** in [SHORTLIST-2026-09.md](SHORTLIST-2026-09.md). The $171 order is not urgent and, on this evidence, may be partly redundant for trap and jerk.

## Open question the free corpus already raises

The reference producer's mixer spread is roughly 6.6 dB with flat channel
faders. Our preflight imposes about 19 dB. Both round-3 candidates passed the
owner's ear, so this is not a defect — but it is the first measured
disagreement between our synthetic rules and a real session, and it is the
kind of question the whole reference programme exists to answer. Two more jerk
or drill references would make it decidable.
