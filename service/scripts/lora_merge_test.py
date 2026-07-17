"""Golden test for service/sa3/lora_merge.py — DoRA-rows math, key mapping,
cache HIT/MISS + LRU. Hermetic (synthetic tensors, temp dirs), deterministic.

Run:  python3 service/scripts/lora_merge_test.py
"""
from __future__ import annotations

import json
import os
import struct
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from sa3 import lora_merge as LM  # noqa: E402

CHECKS = 0


def check(cond, msg):
    global CHECKS
    CHECKS += 1
    if not cond:
        print(f"FAIL: {msg}")
        sys.exit(1)


def write_safetensors(path, tensors: dict, metadata: dict):
    header, blobs, off = {}, [], 0
    if metadata:
        header["__metadata__"] = {k: str(v) for k, v in metadata.items()}
    for k, arr in tensors.items():
        raw = np.ascontiguousarray(arr, dtype=np.float32).tobytes()
        header[k] = {"dtype": "F32", "shape": list(arr.shape),
                     "data_offsets": [off, off + len(raw)]}
        blobs.append(raw)
        off += len(raw)
    hj = json.dumps(header).encode()
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", len(hj)))
        f.write(hj)
        for b in blobs:
            f.write(b)


def dora_reference(W2, A, B, mag, scaling, strength):
    V = W2.astype(np.float64) + scaling * strength * (B.astype(np.float64) @ A.astype(np.float64))
    V = V / (np.sqrt((V ** 2).sum(axis=1, keepdims=True)) + 1e-12)
    return V * mag.astype(np.float64)[:, None]


