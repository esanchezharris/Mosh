"""In-process SA3-Medium engine (05 §6, App. B) — carved from the research spike's
`mlx_inproc.py`. Loads T5Gemma + conditioner + DiT-medium + SAME-L decoder ONCE and
serves generate / re-imagine. Owned by the single worker thread in `server.py`:
NOT thread-safe (the loaded model is process-global and mutated per call), so it must
never be called concurrently.

Runs only under `$SA3_MLX_DIR/.venv/bin/python` (needs mlx + the SA3 model code). The
two carve paths from `mlx_inproc.py` are preserved verbatim: the load sequence and the
`gen()` decode path (steering setup, pingpong schedule with `sigma_max=init_noise_level`,
init-mix `init_lat*(1-σ) + noise*σ`, decode + `save_wav`). The two hardcoded paths
become env vars `SA3_MLX_DIR` (model) and — for colours — `COLORRACK_DATA`.

DURATION: `SA3_SECONDS` (default 8s) sets the INITIAL latent grid, but the length is
retargeted per-clip via `set_seconds()` — the DiT is length-agnostic (RoPE), so a clip
renders in ONE contiguous pass at its own length (up to `MAX_CONTIGUOUS`). This is the
contiguous-first path; the coverage stitch fallback only covers clips past the ceiling.
"""
from __future__ import annotations

import gc
import math
import os
import shutil
import sys
import threading

SA3_MLX_DIR = os.environ.get("SA3_MLX_DIR") or os.path.expanduser(
    "~/AI/stable-audio-3/optimized/mlx")
SECONDS = float(os.environ.get("SA3_SECONDS", "8.0"))   # pins the latent grid (see header)

# Bump when the runtime LoRA-apply math changes — folded into the service build so
# the native render-cache invalidates (mirrors the old MERGE_VERSION role).
LORA_APPLY_VERSION = "2"   # 2: sha-keyed apply + server-side trigger injection (hybrid)

# Contiguous-render policy: render a clip at its OWN length (one smooth pass — no windowing
# seams) up to a ceiling; beyond it the coverage stitch fallback takes over. Length is
# retargeted per-clip via Engine.set_seconds — the DiT is length-agnostic (RoPE positions;
# weights independent of T_lat), so retargeting is ~free (no weight reload) and byte-identical
# to a fresh engine at that length. Bump to invalidate the render cache if this policy changes.
CONTIGUOUS_VERSION = "1"
MAX_CONTIGUOUS = float(os.environ.get("MOSH_SA3_MAX_CONTIGUOUS", "240.0"))  # ceiling (memory-bound; ≥4min verified)
MIN_SECONDS = float(os.environ.get("MOSH_SA3_MIN_SECONDS", "2.0"))          # floor (avoid a degenerate tiny grid)
_OWNER_COMMAND_DIRS = ("/opt/homebrew/bin", "/usr/local/bin")


def clamp_render_seconds(clip_len) -> float:
    """The length to render a clip at: its own length, clamped to [MIN_SECONDS, MAX_CONTIGUOUS]."""
    return float(max(MIN_SECONDS, min(float(clip_len), MAX_CONTIGUOUS)))


def _ensure_command_on_path(command: str, fallback_dirs: tuple[str, ...] = _OWNER_COMMAND_DIRS) -> str | None:
    resolved = shutil.which(command)
    if resolved is not None:
        return resolved

    current_path = os.environ.get("PATH", "")
    path_dirs = current_path.split(os.pathsep) if current_path else []
    for directory in fallback_dirs:
        candidate = os.path.join(directory, command)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            if directory not in path_dirs:
                os.environ["PATH"] = directory + (os.pathsep + current_path if current_path else "")
            return candidate
    return None

_engine = None
_engine_lock = threading.Lock()


def engine_available() -> bool:
    """True if the SA3 model code + dir are present (gates the capability + /health)."""
    return os.path.isdir(SA3_MLX_DIR) and os.path.isfile(
        os.path.join(SA3_MLX_DIR, "scripts", "sa3_mlx.py"))


def get_engine():
    """Lazily construct the singleton (heavy: ~seconds, first SA3 job only)."""
    global _engine
    _ensure_command_on_path("ffmpeg")
    with _engine_lock:
        if _engine is None:
            _engine = _Engine()
        return _engine


def loaded() -> bool:
    """Is the model currently resident? (~9.2 GB when true.)"""
    return _engine is not None


