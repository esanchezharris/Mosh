#!/usr/bin/env python3
"""Local open-weights generation behind the bench's provider seam (FMS WS1 / M1).

Stdlib-only façade over `_localgen_worker.py`, mirroring `torchjudge.py`: the heavy
half runs in a SUBPROCESS under an interpreter that has mlx-lm, so this module —
and its tests — import under system python3 with no MLX present.

Why a local model at all: the API providers expose no logit seam
(`brain_client.chat_json` is a urllib POST to /chat/completions), so a phonology
constraint can only ever be a *suggestion* there. Owning the decoder is what turns
it into a guarantee. That is the whole point of M1; M2 is what spends it.

Three rules inherited from `torchjudge`, each of which has already saved this
program from a fabricated number:

  * **Absent interpreter → `unavailable`, no candidates.** Never a fabricated
    fill, and never a quiet fall back to another arm — that would launder some
    other arm's score into this one's row.
  * **Provenance travels with the numbers.** Interpreter, model, revision, quant
    and tokenizer hash land in the summary. A score that cannot name its weights
    is not reproducible, it is just a number.
  * **Death is latched, not retried.** A silent respawn hides a real failure and
    re-pays a 30-second model load.

Process shape differs from torchjudge deliberately. Its judges are scored in one
batch outside the runner; an ARM is called per item, through the per-item result
cache, so a rerun with 149/150 cached must cost one generation and not 150. Hence
a lazily-spawned, long-lived worker rather than a one-shot batch: nothing is
loaded at all until the first cache miss.

**Cache namespace.** Local calls carry `cacheNamespace` and NO `messages` key, so
their keys are disjoint from `ArmContext.cached_chat`'s by construction. That
matters: `cached_chat` keys on `{"messages", **kw}` with no model identity, so an
arm that reused `llm-constrained`'s messages here would silently be served
DeepSeek's cached answer and the local model would never run. Adding model
identity to `cached_chat` instead would re-key every existing arm and cold-miss
every response the program has already paid for.
"""
from __future__ import annotations

import atexit
import hashlib
import json
import os
import queue
import subprocess
import threading
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Sequence

HERE = os.path.dirname(os.path.abspath(__file__))
_WORKER = os.path.join(HERE, "_localgen_worker.py")

CACHE_NAMESPACE = "lyrics-bench/local-mlx/v1"

# Interpreters that may already carry mlx-lm on a dev Mac. The bench venv first
# (the convention); `sft` is where the SFT lane already installed it. Whichever
# wins is recorded in the manifest.
_CANDIDATE_VENVS = ("lyrics-bench", "sft", "transform", "nsf")

DEFAULT_ADAPTER = os.environ.get("LYRICS_BENCH_MLX_ADAPTER", "")
DEFAULT_MODEL = os.environ.get("LYRICS_BENCH_LOCAL_MODEL",
                               "mlx-community/Qwen2.5-14B-Instruct-4bit")

HELLO_TIMEOUT_S = 900     # a cold start may include an ~8.5 GB download
CALL_TIMEOUT_S = 300


# ── interpreter discovery ────────────────────────────────────────────────────────

def _probe(python: str) -> bool:
    if not (python and os.path.exists(python) and os.access(python, os.X_OK)):
        return False
    try:
        r = subprocess.run(
            [python, "-c", "import importlib.util as u,sys;"
                           "sys.exit(0 if u.find_spec('mlx_lm') else 1)"],
            capture_output=True, timeout=120)
        return r.returncode == 0
    except Exception:  # noqa: BLE001 — a broken interpreter is just "not it"
        return False


def resolve_python() -> Optional[str]:
    """First interpreter that can import mlx_lm, or None."""
    override = os.environ.get("LYRICS_BENCH_MLX_PY")
    if override and _probe(override):
        return override
    root = os.environ.get("MOSH_VENVS_DIR") or os.path.expanduser("~/Library/Mosh/venvs")
    for name in _CANDIDATE_VENVS:
        cand = os.path.join(root, name, "bin", "python")
        if _probe(cand):
            return cand
    return None


# ── configuration ────────────────────────────────────────────────────────────────

