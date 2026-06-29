#!/usr/bin/env python3
"""§11 fine-tune RUNG 2 — LoRA encoder-unfreezing, TRAIN on synthetic / TEST on real.

Rung 1 (`finetune_encoder.py`) learned a projection on FROZEN features and overfit on 20 real
sources. Rung 2 is train_sim's stated "real plan": actually fine-tune the ENCODER — but parameter-
efficiently (LoRA adapters on the attention/linear projections, base frozen) to keep the param count
tiny against a small corpus. Manual LoRA (no `peft` dep) so it works on MuQ's custom nn.Module AND
MERT uniformly.

Honest protocol — the augmentation that fixes the overfit:
  TRAIN = SYNTHETIC grooves (`synth_grooves.py`, large/diverse, library-rendered).
  TEST  = REAL project-file anchors (`project_anchors.py`), held out by construction (disjoint sources).
Both render the SAME way (library samples at onsets) so the only train↔test gap is groove structure.
Compared head-to-head with raw CLAP and the rung-1 frozen projection on the SAME real-test triplets,
with a paired sign test. Encoder forward runs WITH grad (can't precompute features — LoRA changes them);
to bound MPS memory we backward per-triplet and step with gradient accumulation.

    source service/teardown/.teardown.env
    PYTHONPATH=service "$TEARDOWN_PY" service/teardown/flywheel/finetune_lora.py \
        <synth_store> <real_store> [base=muq|mert] [mode=iso_timing|timing|swap] \
        [max_train_trips=400] [epochs=6]
"""
from __future__ import annotations

import copy
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from teardown.flywheel.anchors import AnchorStore  # noqa: E402
from teardown.flywheel.finetune_encoder import _sign_test, train_proj  # noqa: E402
from teardown.flywheel.keystone import ClapEmb, _l2, build_triplets  # noqa: E402
from teardown.flywheel.project_anchors import SR, _Pools  # noqa: E402
from teardown.flywheel.reward_encoder import (MUQ_SR, MERT_SR, _device, _load_mert,  # noqa: E402
                                              _load_muq)
from teardown.flywheel.train_sim import ordering_accuracy  # noqa: E402

LORA_TARGETS = ("q_proj", "k_proj", "v_proj", "out_proj", "to_q", "to_k", "to_v", "to_out",
                "query", "key", "value", "dense", "linear_q", "linear_k", "linear_v")


def _make_lora_linear(base, r: int, alpha: float):
    import torch
    import torch.nn as nn

    class LoRALinear(nn.Module):
        def __init__(self, base_lin, rank, a):
            super().__init__()
            self.base = base_lin
            for p in self.base.parameters():
                p.requires_grad_(False)
            din, dout = base_lin.in_features, base_lin.out_features
            dev, dt = base_lin.weight.device, base_lin.weight.dtype  # match base (e.g. MPS) so mm doesn't cross devices
            self.A = nn.Parameter(torch.zeros(rank, din, device=dev, dtype=dt))
            self.B = nn.Parameter(torch.zeros(dout, rank, device=dev, dtype=dt))
            nn.init.kaiming_uniform_(self.A, a=5 ** 0.5)
            self.scale = a / rank

        def forward(self, x):
            return self.base(x) + (x @ self.A.t() @ self.B.t()) * self.scale

    return LoRALinear(base, r, alpha)


def inject_lora(model, r: int = 8, alpha: float = 16.0) -> list:
    """Replace target nn.Linear modules with LoRA-wrapped ones; freeze the rest. Returns the list of
    trainable LoRA params (A,B). Targets matched by name substring (attention/linear projections)."""
    import torch.nn as nn
    for p in model.parameters():
        p.requires_grad_(False)
    targets = []
    for name, mod in model.named_modules():
        if isinstance(mod, nn.Linear) and any(t in name.lower() for t in LORA_TARGETS):
            targets.append(name)
    for name in targets:
        parent = model
        *path, leaf = name.split(".")
        for p in path:
            parent = getattr(parent, p)
        setattr(parent, leaf, _make_lora_linear(getattr(parent, leaf), r, alpha))
    params = [p for p in model.parameters() if p.requires_grad]
    return params, len(targets)


