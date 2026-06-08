# Mosh Generative Service

A **separate Python process** from the Mosh C++ DAW. The C++ app's *Generative Job
Manager* spawns this process and talks to it over a local HTTP + file/manifest
protocol. This is **not** built by CMake — it ships and runs alongside the app.

The service answers a **health check** and runs the generative **job protocol**:
submit a render job, poll its status/progress, and cancel it. Audio is returned over
**files + manifests** (a WAV plus a sidecar manifest JSON), never inline in the HTTP
body. The deterministic **FakeAdapter** (the default) proves the whole orchestration
without a model; the real **`StableAudio3Adapter`** (CUDA, the PC build) plugs in
behind the same interface.

## Adapter selection (`MOSH_ADAPTER`)

`ADAPTER = load_adapter(os.environ["MOSH_ADAPTER"])` — chosen by env, default `fake`:

| `MOSH_ADAPTER`   | Adapter                | Deps                                   |
| ---------------- | ---------------------- | -------------------------------------- |
| `fake` (default) | `FakeAdapter`          | **none** (stdlib only — CI/tests)      |
| `stable_audio_3` | `StableAudio3Adapter`  | torch (CUDA) + `stable_audio_3` + soundfile |

The SA3 adapter is imported **lazily**, so the Fake path never pulls in torch. Launch
the service with a python that has the heavy stack (set `MOSH_SERVICE_PYTHON` to that
venv); the C++ host passes `MOSH_ADAPTER` / `MOSH_SA3_MODEL_DIR` through to the child.
SA3 env: `MOSH_SA3_MODEL_DIR` (model_config.json + model.safetensors), `MOSH_SA3_HALF`
(fp16), `MOSH_SA3_MAX_DURATION` (OOM cap). On startup the SA3 adapter `warmup()`s the
model on a background thread so the first render isn't a multi-minute stall.

## Zero-dependency constraint (load-bearing)

The health stub and the `FakeAdapter` job protocol have **ZERO external Python
dependencies** — standard library only (`http.server`, `json`, `threading`, `uuid`,
`wave`, `struct`, `math`, `os`, `time`, `argparse`). No FastAPI, no uvicorn, no numpy.
WAVs are written with the stdlib `wave` module.

This is intentional: the service and the `FakeAdapter` must run **anywhere / in CI**
without the heavy SA3/MLX stack. The real `StableAudio3Adapter` (MLX) is added much
later as an optional, external component and never becomes a hard dependency of this
service.

Any stdlib Python **3.11+** works.

## Running it

PowerShell (Windows):

```powershell
.\run.ps1                  # 127.0.0.1:8765
.\run.ps1 -Port 9000       # custom port
```

bash (macOS / Linux):

```bash
./run.sh                   # 127.0.0.1:8765
./run.sh --port 9000       # custom port
```

Directly:

```powershell
py -3.12 server.py --host 127.0.0.1 --port 8765
```

```bash
python3 server.py --host 127.0.0.1 --port 8765
```

Stop with **Ctrl-C** (graceful shutdown; the C++ host may also send `SIGTERM`).

### Arguments

| Flag     | Default     | Description   |
| -------- | ----------- | ------------- |
| `--host` | `127.0.0.1` | Bind address. |
| `--port` | `8765`      | Bind port.    |

## Endpoints

### `GET /health`

`200` with:

```json
{
  "ok": true,
  "service": "mosh-generative",
  "version": "0.0.0",
  "adapter": "fake",
  "capabilities": { "generate": true, "reimagine": true }
}
```

### `GET /capabilities`

`200` with just the capability block:

```json
{ "capabilities": { "generate": true, "reimagine": true } }
```

### `POST /jobs`

Submit a render job. The render runs on a background daemon thread; the call returns
immediately with a job id to poll.

Request body (JSON):

```json
{
  "jobId": "optional-caller-id",
  "mode": "generate",
  "prompt": "warm analog pad",
  "colors": ["warm", "tape"],
  "seed": 42,
  "cacheKey": "fp-AAA-deterministic",
  "outDir": "/abs/path/to/output/dir",
  "durationSec": 1.0
}
```

| Field         | Type       | Required | Notes                                                  |
| ------------- | ---------- | -------- | ------------------------------------------------------ |
| `jobId`       | str        | no       | Generated (uuid4 hex) when omitted. Names the output files. |
| `mode`        | str        | yes      | `"generate"` or `"reimagine"`.                         |
| `prompt`      | str        | yes      | Text prompt (recorded; does not affect the Fake audio). |
| `colors`      | [str]      | no       | Color tags (recorded).                                 |
| `seed`        | int        | no       | Recorded in the manifest.                              |
| `cacheKey`    | str        | yes      | Full fingerprint. **The audio is a stable function of this.** |
| `outDir`      | str        | yes      | Directory for `<jobId>.wav` + `<jobId>.manifest.json` (created if missing). |
| `durationSec` | float      | no       | Render length. Default `1.0` (Fake) / `4.0` (SA3).     |
| `cfg`         | float      | no       | (SA3) classifier-free guidance scale. Default `1.0`.   |
| `steps`       | int        | no       | (SA3) diffusion steps. Default `8` (distilled).        |
| `nl`          | float      | no       | (SA3, reimagine) `init_noise_level` ≤ 0.5.             |
| `inputWavPath`| str        | no       | (SA3, reimagine) source audio file (audio-to-audio).   |
| `inputStartSec` / `inputLengthSec` | float | no | (SA3, reimagine) source region to use. |

