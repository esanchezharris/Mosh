# FX knowledge-base scrape — pilot report (2026-07-02)

The owner's direction (pack-003 question round): mix polish should eventually range
across his ENTIRE plugin collection, fed by scraping YouTube for plugin-state
screenshots + the natural language producers use around them — distilled into an
"encyclopedic" knowledge base mapping descriptions ↔ effect chains/settings. The same
pipeline is the intended source of the encyclopedic STYLE vocabulary.

## Honest framing

The 2026-07 training audit **killed** OCR-based video teardown for recipe mining
(synth-param recall ≈0 after the never-mislabel gate; zero recipes ever mined from any
video). This pilot is a different bet on two axes: a real **VLM** reads the plugin UI
(not tesseract), and the target artifact is a **knowledge card** (what the producer
SAYS a move does, tied to observed settings) — not an executable recipe. The
pre-registered go/no-go below is the referee; if the audit's verdict holds anyway,
this dies again and stays dead.

## Pipeline (`service/teardown/kb/pilot.py`)

ytsearch query → one video (metadata + license recorded) → auto-subs → keyword
moments (OTT/compressor/saturation/EQ/808/…, ≥45 s apart) → one frame per moment via
the stream URL (no full download) → VLM read (`gpt-4o-mini`, never-mislabel: params
below confidence 0.6 dropped) → distillation with a ±20 s transcript window → card.

Card schema (`~/mosh-kb/cards.jsonl`): source {video, channel, t, license} · plugin ·
observed_params [{name, value, unit, confidence}] · transcript_quote (short,
attributed) · nl_description (the producer's claim, their words) · chain_context ·
style_tags · extraction {model, frame}. Frames cached locally only, never
redistributed; no audio retained. Spend ledger `~/mosh-kb/spend.jsonl`, hard abort at
$10.

## Go/no-go (pre-registered)

≥12 cards from ≥3 videos; audit of 10 random cards ≥70% correct (plugin identified +
≥1 param matching the frame + a recognizable NL description); spend ≤ $10.

## Results

**Volume: PASS.** 21 cards from 5 videos, total spend **$0.11** (bar: ≥12 from ≥3,
≤$10). Sources: an FL Studio 808-saturation tutorial, an FL drum-mixing tutorial, a
Lu Diaz low-end mixing session (Pro Tools/Waves), Serum and Vital sound-design
tutorials. All license `youtube-standard`, recorded per card.

**Accuracy audit: FAIL (strict) — verdict NO-GO as pre-registered.** 8 of the 10
sampled cards were audited frame-vs-card before the bar became mathematically
unreachable (max 5/10 < 70%): **3 pass** (Serum: both OSC "Default" labels + filter
exactly as carded; Vital 545: "Basic Shapes" square visible; Vital effects 204:
"Soft Clip"/Drive/Mix/Cutoff all literally visible), **5 fail** — and the failure
mode is consistent and diagnostic: the VLM identifies plugins CORRECTLY when the
name is visible in the frame (Vital/Serum logos, the Decapitator nameplate) and
**guesses a famous lookalike when it isn't**: a Waves F6 became "PRO-Q 3", a Waves
Vitamin became "Vision", Vital's effects rack became "Harmor". The never-mislabel
confidence gate covered PARAMS but not PLUGIN IDENTITY. NL descriptions were
consistently faithful to the transcript (no failures observed on criterion c).

**Disposition.** The audit's kill stands for the pilot AS BUILT. Unlike the OCR
teardown (param recall ≈0, nothing salvageable), this failure is narrow and cheap to
retest: (1) gate plugin identity with its own confidence + "name must be READ, not
inferred" instruction; (2) corroborate identity across 2 frames of the same segment;
(3) restrict identification to a CLOSED vocabulary — the owner's actual plugin list
(via `list_plugins`) + the natives — which converts open-set guessing into
verification. A revised pilot re-runs the same 10-card audit; the same 70% bar
applies. Until it passes, no card feeds mix polish or the style vocabulary.

## Where it plugs in

Pass → scale spec: the owner's full plugin list via `list_plugins`, NL query → card
retrieval → chain suggestion compiled through `service/teardown/render/fx.py` (native
analogs where they exist, his real VST3s via `load_plugin`/`set_plugin_param`), and
the style-vocabulary encyclopedia rides the same transcript+context extraction.
Fail → the audit's kill stands; park.
