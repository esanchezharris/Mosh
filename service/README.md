# Mosh Generative Service

The generative layer is a local Python service. C++ talks to it over HTTP/JSON and
passes audio by file path, so the UI and MoshOps command schema stay unchanged
across Fake, Mac SA3, and future PC adapters.

## Canonical Endpoints

- `GET /health`
- `GET /capabilities`
- `GET /colors`
- `POST /submit`
- `GET /status?jobId=...`
- `POST /cancel`
- `POST /transcribe` — audio→MIDI (Basic Pitch); isolated venv, 503 if absent
- `POST /sketch` — beatbox→drum hits (Sketch Phase 0); isolated venv, 503 if absent
- `POST /generate_recipe` — real-recipe retrieval/recombination; returns a Recipe plus
  its compiled MoshOps program for native `generate_beat_recipe`

The canonical adapter id is `stable_audio3`. The dependency-free `fake` adapter is
always available and is the default for PC gates unless real SA3 is explicitly
enabled.

## Tutorial scouting

- `service/teardown/` contains the instruction-first tutorial scouting workflow
  used to rank beat tutorials before teardown work starts.
- `python3 service/teardown/scout_test.py` runs the deterministic smoke for the
  prompt, scorer, and SQLite catalog.
- `python3 service/teardown/discovery_smoke_test.py` runs mocked YouTube discovery
  through enrichment, ranking, and catalog persistence without a real key.
- `python3 service/teardown/cli.py prompt` prints the agent instructions.
- `python3 service/teardown/cli.py score --input candidates.json --catalog service/teardown/catalog.sqlite`
  scores manual/no-key candidate JSON.
- `python3 service/teardown/cli.py discover --api-key-file "/path/to/youtube_api_key.txt" --template-id serum-from-scratch --max-results 2 --limit 10 --catalog service/teardown/catalog.sqlite`
  queries the YouTube Data API, scores returned tutorials, and persists them to
  the scout catalog. The key is read at runtime and is not written to the catalog
  or command output.
- Add `--verify-frames` to sample transient local frames under
  `.cache/mosh-teardown/frames/` using `yt-dlp` and `ffmpeg` when available.
  Frame verification runs OCR/CV over sampled images with local `tesseract` and
  Pillow when present, then falls back to metadata-only evidence if those tools
  are unavailable.
- `python3 service/teardown/cli.py queue --catalog service/teardown/catalog.sqlite --limit 10`
  prints the current ranked queue.
- `python3 service/teardown/cli.py export-jobs --catalog service/teardown/catalog.sqlite --out service/teardown/teardown_jobs.jsonl`
  writes resumable teardown jobs for `ideal` and `usable` rows without re-crawling
  YouTube.

## Mac SA3

The Mac baseline uses the carved MLX implementation under `service/sa3/`.
Configure it with:

- `MOSH_ENABLE_SA3=1`
- `SA3_MLX_DIR` pointing at the Stable Audio 3 MLX checkout
- `COLORRACK_DATA` when overriding the bundled color-rack data
- `MOSH_SELFTEST_SA3=1` for the gated real-model selftest

If the MLX model path is absent, the service advertises FakeAdapter only and the
regular command-surface gates still run.

## Recipe Generation Runtime

Recipe generation imports the teardown/recipe stack, so launch the service with the
teardown interpreter when driving `/generate_recipe` from native Mosh:

```bash
MOSH_SERVICE_PYTHON=$PWD/service/teardown/.venv/bin/python \
MOSH_RECIPE_LIBRARY=.cache/mosh-teardown/midi-ingredients/<run>/library \
MOSH_PALETTE_MANIFEST=<manifest.json> \
service/run.sh
```

`service/run.sh` honors `MOSH_SERVICE_PYTHON` before auto-selecting the SA3 venv or
system Python.

For Finder/Dock launches, stage the non-secret recipe runtime under
`~/Library/Mosh/recipe-runtime/<run>` and put those machine-local settings in
`service/.recipe.env` before running `./run-mosh.sh deploy`; deploy copies that
file into `Contents/Resources/service/.recipe.env` so the bundled `run.sh` can
find the interpreter and corpus without shell env inheritance:

```bash
MOSH_RECIPE_RUNTIME="$HOME/Library/Mosh/recipe-runtime/2026-07-01-r2"
export MOSH_SERVICE_PYTHON="/opt/homebrew/opt/python@3.14/bin/python3.14"
export PYTHONPATH="$MOSH_RECIPE_RUNTIME/python/site-packages${PYTHONPATH:+:$PYTHONPATH}"
export MOSH_RECIPE_LIBRARY="$MOSH_RECIPE_RUNTIME/library"
export MOSH_PALETTE_MANIFEST="$MOSH_RECIPE_RUNTIME/palette/manifest.json"
```

## PC Notes

Windows gates launch the service through `python`/`py` instead of `run.sh`; macOS
uses `run.sh`. Use `MOSH_SERVICE_PYTHON` to force a specific interpreter on either
path. CUDA SA3 compatibility must
remain behind the same `/submit` protocol and `stable_audio3` adapter id; it must
not change the MoshOps commands, UI contract, JSONL schema, or replay fields.