@dataclass
class LocalConfig:
    model: str = DEFAULT_MODEL
    revision: str = ""              # filled from the worker's hello when unpinned
    # LoRA adapter dir served via mlx_lm's adapter_path (I4). NEVER fused — the
    # r5 lesson: fusing into a 4-bit base kept ~17% of the delta. Rides the
    # cache payload + arm_config so an adapter swap re-keys instead of
    # replaying base-model generations. Env: LYRICS_BENCH_MLX_ADAPTER.
    adapter: str = DEFAULT_ADAPTER
    mode: str = "greedy"            # "greedy" | "sampled"
    run_seed: int = 0
    max_tokens: int = 24
    temp: float = 0.8
    top_p: float = 0.95
    k: int = 5
    resample_budget: int = 8

    def sampler(self) -> Dict[str, float]:
        return {"temp": float(self.temp), "top_p": float(self.top_p)}

    def arm_config(self, extra: Optional[Dict] = None) -> Dict:
        """What lands in the run summary and in the arm-result cache key. Model
        identity lives HERE rather than in the arm name: the scoreboard groups by
        name, so baking `qwen2.5-14b-i4` into it makes every model swap a new row.

        `adapter` joins ONLY when set — the 2026-07-28 review caught the asdict
        default silently carrying `"adapter": ""` into every arm-result key,
        cold-missing all pre-adapter local runs and breaking
        MOSH_INFILL_CACHE_ONLY replays of them. Same conditional discipline as
        `payload_for`, at the layer the first fix missed."""
        out = {k: v for k, v in asdict(self).items()}
        if not out.get("adapter"):
            out.pop("adapter", None)
        out.update(extra or {})
        return out


def item_seed(item_id: str, item_sha: str, cfg: LocalConfig) -> int:
    """Per-ITEM seed, so a batch's RNG state cannot leak across items.

    Mirrors `mask.item_seed`'s convention in a separate namespace. `item_sha` is
    in the mix because an eval rebuild can re-mask the same itemId onto a
    different target — the seed has to move with the content, not just the id.
    """
    blob = (f"lyrics-bench/localgen/v1|{cfg.model}|{cfg.revision}|{cfg.mode}"
            f"|{cfg.run_seed}|{item_id}|{item_sha}")
    return int.from_bytes(hashlib.sha256(blob.encode("utf-8")).digest()[:4], "big")


def payload_for(op: str, *, prompt: str, cfg: LocalConfig, seed: int,
                backend: Dict, extra: Optional[Dict] = None) -> Dict:
    """The generation-cache payload. Deliberately carries NO `messages` key — see
    the module docstring on namespace disjointness."""
    payload = {
        "cacheNamespace": CACHE_NAMESPACE,
        "op": op,
        "model": cfg.model,
        "modelRevision": backend.get("revision") or cfg.revision,
        "quant": backend.get("quant") or {},
        "tokenizerSha": backend.get("tokenizerSha") or "",
        "chatTemplateSha": backend.get("chatTemplateSha") or "",
        "promptSha": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
        "mode": cfg.mode,
        "seed": int(seed),
        "maxTokens": int(cfg.max_tokens),
        "sampler": cfg.sampler() if cfg.mode == "sampled" else {},
    }
    # CONDITIONAL: an adapter joins the key only when one is configured, so
    # every base-model response already cached keeps its key byte-for-byte.
    if cfg.adapter:
        payload["adapter"] = cfg.adapter
    payload.update(extra or {})
    return payload


# ── the worker handle ────────────────────────────────────────────────────────────

