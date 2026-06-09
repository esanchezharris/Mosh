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