def _prep_audio(y, target_sr):
    import librosa
    x = np.asarray(y, dtype=np.float32)
    if x.ndim > 1:
        x = x.mean(axis=-1)
    if SR != target_sr:
        x = librosa.resample(x, orig_sr=SR, target_sr=target_sr).astype(np.float32)
    peak = float(np.max(np.abs(x))) or 1.0
    return x / peak


def _embed_grad(model, base: str, x_t):
    """Differentiable mean-over-layers+time embedding (L2-normed) — grad flows to LoRA params."""
    import torch
    import torch.nn.functional as F
    out = model(x_t.unsqueeze(0), output_hidden_states=True)
    stacked = torch.stack(out.hidden_states, dim=0)        # (L,1,T,H)
    v = stacked.mean(dim=2).mean(dim=0).squeeze(0)
    return F.normalize(v, dim=-1)


def _load_base(base: str):
    if base == "muq":
        model, dev = _load_muq()
        return model, dev, MUQ_SR
    model, dev = _load_mert()
    return model, dev, MERT_SR


def _fresh_model(base: str):
    """A FRESH (uncached) base instance for LoRA — bypasses the lru_cache that the frozen
    MuQEncoder/MertEncoder share, so injecting adapters never corrupts the raw-baseline embeds,
    and avoids torch's un-deepcopy-able tensors."""
    dev = _device()
    if base == "muq":
        from muq import MuQ
        from teardown.flywheel.reward_encoder import MUQ_SSL_MODEL
        return MuQ.from_pretrained(MUQ_SSL_MODEL).eval().to(dev), dev, MUQ_SR
    from transformers import AutoModel
    from teardown.flywheel.reward_encoder import MERT_MODEL
    return AutoModel.from_pretrained(MERT_MODEL, trust_remote_code=True).eval().to(dev), dev, MERT_SR


def train_lora(base: str, train_trips, val_rows_audio, test_rows_audio, r=8, alpha=16.0, epochs=6,
               lr=5e-4, margin=0.2, accum=8, seed=0, max_train=400):
    """Fine-tune LoRA adapters on synthetic triplets (audio). Model selection (best epoch) is on a
    SYNTHETIC val split — never on the real test (no test-peeking). Returns (test_at_best_val,
    best_val, train_acc, n_targets)."""
    import torch
    torch.manual_seed(seed)
    model, dev, msr = _fresh_model(base)               # fresh uncached instance (no deepcopy, no cache corruption)
    params, n_targets = inject_lora(model, r, alpha)
    opt = torch.optim.Adam(params, lr=lr)

    rng = np.random.default_rng(seed)
    if len(train_trips) > max_train:
        idx = rng.choice(len(train_trips), size=max_train, replace=False)
        train_trips = [train_trips[i] for i in idx]

    def _to_in(triple_audio):
        return tuple(torch.tensor(_prep_audio(a, msr), device=dev) for a in triple_audio)

    tin = [_to_in((r_, p_, q_)) for (_a, r_, p_, q_) in train_trips]
    val_in = [_to_in(t) for t in val_rows_audio]
    test_in = [_to_in(t) for t in test_rows_audio]

    def _eval(rows):
        model.eval()
        correct = []
        with torch.no_grad():
            for (R, P, Q) in rows:
                pr = _embed_grad(model, base, R)
                dp = float(((pr - _embed_grad(model, base, P)) ** 2).sum())
                dn = float(((pr - _embed_grad(model, base, Q)) ** 2).sum())
                correct.append(float(dp < dn))
        arr = np.array(correct)
        return (float(arr.mean()) if len(arr) else 0.0), arr

    best_val, test_at_best, train_at_best = -1.0, 0.0, 0.0
    test_correct = np.zeros(len(test_in))
    for ep in range(epochs):
        model.train()
        opt.zero_grad()
        order = rng.permutation(len(tin))
        for j, i in enumerate(order):
            R, P, Q = tin[i]
            pr, pp, pq = _embed_grad(model, base, R), _embed_grad(model, base, P), _embed_grad(model, base, Q)
            dp = ((pr - pp) ** 2).sum().clamp_min(1e-12).sqrt()
            dn = ((pr - pq) ** 2).sum().clamp_min(1e-12).sqrt()
            (torch.relu(margin + dp - dn) / accum).backward()
            if (j + 1) % accum == 0:
                opt.step()
                opt.zero_grad()
        opt.step()
        va, _ = _eval(val_in)
        te, te_arr = _eval(test_in)
        tr, _ = _eval(tin[:120])                        # train-acc proxy (overfit gauge)
        if va > best_val:                               # SELECT on val, never on test
            best_val, test_at_best, train_at_best, test_correct = va, te, tr, te_arr
        print(f"    [lora {base}] epoch {ep}: val {va:.4f}  test {te:.4f}  train~{tr:.4f}", flush=True)
    return test_at_best, round(best_val, 4), round(train_at_best, 4), n_targets, test_correct


