# External music-quality evaluators — research + bench plan (2026-07-02)

Owner ask: "look into known good audio analyzer models — SongEval, Google/Magenta stuff,
MusicEval, or Gemini API spend if it's good for this." Standing rule (audit + validity-pack
lesson: our own verifier's tiers were inaudible to the owner): **nothing external judges
unbenched** — a model becomes a factory pre-ranker only if it clears **AUC ≥ 0.65 on the
owner's keep/kill labels** (or Spearman ≥ 0.5 on stars) on held-out data; below that it may
serve as a cleanliness/diversity filter at most. The bench set is `~/mosh-beats/labels/
labels.jsonl` (grows with every Taste Pack; the factory attaches Audiobox axes per candidate
so labels and model scores land pre-joined).

## Ranked shortlist (research pass, 2026-07-02)

| # | Model | Scores | Install | Runtime/clip | License | Expected keep/kill signal | Bench |
|---|---|---|---|---|---|---|---|
| 1 | **Audiobox-Aesthetics CE/CU/PC** (PQ already used) | enjoyment / usefulness / complexity | **zero** — same forward pass in the judges venv; read 3 more keys | 0s extra | CC-BY-4.0 ✓ commercial | CE plausibly nearest "banger or not" | 1st |
| 2 | **LAION-CLAP** embedding + prompt-score | 512-d embedding; cosine vs "hard-hitting professional trap beat" | **zero** — `laion_clap` + checkpoint already in `~/AI/judges_venv` / `~/AI/clap_ckpt` | ~0.3–1 s CPU | code MIT; Freesound-sourced training data = low-but-nonzero exposure (already accepted in-repo, `drummatch/embed.py`) | two features in one | 2nd |
| 3 | **MuQ / MuQ-MuLan** embeddings | music embedding (ranker feature) | low-mod (prior reward-head precedent) | 1–3 s | Apache-2.0 ✓ | precedent as reward head; untested as ranker feature | 3rd |
| 4 | **fadtk per-song FAD** vs the owner's kept beats | distributional "taste fit" distance | `pip install fadtk`; use CLAP/EnCodec backend (NOT the MERT backend — NC license) | 1–2 s after one-time ref stats | toolkit MIT ✓ | novel signal, thin published validation for per-song use | 4th |
| 5 | **SongEval** | 5 song-aesthetics axes | mod-high (MERT-330M ~1.3 GB) | est. 2–5 s | **CC-BY-NC (toolkit AND backbone) — BLOCKS commercial shipping** | trained on full vocal songs — domain mismatch for wordless beats | internal-research only |
| 6 | PAM (CLAP opposing prompts) | no-reference quality | low (reuses CLAP) | <1 s | reference repo license unclear | likely redundant with Audiobox PQ | 6th |
| 7 | **Gemini audio-as-judge** (gemini-3-flash-preview / 3.1-flash-lite) | structured keep/kill + axes | zero code; **no API key yet** | 2–8 s API | commercial ToS ✓ | strong at description/defect-flagging; thin evidence for calibrated aesthetics — treat as coarse | needs key |

**MusicEval** is a benchmark/dataset (AudioMOS Challenge Track 1), not a shippable scorer —
no maintained pip-installable checkpoint; not an option unless one surfaces.

**Gemini cost** (owner pre-approved spend): ~750 audio tokens per 30 s clip → **$0.06–$0.20
per 60-clip factory batch** all-in. Cost is not the constraint; unvalidated judging is. To
enable: drop `GEMINI_API_KEY` into `ui/.env.local`; endpoint
`generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` with inline
`audio/wav` + `responseSchema` (natural home: a 4th provider in the `brain_client.py` chain).

## Bench protocol (runs after each Taste Pack)

1. Join `labels.jsonl` keep/kill rows to per-candidate scores (Audiobox axes ship in the
   factory features already; CLAP scores computed batch-offline).
2. Held-out AUC per signal (leave-one-pack-out once ≥2 packs exist; before that, report
   in-sample with the caveat printed loudly).
3. Adopt / demote per the pre-registered bars above; publish the table here.

## Status

- Audiobox axes: **wired** — `beat_factory.py` attaches PQ/CE/CU/PC per candidate when the
  judges venv is present.
- CLAP / MuQ / fadtk: queued behind the first labeled pack (nothing to bench against until
  keep/kill labels exist at pack scale).
- SongEval: **not adopted** (license + domain mismatch); revisit only if relicensed.
- Gemini: awaiting key.