def unload() -> bool:
    """Drop the singleton and hand MLX's memory back. True if something was freed.

    Measured on the reference Mac: the resident model is **9.2 GB** (service
    footprint 30 MB -> 9,168 MB after one render), and this genuinely returns it
    — a probe that built the engine, evaluated conditioning, then dropped it and
    called `clear_cache()` went **5,935 MB -> 451 MB**. The next render pays a
    reload measured at **+1.1 s** (steady state 2.8 s keeping the model vs 3.9 s
    releasing between takes, 3 samples each in one process).

    That +1.1 s replaces an earlier +3.6 s estimate, which was wrong: it compared
    a cold PROCESS against a warm one and so charged this reload for Python
    startup and a cold page cache as well. The weights stay in the OS page cache
    across a release, which is most of why the real cost is small.

    Both halves are required. Dropping the reference alone leaves MLX holding
    the buffers in its own cache, so the memory does NOT come back and the only
    thing achieved is a 3.6 s reload later — the worst of both.

    MUST be called on the single MLX-owning thread (`server.py`'s render worker),
    for the same reason everything else touching MLX must: the state is
    thread-affine, not merely non-concurrent. Never call it with a render in
    flight — the engine is process-global and mutated per call.
    """
    global _engine
    with _engine_lock:
        if _engine is None:
            return False
        _engine = None

    gc.collect()
    try:
        import mlx.core as mx
        mx.clear_cache()
    except AttributeError:
        try:
            import mlx.core as mx
            mx.metal.clear_cache()   # older MLX
        except Exception as e:  # noqa: BLE001
            print(f"[sa3] clear_cache unavailable: {e}", flush=True)
    except Exception as e:  # noqa: BLE001 — mlx absent (FakeAdapter-only machine)
        print(f"[sa3] clear_cache skipped: {e}", flush=True)
    gc.collect()
    return True