def _audio_rows(trips):
    return [(r, p, q) for (_a, r, p, q) in trips]


def main(argv=None) -> int:
    argv = argv or sys.argv[1:]
    if len(argv) < 2:
        print("usage: finetune_lora.py <synth_store> <real_store> [base=muq] [mode=iso_timing] "
              "[max_train=400] [epochs=6]", file=sys.stderr)
        return 2
    synth_dir, real_dir = argv[0], argv[1]
    base = argv[2] if len(argv) > 2 else "muq"
    mode = argv[3] if len(argv) > 3 else "iso_timing"
    max_train = int(argv[4]) if len(argv) > 4 else 400
    epochs = int(argv[5]) if len(argv) > 5 else 6

    pools = _Pools()
    synth = AnchorStore(synth_dir).all()              # synthetic = train (all of them)
    real = AnchorStore(real_dir).gold()               # real = test (held out by construction)
    print(f"  TRAIN synthetic anchors: {len(synth)} | TEST real anchors: {len(real)}", flush=True)
    if len(synth) < 10 or len(real) < 4:
        print("  INSUFFICIENT corpus.")
        return 1

    # split SYNTHETIC into fit/val BY SOURCE — val drives model selection so the real test is NEVER
    # peeked at (the leakage trap). Real = test only.
    sids = sorted({a.anchor_id for a in synth})
    np.random.default_rng(0).shuffle(sids)
    vcut = max(1, int(round(0.15 * len(sids))))
    val_ids = set(sids[:vcut])
    fit_anchors = [a for a in synth if a.anchor_id not in val_ids]
    val_anchors = [a for a in synth if a.anchor_id in val_ids]
    max_s = float(os.environ.get("LORA_MAX_SAMPLE_S", "0") or 0)   # CONTROL: short samples → no overlap artifact
    fit_trips = build_triplets(fit_anchors, pools, mode=mode, per_pair=1, max_sample_s=max_s)
    val_trips = build_triplets(val_anchors, pools, mode=mode, per_pair=1, max_sample_s=max_s)
    test_placebo = os.environ.get("LORA_TEST_PLACEBO") == "1"
    test_trips = build_triplets(real, pools, mode=mode, per_pair=2, placebo=test_placebo, max_sample_s=max_s)
    if max_s:
        print(f"  ⚠ CONTROL: samples truncated to {max_s}s (no hit overlap) ⇒ removes the render-overlap "
              f"amplitude artifact; if LoRA still beats CLAP it's genuine onset-position perception", flush=True)
    if test_placebo:
        print("  ⚠ PLACEBO test: near/far symmetric (no true ordering) ⇒ genuine timing ≈0.5", flush=True)
    print(f"  mode={mode!r}: fit {len(fit_trips)} | val {len(val_trips)} | test {len(test_trips)} triplets",
          flush=True)

    def _emb_rows(enc, trips):
        cache = {}
        def e(y):
            k = id(y)
            if k not in cache:
                cache[k] = _l2(enc.embed(y, SR))
            return cache[k]
        return [(aid, (e(r), e(p), e(q))) for (aid, r, p, q) in trips]

    def _raw_correct(rows):
        return np.array([float(np.linalg.norm(r - p) < np.linalg.norm(r - q))
                         for _a, (r, p, q) in rows])

    from teardown.flywheel.finetune_encoder import _ordering_acc_proj
    from teardown.flywheel.reward_encoder import MertEncoder, MuQEncoder
    base_enc = {"muq": MuQEncoder, "mert": MertEncoder}[base]()
    print("  embedding raw CLAP + raw base (frozen) for baselines/projection…", flush=True)
    clap_test = _emb_rows(ClapEmb(), test_trips)
    fit_rows = _emb_rows(base_enc, fit_trips)
    val_rows = _emb_rows(base_enc, val_trips)
    test_rows = _emb_rows(base_enc, test_trips)
    clap_raw = ordering_accuracy([e for _, e in clap_test])
    base_raw = ordering_accuracy([e for _, e in test_rows])
    d_in = fit_rows[0][1][0].shape[0]

    # rung-1: projection trained on synth-FIT, model-selected on synth-VAL, eval real-TEST
    # (train_proj/_ordering_acc_proj expect the (aid,(r,p,q)) row form — pass the rows directly)
    proj, proj_val, proj_train = train_proj(fit_rows, val_rows, d_in, seed=0)
    proj_test = _ordering_acc_proj(proj, test_rows)

    # per-triplet correctness arrays (aligned with test_trips order) for an HONEST significance test
    clap_ok = _raw_correct(clap_test)

    def _proj_correct(model, rows):
        import torch
        with torch.no_grad():
            R = torch.tensor(np.stack([r for _, (r, _, _) in rows]), dtype=torch.float32, device=_device())
            P = torch.tensor(np.stack([p for _, (_, p, _) in rows]), dtype=torch.float32, device=_device())
            Q = torch.tensor(np.stack([q for _, (_, _, q) in rows]), dtype=torch.float32, device=_device())
            pr, pp, pq = model(R), model(P), model(Q)
            return (((pr - pp) ** 2).sum(-1) < ((pr - pq) ** 2).sum(-1)).cpu().numpy().astype(float)

    proj_ok = _proj_correct(proj, test_rows)

    # rung-2: LoRA trained on synth-FIT audio, model-selected on synth-VAL, eval real-TEST
    print(f"  training LoRA on {base} (synthetic→real)…", flush=True)
    lora_test, lora_val, lora_train, n_tgt, lora_ok = train_lora(
        base, fit_trips, _audio_rows(val_trips), _audio_rows(test_trips), epochs=epochs, max_train=max_train)

    # SOURCE-CLUSTERED bootstrap (resample the ~21 real test SOURCES, not triplets — triplets are
    # correlated within a source, so a triplet bootstrap is anti-conservative). The honest CI.
    aids = [t[0] for t in test_trips]
    uniq = sorted(set(aids))
    by_src = {s: np.array([i for i, a in enumerate(aids) if a == s]) for s in uniq}

    def clustered_ci(learned_ok):
        rb = np.random.default_rng(0)
        ds = []
        for _ in range(3000):
            chosen = rb.integers(0, len(uniq), len(uniq))
            idx = np.concatenate([by_src[uniq[c]] for c in chosen])
            ds.append(float(learned_ok[idx].mean() - clap_ok[idx].mean()))
        return round(float(np.percentile(ds, 2.5)), 4), round(float(np.percentile(ds, 97.5)), 4)

    proj_lo, proj_hi = clustered_ci(proj_ok)
    lora_lo, lora_hi = clustered_ci(lora_ok)

    print(f"\n  ── §11 FINE-TUNE RUNG 1+2 [{base}, {mode}] synthetic-TRAIN / real-TEST ({len(uniq)} test sources) ──")
    print(f"    raw CLAP                       {clap_raw:.4f}")
    print(f"    raw {base:24}  {base_raw:.4f}")
    print(f"    {base} φ-proj (rung 1)   test {proj_test:.4f}  (val {proj_val:.4f} / train {proj_train:.4f})")
    print(f"    {base} LoRA  ({n_tgt} adapters)  test {lora_test:.4f}  (val {lora_val:.4f} / train~{lora_train:.4f})")
    print(f"\n  φ-proj − raw CLAP: Δ={proj_test - clap_raw:+.4f}  SOURCE-clustered 95% CI [{proj_lo:+.4f}, {proj_hi:+.4f}]")
    print(f"  LoRA   − raw CLAP: Δ={lora_test - clap_raw:+.4f}  SOURCE-clustered 95% CI [{lora_lo:+.4f}, {lora_hi:+.4f}]")
    best = max(("φ-proj", proj_test, proj_lo), ("LoRA", lora_test, lora_lo), key=lambda kv: kv[1])
    robust = " (CI excludes 0 ⇒ ROBUST)" if best[2] > 0 else " (CI includes 0 ⇒ NOT robust)"
    print(f"  VERDICT: best learned = {best[0]} {best[1]:.4f} vs raw CLAP {clap_raw:.4f} → "
          f"{'BEATS CLAP' if best[1] > clap_raw else 'does NOT beat CLAP'}{robust} "
          f"(report-only; do NOT auto-activate the pull)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
