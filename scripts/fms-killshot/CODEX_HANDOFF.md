# FMS Codex Handoff — "Used2" take calibration

**Branch:** `claude/fms-extraction` (pushed, clean)
**Date:** 2026-07-08
**Repo:** `ClaudeMosh` (https://github.com/zeke431/ClaudeMosh.git)

## What's done

### Phase 0 — Variant comparison ✅ DONE
Three versions of the same vocal at **138 BPM** compared:
- `~/Downloads/Used2 nofx.wav` — no effects
- `~/Downloads/Used2 gate.wav` — gate only  
- `~/Downloads/Used2 all.wav` — gate + vocal processing

**Result:** `nofx` ≈ `gate` (F1=0.922, near-identical timing). `all` diverges hard (F1=0.735, different word count 222 vs 184). **Winner: `nofx`** for all downstream work.

Data at `~/mosh-fms-ksb/used2/`:
- `{nofx,gate,all}.wav` — mono 44.1kHz copies
- `{nofx,gate,all}-whisper.json` — Whisper `small` transcriptions
- `{nofx,gate,all}-aligned.json` — MMS_FA forced-aligned words
- `{nofx,gate,all}-librosa.json` — librosa transient times
- `variant-compare.json` — comparison metrics
- `used2-split.json` — split analysis (needs updating, see below)
- `listen/confidence-split.html` — visualization (served at :8189)

### Phase 1 — Split point identified
**Owner confirmed: "Truman" at 55.06s is the last real word.**

The Whisper transcript has errors that the owner wants to correct before proceeding. The `used2-split.json` was auto-computed at word 177 (wrong — too late). Correct split = word 124 ("Truman." at 55.06s).

## What's next

### Step 1: Editable Whisper transcript
Build an HTML page that:
1. Shows each Whisper word with its timestamp and confidence
2. Lets the owner **edit the word text** (click to edit, or input field per word)
3. Lets the owner **delete spurious words** (Whisper hallucinations)
4. Has a "Save" button that writes the corrected transcript back as JSON
5. Marks the split point at "Truman" (55.06s) — everything after is mumble

The owner's insight: these manual corrections could teach the agent over time (e.g., "I said X not Y" patterns). For now, just make the transcript editable so the corrected version feeds into the template.

**Read back the corrected JSON via `preview_eval`**: `JSON.stringify(window.correctedWords)` or similar.

### Step 2: Update split and re-run forced alignment
Once the transcript is corrected:
1. Update `used2-split.json` with `split_time_s: 55.06`, `split_word_idx: 124`
2. Re-run forced alignment on the corrected words (skeleton venv)
3. Save as `nofx-aligned-corrected.json`

### Step 3: Phase 2 — Calibrate onset detection on real-lyric first half
See the plan at `.claude/plans/neither-one-works-correctly-tender-crystal.md`

### Step 4: Phase 3 — Template the whole take
### Step 5: Phase 4 — Fill the mumble

## Key tools and venvs

| Tool | Venv | Invocation |
|------|------|-----------|
| Whisper | `~/Library/Mosh/venvs/whisper` | `whisper_cli.py <input> small` |
| Forced alignment | `~/Library/Mosh/venvs/skeleton` | `align.align_words(audio, words)` |
| Librosa transients | `~/Library/Mosh/venvs/sketch` | `onset_strength` + `onset_detect(backtrack=True)` |
| FCPE F0 | `~/Library/Mosh/venvs/skeleton` | `skeleton_cli.py <input>` |
| Template builder | none | `template.build_template_wordsfirst(...)` |
| Onset agreement F1 | none | `overlap.onset_agreement(a, b, tol_s=0.05)` |
| Confidence gating | none | `extract.credible(w)` |

All scripts at `scripts/fms-killshot/`. Service code at `service/`.

## Files created this session

| File | Purpose |
|------|---------|
| `scripts/fms-killshot/variant_compare.py` | Phase 0: compare 3 variants pairwise |
| `scripts/fms-killshot/clean_take_spike.py` | Reusable: aligned→template→clicks+viz |
| `scripts/fms-killshot/resing_render_exp.py` | Experimental re-sing pipeline |

## Critical context

- **138 BPM** (not 147 — that was the previous rap take)
- Split at **55.06s** ("Truman") — owner-confirmed
- Use `nofx.wav` for everything downstream
- The Whisper transcript has errors the owner wants to fix before proceeding
- `sys.path.insert(0, 'service')` needed for imports from repo root
- Preview server: `fms-ksb` in `.claude/launch.json`, port 8189, serves `~/mosh-fms-ksb/`
- Brain key at `~/Library/Mosh/brain.env` (exported via `MOSH_BRAIN_ENV`)