def main():
    rng = np.random.default_rng(7)
    tmp = tempfile.mkdtemp(prefix="lora-merge-test-")
    os.environ["MOSH_LORA_DIR"] = tmp   # cache lands in tmp/.merged

    OUT, IN, RANK = 4, 3, 2
    W_lin = rng.normal(size=(OUT, IN)).astype(np.float16)
    W_conv = rng.normal(size=(OUT, 1, IN)).astype(np.float16)
    W_cond = rng.normal(size=(OUT, IN)).astype(np.float16)
    W_untouched = rng.normal(size=(5, 5)).astype(np.float16)
    base = os.path.join(tmp, "base.npz")
    np.savez(base, **{
        "transformer.layers.0.self_attn.to_qkv.weight": W_lin,
        "preprocess_conv.weight": W_conv,
        "cond.seconds_total_weight": W_cond,
        "transformer.layers.0.to_local_embed.seq.0.weight": W_lin.copy(),
        "untouched.weight": W_untouched,
    })

    def mk_parts():
        return (rng.normal(size=(RANK, IN)).astype(np.float32),
                rng.normal(size=(OUT, RANK)).astype(np.float32),
                np.abs(rng.normal(size=(OUT,))).astype(np.float32) + 0.5)

    A1, B1, M1 = mk_parts()
    A2, B2, M2 = mk_parts()
    lora1 = os.path.join(tmp, "l1.safetensors")
    write_safetensors(lora1, {
        "model.transformer.layers.0.self_attn.to_qkv.parametrizations.weight.0.lora_A": A1,
        "model.transformer.layers.0.self_attn.to_qkv.parametrizations.weight.0.lora_B": B1,
        "model.transformer.layers.0.self_attn.to_qkv.parametrizations.weight.0.magnitude": M1,
        "model.preprocess_conv.parametrizations.weight.0.lora_A": A1,
        "model.preprocess_conv.parametrizations.weight.0.lora_B": B1,
        "model.preprocess_conv.parametrizations.weight.0.magnitude": M1,
        "conditioners.seconds_total.embedder.embedding.1.parametrizations.weight.0.lora_A": A1,
        "conditioners.seconds_total.embedder.embedding.1.parametrizations.weight.0.lora_B": B1,
        "conditioners.seconds_total.embedder.embedding.1.parametrizations.weight.0.magnitude": M1,
        "model.transformer.layers.0.to_local_embed.0.parametrizations.weight.0.lora_A": A1,
        "model.transformer.layers.0.to_local_embed.0.parametrizations.weight.0.lora_B": B1,
        "model.transformer.layers.0.to_local_embed.0.parametrizations.weight.0.magnitude": M1,
        "model.bogus_module.parametrizations.weight.0.lora_A": A1,
        "model.bogus_module.parametrizations.weight.0.lora_B": B1,
        "model.bogus_module.parametrizations.weight.0.magnitude": M1,
    }, {"lora_config": json.dumps({"rank": RANK, "alpha": RANK, "adapter_type": "dora-rows"})})
    lora2 = os.path.join(tmp, "l2.safetensors")
    write_safetensors(lora2, {
        "model.transformer.layers.0.self_attn.to_qkv.parametrizations.weight.0.lora_A": A2,
        "model.transformer.layers.0.self_attn.to_qkv.parametrizations.weight.0.lora_B": B2,
        "model.transformer.layers.0.self_attn.to_qkv.parametrizations.weight.0.magnitude": M2,
    }, {"lora_config": json.dumps({"rank": RANK, "alpha": RANK, "adapter_type": "dora-rows"})})

    # 1) single-LoRA merge matches the independent reference (strength 0.6)
    out1 = os.path.join(tmp, "m1.npz")
    rep = LM.merge(base, [("l1", lora1, 0.6)], out1)
    merged = dict(np.load(out1))
    ref_lin = dora_reference(W_lin.astype(np.float32), A1, B1, M1, 1.0, 0.6)
    ref_conv = dora_reference(W_conv[:, 0, :].astype(np.float32), A1, B1, M1, 1.0, 0.6)
    ref_cond = dora_reference(W_cond.astype(np.float32), A1, B1, M1, 1.0, 0.6)
    got = merged["transformer.layers.0.self_attn.to_qkv.weight"].astype(np.float64)
    check(np.allclose(got, ref_lin, atol=2e-3), f"linear merge mismatch (max {np.abs(got-ref_lin).max()})")
    got_c = merged["preprocess_conv.weight"]
    check(got_c.shape == (OUT, 1, IN), "conv shape preserved")
    check(np.allclose(got_c[:, 0, :].astype(np.float64), ref_conv, atol=2e-3), "conv merge mismatch")
    check(np.allclose(merged["cond.seconds_total_weight"].astype(np.float64), ref_cond, atol=2e-3),
          "seconds_total mapping/merge mismatch")
    check(np.allclose(merged["transformer.layers.0.to_local_embed.seq.0.weight"].astype(np.float64),
                      ref_lin, atol=2e-3), "to_local_embed seq rename mismatch")
    check(np.array_equal(merged["untouched.weight"], W_untouched), "untouched key changed")
    check(rep["applied"] == 4 and rep["skipped"] == ["l1:model.bogus_module"],
          f"apply/skip report wrong: {rep}")
    check(merged["transformer.layers.0.self_attn.to_qkv.weight"].dtype == np.float16,
          "dtype not preserved")

    # 2) strength changes the result; stack order matters
    out2 = os.path.join(tmp, "m2.npz")
    LM.merge(base, [("l1", lora1, 0.2)], out2)
    check(not np.array_equal(np.load(out1)["transformer.layers.0.self_attn.to_qkv.weight"],
                             np.load(out2)["transformer.layers.0.self_attn.to_qkv.weight"]),
          "strength had no effect")
    oa, ob = os.path.join(tmp, "ma.npz"), os.path.join(tmp, "mb.npz")
    LM.merge(base, [("l1", lora1, 0.6), ("l2", lora2, 0.6)], oa)
    LM.merge(base, [("l2", lora2, 0.6), ("l1", lora1, 0.6)], ob)
    check(not np.array_equal(np.load(oa)["transformer.layers.0.self_attn.to_qkv.weight"],
                             np.load(ob)["transformer.layers.0.self_attn.to_qkv.weight"]),
          "stack order had no effect (unexpected for DoRA)")

    # 4) determinism: same inputs -> byte-identical output file content
    outd1, outd2 = os.path.join(tmp, "d1.npz"), os.path.join(tmp, "d2.npz")
    LM.merge(base, [("l1", lora1, 0.6)], outd1)
    LM.merge(base, [("l1", lora1, 0.6)], outd2)
    a1 = dict(np.load(outd1)); a2 = dict(np.load(outd2))
    check(all(np.array_equal(a1[k], a2[k]) for k in a1), "merge nondeterministic")

    # 5) apply_dora matches the independent references (dora-rows AND plain lora)
    Wt = W_lin.astype(np.float32)
    got_dora = LM.apply_dora(np, Wt, A1, B1, M1, "dora-rows", 1.0, 0.6)
    check(np.allclose(got_dora, dora_reference(Wt, A1, B1, M1, 1.0, 0.6), atol=1e-5),
          f"apply_dora(dora-rows) != reference (max {np.abs(got_dora - dora_reference(Wt, A1, B1, M1, 1.0, 0.6)).max()})")
    ref_lora = Wt.astype(np.float64) + 1.0 * 0.6 * (B1.astype(np.float64) @ A1.astype(np.float64))
    got_lora = LM.apply_dora(np, Wt, A1, B1, None, "lora", 1.0, 0.6)
    check(np.allclose(got_lora, ref_lora, atol=1e-5), "apply_dora(lora) != reference")

    # 6) weights_for_selection reproduces merge()'s per-key output, bit-for-bit
    #    (this is the runtime-apply equivalence guarantee: runtime == disk-merge).
    base_arrays = {k: np.array(v) for k, v in np.load(base).items()}

    def base_get(key):
        return base_arrays[key] if key in base_arrays else None

    sel = [("l1", lora1, 0.6), ("l2", lora2, 0.6)]
    ref_out = os.path.join(tmp, "wfs_ref.npz")
    ref_rep = LM.merge(base, sel, ref_out)
    ref_merged = dict(np.load(ref_out))
    wfs, wfs_rep = LM.weights_for_selection(sel, base_get)
    check(set(wfs.keys()) <= set(ref_merged.keys()), "weights_for_selection produced unknown keys")
    for k, v in wfs.items():
        check(np.array_equal(v, ref_merged[k]), f"weights_for_selection[{k}] != merge output")
        check(v.dtype == ref_merged[k].dtype, f"weights_for_selection[{k}] dtype != merge")
    # the touched-key set must equal exactly the keys merge changed vs base
    changed = {k for k in ref_merged
               if k in base_arrays and not np.array_equal(ref_merged[k], base_arrays[k])}
    check(set(wfs.keys()) == changed,
          f"touched key set != merge's changed set ({set(wfs.keys()) ^ changed})")
    check(wfs_rep["applied"] == ref_rep["applied"] and wfs_rep["skipped"] == ref_rep["skipped"],
          f"weights_for_selection report != merge report: {wfs_rep} vs {ref_rep}")
    # empty selection -> no weights, empty report
    empty_w, empty_rep = LM.weights_for_selection([], base_get)
    check(empty_w == {} and empty_rep["applied"] == 0, "empty selection not inert")

    print(f"lora_merge_test OK ({CHECKS} checks)")


if __name__ == "__main__":
    main()
