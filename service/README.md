# Mosh Generative Service

A **separate Python process** from the Mosh C++ DAW. The C++ app's *Generative Job
Manager* spawns this process and talks to it over a local HTTP + file/manifest
protocol. This is **not** built by CMake — it ships and runs alongside the app.

For **Stage 0** the service only needs to answer a **health check**. The heavy
generative work (StableAudio3 / MLX, Apple Silicon only) lands much later and stays
**external/optional**.

## Zero-dependency constraint (load-bearing)

The Stage-0 health stub and the future `FakeAdapter` have **ZERO external Python
dependencies** — standard library only (`http.server`, `json`, `argparse`). No
FastAPI, no uvicorn, no numpy.

This is intentional: the stub and the `FakeAdapter` must run **anywhere / in CI**
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

### Unknown routes

`404` with:

```json
{ "ok": false, "error_code": "NOT_FOUND" }
```

## Architecture

- `server.py` — stdlib-only HTTP server. Adapter selection is **module-level**
  (`ADAPTER`) so concrete adapters plug in later without touching the HTTP layer.
- `adapters/fake_adapter.py` — `FakeAdapter`, the dependency-free placeholder.
  Stage 0 is a class skeleton + capability reporting only. The full job protocol
  (submit / status / progress / cancel + warmup / heartbeat / crash-restart /
  cancel-on-close) is specified in **module 05** and implemented in **Stage 5**.
  See the `# VERIFY` note in that file.
- The real `StableAudio3Adapter` (MLX) arrives later, behind the same interface,
  and stays external/optional.