class Worker:
    """A lazily-spawned, long-lived `_localgen_worker.py` speaking line-JSON.

    `readline()` has no timeout, so a daemon reader thread feeds a queue and every
    wait has a deadline. Once the worker dies it stays dead: `alive` latches False
    and every later call short-circuits to `unavailable`.
    """

    def __init__(self, python: Optional[str] = None, cfg: Optional[LocalConfig] = None,
                 worker_script: str = _WORKER):
        self.python = python
        self.cfg = cfg or LocalConfig()
        self.worker_script = worker_script
        self.proc: Optional[subprocess.Popen] = None
        self.backend: Dict[str, Any] = {}
        self.error: str = ""
        self.dead = False
        self._q: "queue.Queue[Optional[str]]" = queue.Queue()
        self._reader: Optional[threading.Thread] = None

    # -- lifecycle --

    def _pump(self, stdout) -> None:
        try:
            for line in stdout:
                self._q.put(line)
        finally:
            self._q.put(None)          # EOF sentinel

    def start(self) -> bool:
        if self.dead:
            return False
        if self.proc is not None:
            return True
        py = self.python or resolve_python()
        if not py:
            self._die("no interpreter with mlx_lm found "
                      "(set LYRICS_BENCH_MLX_PY or run setup-lyrics-bench.sh --mlx)")
            return False
        self.python = py
        try:
            self.proc = subprocess.Popen(
                [py, self.worker_script], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, bufsize=1)
        except Exception as e:  # noqa: BLE001
            self._die(f"worker launch failed: {e}")
            return False
        self._reader = threading.Thread(target=self._pump, args=(self.proc.stdout,),
                                        daemon=True)
        self._reader.start()
        atexit.register(self.close)
        hello = self._call({"op": "hello", "model": self.cfg.model,
                            "revision": self.cfg.revision or None,
                            "adapter": self.cfg.adapter or None},
                           timeout=HELLO_TIMEOUT_S)
        if not hello.get("ok"):
            self._die(hello.get("error") or "worker handshake failed")
            return False
        self.backend = {k: hello.get(k) for k in
                        ("python", "model", "revision", "adapter", "quant",
                         "tokenizerSha", "chatTemplateSha", "eosId",
                         "mlxLmVersion")}
        self.backend["python"] = py
        return True

    def _die(self, why: str) -> None:
        self.dead = True
        self.error = why
        self.close()

    def close(self) -> None:
        proc, self.proc = self.proc, None
        if proc is None:
            return
        try:
            if proc.stdin and not proc.stdin.closed:
                proc.stdin.close()          # worker's readline() → '' → clean exit
            proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass

    # -- transport --

    def _call(self, request: Dict, *, timeout: float = CALL_TIMEOUT_S) -> Dict:
        proc = self.proc
        if proc is None or proc.stdin is None:
            return {"ok": False, "error": self.error or "worker not running"}
        try:
            proc.stdin.write(json.dumps(request) + "\n")
            proc.stdin.flush()
        except Exception as e:  # noqa: BLE001
            self._die(f"worker stdin closed: {e}")
            return {"ok": False, "error": self.error}
        try:
            line = self._q.get(timeout=timeout)
        except queue.Empty:
            self._die(f"worker timed out after {timeout:.0f}s on op={request.get('op')}")
            return {"ok": False, "error": self.error}
        if line is None:
            stderr = ""
            try:
                stderr = (proc.stderr.read() or "").strip()[-500:]
            except Exception:  # noqa: BLE001
                pass
            self._die(f"worker exited: {stderr or 'no stderr'}")
            return {"ok": False, "error": self.error}
        try:
            return json.loads(line)
        except Exception as e:  # noqa: BLE001
            self._die(f"worker output unparseable: {e}")
            return {"ok": False, "error": self.error}

    def request(self, req: Dict, *, timeout: float = CALL_TIMEOUT_S) -> Dict:
        """Public call: starts the worker on first use, short-circuits once dead."""
        if self.dead:
            return {"ok": False, "error": self.error, "status": "unavailable"}
        if not self.start():
            return {"ok": False, "error": self.error, "status": "unavailable"}
        return self._call(req, timeout=timeout)


# ── the generation entry points ──────────────────────────────────────────────────

def _unavailable(err: str) -> Dict:
    """The honest empty result. `candidates: []` and a named reason — NEVER a
    fabricated fill, and never someone else's answer."""
    return {"status": "unavailable", "candidates": [], "error": err, "backend": None}


def generate(worker: Worker, *, op: str, prompt: str, cfg: LocalConfig, seed: int,
             cache=None, extra_request: Optional[Dict] = None,
             extra_key: Optional[Dict] = None) -> Dict:
    """One generation, cached on the disjoint local namespace.

    The worker is only started on a cache MISS, so a fully-replayed run never
    loads the model at all.
    """
    if worker.dead:
        return _unavailable(worker.error)

    def _fresh() -> Dict:
        req = {"op": op, "prompt": prompt, "mode": cfg.mode, "seed": int(seed),
               "maxTokens": int(cfg.max_tokens), "sampler": cfg.sampler(),
               "k": int(cfg.k), "resampleBudget": int(cfg.resample_budget)}
        req.update(extra_request or {})
        out = worker.request(req)
        if not out.get("ok"):
            return {"status": "unavailable", "candidates": [],
                    "error": out.get("error") or "worker call failed", "backend": None}
        out["status"] = "ok"
        out["backend"] = worker.backend
        return out

    if cache is None:
        return _fresh()
    # The payload needs the worker's identity (revision / tokenizer sha), which
    # only the worker can report — so a cold cache must hand-shake first. When the
    # handshake fails there is nothing to key on and nothing to serve.
    if not worker.backend and not worker.start():
        return _unavailable(worker.error)
    key_payload = payload_for(op, prompt=prompt, cfg=cfg, seed=seed,
                              backend=worker.backend, extra=extra_key)
    return cache.cached_call(key_payload, _fresh)


def tokenize_pool(pool: Sequence[str], *, python: Optional[str] = None,
                  cfg: Optional[LocalConfig] = None) -> Dict:
    """Encode every variant of every pool word with the REAL tokenizer.

    Used by the opt-in trie smoke test: a fake vocabulary proves the trie logic
    and says nothing about whether Qwen's BPE can reach a real 200-word menu.
    """
    from lyrics.bench import endword_trie as et
    w = Worker(python=python, cfg=cfg or LocalConfig())
    try:
        forms: List[str] = []
        for word in pool:
            forms.extend(et.word_variants(word))
        out = w.request({"op": "tokenize", "forms": sorted(set(forms))})
        if not out.get("ok"):
            return {"ok": False, "error": out.get("error") or "tokenize failed"}
        return {"ok": True, "pool": list(pool), "encoded": out.get("encoded") or {},
                "backend": w.backend}
    finally:
        w.close()
