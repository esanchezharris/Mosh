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

The canonical adapter id is `stable_audio3`. The dependency-free `fake` adapter is
always available and is the default for PC gates unless real SA3 is explicitly
enabled.

## Type-Beat LoRA Training

The training sidecar reuses the same local HTTP job-service pattern and exposes:

- `GET /training/health`
- `GET /training/capabilities`
- `GET /training/sources`
- `GET /training/state`
- `POST /training/import-registry`
- `POST /training/submit` (compat mode used by `MoshOps`)
- `POST /training/jobs` (canonical remote contract; accepts `corpusBundle`/`outputDir`
  and `corpus_bundle`/`output_dir`)
- `GET /training/status?jobId=...`
- `GET /training/jobs/<jobId>`
- `POST /training/cancel`
- `POST /training/activate`

The trainer reads `service/training/rights_registry.json`, builds deterministic
corpus bundles under `service/training/corpora/`, and emits a LoRA artifact plus
manifest.

Backend behavior is selected at runtime by environment:

- `MOSH_TRAINING_BACKEND=fake` (default): local fake trainer that writes
  `json_stub` outputs.
- `MOSH_TRAINING_REMOTE_URL=<http://host:port>`: posts training jobs to a remote
  GPU trainer service over HTTP and polls for completion.

The remote contract is: `POST /training/jobs` with a zip-encoded bundle and
config in JSON, then poll the returned status URL until ready and fetch
artifact/manifest either by inline fields or URLs. `/training/jobs/<jobId>` can
also be polled directly. The same contract is intentionally kept close to the
local `/training/submit` model.

The canonical training adapter id is `lora_trainer`. The default backend is a
dependency-free fake path so the workflow can be verified locally before a real
GPU backend is introduced.

## Mac SA3

The Mac baseline uses the carved MLX implementation under `service/sa3/`.
Configure it with:

- `MOSH_ENABLE_SA3=1`
- `SA3_MLX_DIR` pointing at the Stable Audio 3 MLX checkout
- `COLORRACK_DATA` when overriding the bundled color-rack data
- `MOSH_SELFTEST_SA3=1` for the gated real-model selftest

If the MLX model path is absent, the service advertises FakeAdapter only and the
regular command-surface gates still run.

## PC Notes

Windows gates launch the service through `python`/`py` instead of `run.sh`. Use
`MOSH_SERVICE_PYTHON` to force a specific interpreter. CUDA SA3 compatibility must
remain behind the same `/submit` protocol and `stable_audio3` adapter id; it must
not change the MoshOps commands, UI contract, JSONL schema, or replay fields.