class _Engine:
    def __init__(self):
        # Import the SA3 model code in place (no copy): mirrors mlx_inproc.py L16-23,
        # but reads SA3_MLX_DIR from env instead of the hardcoded ~/AI path.
        os.chdir(SA3_MLX_DIR)                              # weights resolve repo-relative
        if SA3_MLX_DIR not in sys.path:
            sys.path.insert(0, SA3_MLX_DIR)
        scripts = os.path.join(SA3_MLX_DIR, "scripts")
        if scripts not in sys.path:
            sys.path.insert(0, scripts)
        import numpy as np
        import mlx.core as mx
        import sa3_mlx as S

        self.np, self.mx, self.S = np, mx, S
        self.DTYPE, self.DEC_DTYPE = mx.float16, mx.float32
        self.SECONDS = SECONDS
        self.SAMPLES_PER_LATENT = S.SAMPLES_PER_LATENT
        self.T_LAT = max(1, math.ceil(SECONDS * S.SAMPLE_RATE / S.SAMPLES_PER_LATENT))
        self.STEPS = int(os.environ.get("SA3_STEPS", "8"))

        # Load once (mlx_inproc.py L38-44).
        self.enc = S.T5Gemma.from_npz(str(S.ensure_local(S.T5GEMMA_NPZ_REL)))
        self.padding_emb, self.secs_embedder = S.load_conditioner_from_npz(
            str(S.ensure_local(S.DIT_CHOICES["medium"]["ckpt"])), prefix="cond.")
        self.dit_model, self._stock_dit_ckpt = S.load_dit("medium", T_lat=self.T_LAT, dtype=self.DTYPE)
        self.decoder, _chunk_fn, _ = S.load_decoder("same-l", self.DEC_DTYPE)
        self._tf = self.dit_model.transformer
        # Time-scheduled steering: replace the transformer forward with a version
        # that honors an optional per-latent-position schedule on each steer (the
        # "Sustain" color). Byte-identical to stock when no steer carries a schedule.
        from sa3.scheduled_steer import install_scheduled_steer_patch
        install_scheduled_steer_patch()
        self._encoder = None
        # Runtime LoRA application (no disk bake, no reload): the DiT stays the stock
        # model; apply_loras reassigns just the touched weights IN PLACE and
        # restore_base reverts them. State that tracks the current application:
        self._stock_npz = None          # lazily-opened NpzFile for pristine base reads
        self._base_cache = {}           # npz_key -> pristine base as mx.array (or None)
        self._applied_key = None        # loras key currently applied (None=fresh, ""=stock)
        self._touched_keys = set()      # npz keys the current selection mutated

    def stock_dit_ckpt(self) -> str:
        """Absolute path of the unmodified DiT checkpoint (the LoRA base + cond.*)."""
        return self._stock_dit_ckpt

    # ── runtime LoRA application ────────────────────────────────────────────────
    def _base_npz(self):
        if self._stock_npz is None:
            self._stock_npz = self.np.load(self._stock_dit_ckpt)   # lazy, per-key reads
        return self._stock_npz

    def _base_weight(self, key):
        """Pristine stock weight for an npz key (numpy), or None if absent."""
        z = self._base_npz()
        return self.np.array(z[key]) if key in z.files else None

    def _base_mx(self, key):
        """Pristine stock weight as an mlx array (kept on device for the GPU math).
        Cached so a strength change re-uses it instead of re-reading the npz."""
        v = self._base_cache.get(key, False)
        if v is False:
            b = self._base_weight(key)
            v = None if b is None else self.mx.array(b)
            self._base_cache[key] = v
        return v

    def _compute_updated_mx(self, selection):
        """Runtime weights for a selection, computed on the GPU via lora_merge's
        shared apply_dora(xp=mx). Mirrors weights_for_selection exactly — reshapes
        1x1 convs, rounds to the stored dtype BETWEEN stacked LoRAs — so the result
        matches a disk bake to f16. Returns ({npz_key: mx.array}, report)."""
        import json
        from sa3 import lora_merge as LM
        mx, np = self.mx, self.np
        work = {}                       # key -> [mx weight (stored dtype), orig_shape]
        applied, skipped = 0, []
        for name, path, strength in selection:
            tensors, meta = LM.read_safetensors(path)     # numpy (small: rank-16 factors)
            cfg = json.loads(meta.get("lora_config", "{}")) if meta else {}
            rank = float(cfg.get("rank", 16))
            alpha = float(cfg.get("alpha", cfg.get("lora_alpha", rank)))
            adapter_type = cfg.get("adapter_type", "dora-rows")
            if adapter_type not in ("dora-rows", "dora", "lora"):
                raise ValueError(f"{name}: unsupported adapter_type {adapter_type!r}")
            scaling = alpha / rank
            for module, parts in sorted(LM.group_lora(tensors).items()):
                key = LM.map_module_to_npz_key(module)
                if key is None:
                    skipped.append(f"{name}:{module}")
                    continue
                if key not in work:
                    base = self._base_mx(key)
                    if base is None:
                        skipped.append(f"{name}:{module}")
                        continue
                    work[key] = [base, tuple(base.shape)]
                W, orig_shape = work[key]
                if W.ndim == 3 and W.shape[1] == 1:
                    W2 = W.reshape(W.shape[0], W.shape[2])
                elif W.ndim == 2:
                    W2 = W
                else:
                    skipped.append(f"{name}:{module}")
                    continue
                A, B = parts.get("lora_A"), parts.get("lora_B")
                if A is None or B is None or B.shape[0] != W2.shape[0] or A.shape[1] != W2.shape[1]:
                    skipped.append(f"{name}:{module}")
                    continue
                mag = None
                if adapter_type in ("dora-rows", "dora"):
                    m = parts.get("magnitude")
                    if m is None or m.shape[0] != W2.shape[0]:
                        skipped.append(f"{name}:{module}")
                        continue
                    mag = mx.array(m)
                V = LM.apply_dora(mx, W2, mx.array(A), mx.array(B), mag, adapter_type,
                                  scaling, strength)                     # f32, 2D
                work[key] = [V.astype(W.dtype).reshape(orig_shape), orig_shape]
                applied += 1
        return {k: v[0] for k, v in work.items()}, {"applied": applied, "skipped": skipped}

    def _assign(self, weights: dict) -> None:
        """Assign {npz_key: array (mx or numpy)} onto the live DiT (f16) + seconds
        conditioner (f32). Mirrors how load_dit / load_conditioner_from_npz consume
        each key. Evals only the reassigned arrays (not the whole 2.9GB model)."""
        mx = self.mx
        dit_updates = []
        for k, v in weights.items():
            arr = v if isinstance(v, mx.array) else mx.array(v)
            if k == "cond.seconds_total_weight":
                self.secs_embedder.W = arr.astype(mx.float32)   # embedder holds W as f32
            elif k.startswith("cond."):
                continue                                        # no other cond.* is mappable
            else:
                dit_updates.append((k, arr.astype(self.DTYPE)))
        if dit_updates:
            self.dit_model.load_weights(dit_updates, strict=False)
            mx.eval([a for _k, a in dit_updates])

    def apply_loras(self, selection, loras_key: str) -> dict:
        """Reassign DiT (+ cond) weights for a resolved LoRA selection, in place, on
        the GPU (no disk bake, no reload). `selection` = [(name, path, strength)];
        `loras_key` is a stable identity (idempotent — a repeat key is a no-op). An
        empty selection restores the stock weights. Returns the apply report."""
        if loras_key == self._applied_key:
            return {"applied": None, "skipped": [], "reused": True}
        self.restore_base()                                  # undo any prior application
        if not selection:
            self._applied_key = loras_key                    # now current (stock)
            return {"applied": 0, "skipped": [], "reused": False}
        updated, report = self._compute_updated_mx(selection)
        self._assign(updated)
        self._touched_keys = set(updated.keys())
        self._applied_key = loras_key
        report["reused"] = False
        return report

    def restore_base(self) -> None:
        """Reassign every currently-touched key back to its stock value."""
        if self._touched_keys:
            restore = {k: self._base_mx(k) for k in self._touched_keys}
            self._assign({k: v for k, v in restore.items() if v is not None})
            self._touched_keys = set()
        self._applied_key = None

    # ── carved from mlx_inproc._encode_audio ──
    def encode_init(self, path):
        S, mx, np = self.S, self.mx, self.np
        if self._encoder is None:
            self._encoder = S.load_encoder("same-l", mx.float32)[0]
        a = S.read_wav(path)                                          # (2, T)
        tgt = self.T_LAT * self.SAMPLES_PER_LATENT
        a = a[:, :tgt] if a.shape[-1] >= tgt else np.pad(a, ((0, 0), (0, tgt - a.shape[-1])))
        patches = S.patch_audio(a[None], patch_size=256)
        lat = self._encoder(mx.array(patches)); mx.eval(lat)
        return lat.astype(self.DTYPE)                                 # (1, 256, T_LAT)

    # ── training-precompute variants of encode_init/_cond ──────────────────
    #
    # These exist because LoRA training needs a DIFFERENT shape than rendering
    # does, and getting the difference wrong fails SILENTLY — the adapter
    # trains with a perfectly healthy loss curve and is simply wrong. Two
    # traps, both of which the parity test guards:
    #
    #  1. T_lat is PER SAMPLE here (ceil of the clip's own length), not the
    #     engine's fixed render grid. Training clips vary in length; padding
    #     them all to one grid would train the adapter on silence.
    #  2. `seconds_total` must be the clip's REAL pre-padding duration, not
    #     the padded length. It is the conditioning the model learns to
    #     answer, so a padded value teaches a wrong length↔content mapping.
    #
    # Both return RAW conditioning (pre-`to_cond_embed`) — the trainer applies
    # the projection itself, exactly as the DiT does at inference.
    def encode_for_training(self, path):
        """Encode one training clip → ((256, T_lat) latent, real seconds).

        Mirrors `encode_init` but sizes the latent grid to the clip instead of
        the render grid, and reports the clip's true duration.
        """
        S, mx, np = self.S, self.mx, self.np
        if self._encoder is None:
            self._encoder = S.load_encoder("same-l", mx.float32)[0]
        a = S.read_wav(path)                                          # (2, T)
        n_orig = a.shape[-1]
        seconds = n_orig / S.SAMPLE_RATE                              # REAL, pre-padding
        t_lat = max(1, math.ceil(n_orig / self.SAMPLES_PER_LATENT))
        tgt = t_lat * self.SAMPLES_PER_LATENT
        a = a[:, :tgt] if n_orig >= tgt else np.pad(a, ((0, 0), (0, tgt - n_orig)))
        patches = S.patch_audio(a[None], patch_size=256)              # (1, 512, t_lat*16)
        if patches.shape[-1] % 16 != 0:
            raise ValueError(f"SAME-L requires T_audio_patches % 16 == 0, got {patches.shape[-1]}")
        lat = self._encoder(mx.array(patches)); mx.eval(lat)
        return lat.astype(self.DTYPE)[0], seconds                     # (256, t_lat), float

    def cond_for_training(self, prompt, seconds):
        """Raw conditioning for one training clip → ((257,768), (768,)).

        Mirrors `_cond` but takes the clip's own duration rather than the
        engine's render length, and drops the batch dim for storage.
        """
        S, mx = self.S, self.mx
        embeds, mask = self.enc.encode([prompt], max_len=256)
        embeds = embeds.astype(self.DTYPE)
        embeds_padded = S.apply_prompt_padding(embeds, mask, self.padding_emb.astype(self.DTYPE))
        seconds_embed = self.secs_embedder(float(seconds)).astype(self.DTYPE)   # (1,1,768)
        cross_attn = mx.concatenate([embeds_padded, seconds_embed], axis=1)     # (1,257,768)
        mx.eval(cross_attn)
        return cross_attn[0], seconds_embed[0, 0, :]                            # (257,768), (768,)

    # ── carved from mlx_inproc._cond ──
    def _cond(self, prompt):
        S, mx = self.S, self.mx
        embeds, mask = self.enc.encode([prompt], max_len=256)
        embeds = embeds.astype(self.DTYPE)
        embeds_padded = S.apply_prompt_padding(embeds, mask, self.padding_emb.astype(self.DTYPE))
        seconds_embed = self.secs_embedder(self.SECONDS).astype(self.DTYPE)
        cross_attn = mx.concatenate([embeds_padded, seconds_embed], axis=1)
        return cross_attn, seconds_embed[:, 0, :]

    # ── carved from mlx_inproc.gen (decode-and-save path only; no activation dump) ──
    def _gen(self, prompt, seed, steers, out_wav, init_lat=None, init_noise_level=1.0):
        S, mx, np = self.S, self.mx, self.np
        cross_attn, global_cond = self._cond(prompt)
        self._tf._dump = None
        self._tf._steer_layer = -1; self._tf._steer_alpha = 0.0; self._tf._steer_vec = None
        # A steer may be (L, alpha, vec) [uniform] or (L, alpha, vec, envelope_spec).
        # The T-independent envelope is materialized to a [T_lat] per-position schedule
        # here (the engine owns T_lat); the patched forward multiplies it in.
        from sa3.scheduled_steer import build_envelope
        lat_s = self.SAMPLES_PER_LATENT / S.SAMPLE_RATE
        built = []
        for t in (steers or []):
            L, a, v = t[0], t[1], t[2]
            entry = (int(L), float(a), mx.array(np.asarray(v, dtype=np.float32)))
            sched = build_envelope(t[3] if len(t) > 3 else None, self.T_LAT, lat_s)
            if sched is not None:
                entry = entry + (mx.array(sched.astype(np.float32)),)
            built.append(entry)
        self._tf._steers = built
        sigma_max = float(init_noise_level)
        sigmas = S.build_pingpong_schedule(self.STEPS, sigma_max=sigma_max, use_logsnr_shift=True)
        pure = mx.random.normal((1, 256, self.T_LAT), dtype=self.DTYPE, key=mx.random.key(seed))
        noise = (init_lat * (1.0 - sigma_max) + pure * sigma_max) if init_lat is not None else pure
        mx.eval(noise)

        def model_fn(x, t):
            return self.dit_model(x, t, cross_attn, global_cond, local_add_cond=None)

        latents = S.sample_flow_pingpong(model_fn, noise, sigmas, seed=seed + 1,
                                         paste_back=None, on_step=None)
        mx.eval(latents)
        patches = self.decoder(latents.astype(self.DEC_DTYPE)); mx.eval(patches)
        audio = S.patched_decode(patches, patch_size=256, channels=2); mx.eval(audio)
        audio_np = np.array(audio.astype(mx.float32))[0]
        req = int(round(self.SECONDS * S.SAMPLE_RATE))
        if audio_np.shape[-1] > req:
            audio_np = audio_np[..., :req]
        S.save_wav(out_wav, audio_np)

    # ── public API ──
    def generate(self, prompt, seed, steers=None, out_wav=None):
        self._gen(prompt, seed, steers, out_wav, init_lat=None, init_noise_level=1.0)

    def reimagine(self, prompt, seed, init_lat, init_noise_level, steers=None, out_wav=None):
        self._gen(prompt, seed, steers, out_wav, init_lat=init_lat,
                  init_noise_level=init_noise_level)

    def set_seconds(self, seconds) -> float:
        """Retarget the render length so a clip renders in ONE contiguous pass at its OWN length
        (clamped to [MIN_SECONDS, MAX_CONTIGUOUS]) — the contiguous-first path. The DiT is
        length-agnostic (RoPE positions; weights independent of T_lat), so this is a cheap
        in-place reconfigure: NO weight reload, byte-identical to a fresh engine at that length
        (verified). Only the DiT's T_lat + its default local_add_cond zeros buffer are resized;
        the encoder/decoder read `self.T_LAT` / handle any length. Idempotent. Returns the
        actual (clamped) seconds. Must be called on the message thread like every other engine op."""
        S, mx = self.S, self.mx
        secs = clamp_render_seconds(seconds)
        self.SECONDS = secs
        t_lat = max(1, math.ceil(secs * S.SAMPLE_RATE / S.SAMPLES_PER_LATENT))
        if t_lat != self.T_LAT:
            self.T_LAT = t_lat
            d = self.dit_model
            d.T_lat = t_lat
            z = d._local_zeros_1
            d._local_zeros_1 = mx.zeros((1, t_lat, z.shape[-1]), dtype=z.dtype)
            mx.eval(d._local_zeros_1)
        return secs