(The FakeAdapter ignores the SA3-only extras.)

`200` with:

```json
{ "ok": true, "jobId": "c31ca7086eec4d969ba22782d4e5403b", "status": "queued" }
```

Malformed JSON → `400 { "ok": false, "error_code": "BAD_JSON" }`. Missing a required
field → `400 { "ok": false, "error_code": "BAD_REQUEST", "error": "..." }`.

### `GET /jobs/<jobId>`

Poll a job. `status` is one of `queued` / `running` / `done` / `error` / `canceled`;
`progress` runs `0.0 → 1.0`.

`200` while running:

```json
{ "ok": true, "jobId": "c31ca70...", "status": "running", "progress": 0.5 }
```

`200` when done — `manifest` describes the audio handoff:

```json
{
  "ok": true,
  "jobId": "c31ca70...",
  "status": "done",
  "progress": 1.0,
  "manifest": {
    "wavPath": "/abs/path/.../c31ca70....wav",
    "manifestPath": "/abs/path/.../c31ca70....manifest.json",
    "cacheKey": "fp-AAA-deterministic",
    "adapter": "fake",
    "durationSec": 1.0,
    "sampleRate": 44100,
    "channels": 1,
    "seed": 42
  }
}
```

The same manifest dict is also written to `<outDir>/<jobId>.manifest.json`. The WAV is
mono 16-bit PCM at 44.1 kHz. **Determinism:** identical `cacheKey` → byte-identical
WAV (regardless of prompt/seed/outDir); any `cacheKey` change moves the audio.

On failure → `status: "error"` with an `error` string. Unknown job id →
`404 { "ok": false, "error_code": "NO_SUCH_JOB" }`.

### `DELETE /jobs/<jobId>`

Cooperatively cancel a queued/running job. The worker stops producing and removes any
partial WAV; a job that already finished keeps its terminal status.

`200` with:

```json
{ "ok": true, "status": "canceled" }
```

Unknown job id → `404 { "ok": false, "error_code": "NO_SUCH_JOB" }`.

### Example (PowerShell)

```powershell
$body = @{ mode="generate"; prompt="warm pad"; colors=@("warm"); seed=42;
           cacheKey="fp-AAA"; outDir="$env:TEMP\mosh"; durationSec=1.0 } | ConvertTo-Json
$job = Invoke-RestMethod -Uri http://127.0.0.1:8765/jobs -Method Post `
         -Body $body -ContentType application/json
do {
    Start-Sleep -Milliseconds 100
    $s = Invoke-RestMethod -Uri "http://127.0.0.1:8765/jobs/$($job.jobId)"
} while ($s.status -in @("queued","running"))
$s.manifest.wavPath   # -> the rendered WAV on disk
```

### Unknown routes

`404` with:

```json
{ "ok": false, "error_code": "NOT_FOUND" }
```

## Architecture

- `server.py` — stdlib-only HTTP server + `JobManager` (in-memory job store; each
  render runs on its own background daemon thread so a long render never blocks the
  accept loop). Adapter selection is **module-level** (`ADAPTER`) so concrete
  adapters plug in later without touching the HTTP layer.
- `adapters/fake_adapter.py` — `FakeAdapter`, the dependency-free placeholder. It
  implements `render(request, on_progress, is_canceled)`: deterministic mono 16-bit
  PCM keyed by `cacheKey`, written via the stdlib `wave` module, plus a sidecar
  manifest. Cooperative cancellation deletes any partial WAV.
- `adapters/stable_audio3_adapter.py` — `StableAudio3Adapter`, the real CUDA model.
  Same `render(...)` contract: **generate** (text→audio) and **reimagine**
  (audio-to-audio via SA3's `init_audio` + `init_noise_level`); per-step progress +
  cooperative cancel via the sampler `callback`; 24-bit stereo WAV via `soundfile`;
  prompt-text "colors" approximation (real activation-steering is deferred — needs the
  COLORRACK calibration data). Imported lazily; the model is cached for the process
  lifetime and preloaded by `warmup()`.
- `scripts/sa3_smoke.py` — standalone CUDA validation (load + generate + reimagine).
- **Deferred** (documented, not built): real color steering (COLORRACK_DATA), the
  judge-panel quality readout (pq/flags), and the init-latent cache (skip VAE
  re-encode on seed-only change). Correctness comes from the C++ full-fingerprint
  cache; these are quality/perf refinements.
