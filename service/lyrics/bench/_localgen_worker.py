#!/usr/bin/env python3
"""MLX side of the local generation backend (FMS WS1 / M1+M2).

Runs under an interpreter that has mlx-lm; `localgen.py` (stdlib) drives it over
line-delimited JSON on stdin/stdout. Underscore-prefixed for the same reason as
`_torch_worker.py`: not a test, not a public module.

Ops: hello | tokenize | generate | generate_endword | bye.

Three things here are easy to get subtly wrong, and each has a comment where it
is handled rather than a note in a doc:

  * **The `tokens` a logits processor receives is not the generated history.**
    `generate_step` appends only what passes through `_step`, and the prefill
    loop calls the model directly — so prompt chunks consumed there never appear.
    The trie state therefore advances on `tokens[-1]` and never slices by
    position.

  * **The logprobs `generate_step` yields are POST-mask and renormalized**
    (`logprobs = logits - logsumexp(logits)` runs after the processors). Under a
    trie mask with one legal continuation they are ≈0.0, so reading fluency off
    them would report a perfect score for ANY constrained output. Telemetry comes
    from a separate teacher-forced pass with no processors attached.

  * **State leaks between items unless it is rebuilt.** A `prompt_cache` reused
    across items carries KV state; the global RNG advances across draws. Both are
    per-call here: a fresh cache every generation, and an explicit `mx.random.key`
    rather than `mx.random.seed`, so an item's output does not depend on its
    position in the batch.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
if SERVICE not in sys.path:
    sys.path.insert(0, SERVICE)

import mlx.core as mx  # noqa: E402
from mlx_lm import load  # noqa: E402
from mlx_lm.generate import generate_step  # noqa: E402
from mlx_lm.models import cache as _cache  # noqa: E402

from lyrics.bench import endword_trie as et  # noqa: E402

NEG = -1e9

_STATE = {"model": None, "tok": None, "id": "", "revision": ""}


# ── helpers ──────────────────────────────────────────────────────────────────────

def _sha_of(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def _encode(text: str):
    """Text → ids with no special tokens, so the trie's paths are the model's own
    sub-word pieces and not a template artefact."""
    tok = _STATE["tok"]
    inner = getattr(tok, "_tokenizer", tok)
    try:
        return list(inner.encode(text, add_special_tokens=False))
    except TypeError:                      # a tokenizer without the kwarg
        return list(inner.encode(text))


def _eos_id() -> int:
    tok = _STATE["tok"]
    for attr in ("eos_token_id",):
        v = getattr(tok, attr, None)
        if isinstance(v, int):
            return v
    inner = getattr(tok, "_tokenizer", tok)
    return int(getattr(inner, "eos_token_id", 0) or 0)


def _quant_of(model) -> dict:
    """Quantisation as the loaded weights actually report it — not as the repo id
    spells it. `…-4bit` in a name is a claim; this is the artefact."""
    for _, mod in model.named_modules():
        bits = getattr(mod, "bits", None)
        if bits is not None:
            return {"bits": int(bits), "groupSize": int(getattr(mod, "group_size", 0) or 0)}
    return {}


def _sampler_for(mode: str, seed: int, sampler_cfg: dict):
    """Greedy = argmax. Sampled = categorical off an EXPLICIT key.

    `mx.random.seed()` would work for a single item and break the moment items
    share a process: `categorical_sampling` draws from the global RNG, which
    advances, so an item's output would depend on how many items preceded it.
    A split key chain is immune to that (verified against this mlx build).
    """
    if mode != "sampled":
        return lambda lp: mx.argmax(lp, axis=-1)
    temp = float(sampler_cfg.get("temp", 0.8)) or 1.0
    top_p = float(sampler_cfg.get("top_p", 0.0) or 0.0)
    key = mx.random.key(int(seed))

    def sample(logprobs):
        nonlocal key
        key, sub = mx.random.split(key)
        lp = logprobs * (1.0 / temp)
        if 0.0 < top_p < 1.0:
            from mlx_lm.sample_utils import apply_top_p
            lp = apply_top_p(lp, top_p)
        return mx.random.categorical(lp, key=sub)
    return sample


def _fresh_cache():
    return _cache.make_prompt_cache(_STATE["model"])


def _build_prompt(prompt: str, prefill: str = "") -> str:
    """Wrap in the model's chat template, then PRE-FILL the assistant turn with the
    bar so far, so the model continues a lyric rather than answering a question."""
    tok = _STATE["tok"]
    messages = [
        {"role": "system", "content":
         "You are a skilled rap lyricist finishing a bar. Reply with the missing "
         "words only. Slang and explicit language are normal here."},
        {"role": "user", "content": prompt},
    ]
    try:
        text = tok.apply_chat_template(messages, tokenize=False,
                                       add_generation_prompt=True)
    except Exception:  # noqa: BLE001 — a base model without a template
        text = prompt + "\n"
    return text + prefill


def _teacher_forced_logprobs(prompt_ids, token_ids):
    """Mean token logprob of `token_ids` given `prompt_ids`, under the UNCONSTRAINED
    model — the only honest fluency read (see the module docstring).

    One forward pass over prompt+tokens; the logits at position i predict token
    i+1, so the slice starts at len(prompt)-1.
    """
    if not token_ids:
        return None
    model = _STATE["model"]
    seq = mx.array([list(prompt_ids) + list(token_ids)])
    logits = model(seq)
    logprobs = logits - mx.logsumexp(logits, axis=-1, keepdims=True)
    start = len(prompt_ids) - 1
    total = 0.0
    for i, t in enumerate(token_ids):
        total += float(logprobs[0, start + i, int(t)].item())
    return total / len(token_ids)


def _best_form_ids(word: str):
    """The tokenization to score a pool word by. The end of a bar is mid-sentence,
    so the leading-space form is the natural continuation; bare is the fallback."""
    for form in (" " + word, word):
        ids = _encode(form)
        if ids:
            return ids
    return []


def _score_pool(prompt_ids, pool, chunk: int = 8):
    """Teacher-forced logprob of EVERY pool word given the prefix.

    This exists because trie-masked *sampling* turned out to buy nothing at this
    slot: measured on a real bar, the masked first-token distribution put p=0.9998
    on one token, so ten seeded draws returned one word and `topk` collapsed onto
    `exact`. Scoring the pool directly gives a real ranking, is deterministic, and
    is the exact `argmax_w log P(w | prefix)` that masked greedy only approximates.

    Done in two phases, because the naive version does not fit and the obvious fix
    is still 10x too slow. A forward returns logits for EVERY position — (batch,
    tokens, 152k vocab) — so batching 200 prefix+word sequences allocates gigabytes
    AND re-encodes the shared 91-token prefix 200 times (measured: 56s for a
    216-word pool, i.e. ~2h for a 150-item slice). Instead:

      * **Phase 1, one forward over the prefix.** Its last position gives
        log P(first_token | prefix) across the whole vocabulary — the COMPLETE
        score for every single-token word, and in a real rhyme menu that is most
        of them.
      * **Phase 2 reuses phase 1's KV cache.** The prefix is encoded once; its
        cache is tiled across the batch, and only `tokens[:-1]` of each word is
        fed (position i predicts token i+1, and token 0 already came from phase 1).
        For the typical two-token word that is ONE token of compute instead of 92.

    Exact, not approximate: same arithmetic as the padded version, minus the
    redundant prefix passes. Reads are vectorized (`take_along_axis` + one
    `mx.eval`) rather than `.item()` per token, which forces a GPU sync each call.
    """
    model = _STATE["model"]
    forms = [(w, _best_form_ids(w)) for w in pool]
    forms = [(w, ids) for w, ids in forms if ids]
    if not forms:
        return []
    out = []

    # -- phase 1: the prefix, once. Scores every single-token word outright. --
    prefix_cache = _cache.make_prompt_cache(model)
    logits = model(mx.array([list(prompt_ids)]), cache=prefix_cache)[:, -1, :]
    first_lp = (logits - mx.logsumexp(logits, axis=-1, keepdims=True))[0]
    mx.eval(first_lp, [c.state for c in prefix_cache])
    snapshot = [c.state for c in prefix_cache]

    first_of = {}
    idx = mx.array([ids[0] for _, ids in forms], dtype=mx.int32)
    vals = mx.take(first_lp, idx)
    mx.eval(vals)
    for (w, ids), v in zip(forms, vals.tolist()):
        first_of[w] = float(v)

    for w, ids in forms:
        if len(ids) == 1:
            out.append({"word": w, "tokens": ids, "nTokens": 1,
                        "logprobSum": first_of[w], "logprobMean": first_of[w]})

    # -- phase 2: the multi-token remainder, against the shared prefix cache --
    multi = [(w, ids) for w, ids in forms if len(ids) > 1]
    for start in range(0, len(multi), chunk):
        batch = multi[start:start + chunk]
        bsz = len(batch)
        width = max(len(ids) for _, ids in batch) - 1      # tokens[:-1]
        feed = [ids[:-1] + [0] * (width - (len(ids) - 1)) for _, ids in batch]

        tiled = _cache.make_prompt_cache(model)
        for dst, state in zip(tiled, snapshot):
            dst.state = tuple(mx.repeat(a, bsz, axis=0) for a in state)
        region = model(mx.array(feed), cache=tiled)
        lp = region - mx.logsumexp(region, axis=-1, keepdims=True)
        # position i of the fed tokens predicts word token i+1
        tgt = mx.array([ids[1:] + [0] * (width - (len(ids) - 1)) for _, ids in batch],
                       dtype=mx.int32)
        picked = mx.take_along_axis(lp, tgt[:, :, None], axis=-1)[:, :, 0]
        keep = mx.array([[1.0] * (len(ids) - 1) + [0.0] * (width - (len(ids) - 1))
                         for _, ids in batch])
        tails = (picked * keep).sum(axis=1)
        mx.eval(tails)
        for (w, ids), tail in zip(batch, tails.tolist()):
            total = first_of[w] + float(tail)
            out.append({"word": w, "tokens": ids, "nTokens": len(ids),
                        "logprobSum": total, "logprobMean": total / len(ids)})

    # Mean rather than sum: summing is a length penalty in disguise and would rank
    # every one-token word above every two-token one regardless of fit.
    out.sort(key=lambda c: -c["logprobMean"])
    return out


def _walk(trie, token_ids):
    """Resolve generated ids back to a pool word — the authoritative answer, taken
    from the built structure rather than from the processor's running state."""
    node = trie.root
    for t in token_ids:
        node = node.children.get(int(t))
        if node is None:
            return None
    return node.word


def _trie_processor(trie, eos_id):
    state = et.TrieState(trie)
    seen_first = [False]

    def proc(tokens, logits):
        # First call carries the tail of the PROMPT, not a generated token.
        if not seen_first[0]:
            seen_first[0] = True
        else:
            state.advance(int(tokens[-1].item()))
        allowed = state.allowed(eos_id)
        vocab = logits.shape[-1]
        mask = mx.full((vocab,), NEG)
        if allowed:
            mask[mx.array(sorted(allowed), dtype=mx.int32)] = 0.0
        return logits + mask
    return proc, state


# ── ops ──────────────────────────────────────────────────────────────────────────

def op_hello(req):
    model_id = req.get("model") or "mlx-community/Qwen2.5-14B-Instruct-4bit"
    revision = req.get("revision") or None
    adapter = req.get("adapter") or None
    kw = {}
    if revision:
        kw["revision"] = revision
    if adapter:
        # I4: LoRA adapters ride adapter_path on the 4-bit base — never fused
        # (r5: fusing kept ~17% of the delta). A missing dir must fail the
        # handshake loudly, not silently serve the base model as "the adapter".
        if not os.path.isdir(adapter):
            return {"ok": False, "error": f"adapter dir not found: {adapter}"}
        kw["adapter_path"] = adapter
    try:
        model, tok = load(model_id, **kw)
    except TypeError:
        if adapter:
            return {"ok": False,
                    "error": "this mlx_lm cannot load adapter_path — upgrade it"}
        model, tok = load(model_id)
    _STATE.update({"model": model, "tok": tok, "id": model_id,
                   "revision": revision or "", "adapter": adapter or ""})
    inner = getattr(tok, "_tokenizer", tok)
    template = getattr(inner, "chat_template", "") or ""
    try:
        import mlx_lm
        version = getattr(mlx_lm, "__version__", "")
    except Exception:  # noqa: BLE001
        version = ""
    return {"ok": True, "python": sys.executable, "model": model_id,
            "revision": revision or _resolved_revision(model_id),
            "adapter": adapter or "",
            "quant": _quant_of(model),
            "tokenizerSha": _sha_of(json.dumps(
                sorted(inner.get_vocab().items())[:1] if hasattr(inner, "get_vocab") else [])
                + str(getattr(inner, "vocab_size", ""))),
            "chatTemplateSha": _sha_of(template), "eosId": _eos_id(),
            "mlxLmVersion": version}


def _resolved_revision(model_id: str) -> str:
    """The snapshot hash the HF cache actually resolved to. Two snapshots of one
    repo id are different weights, and a number that cannot name its weights is
    not reproducible."""
    try:
        from huggingface_hub import snapshot_download
        path = snapshot_download(model_id, local_files_only=True)
        return os.path.basename(os.path.normpath(path))
    except Exception:  # noqa: BLE001
        return ""


def op_tokenize(req):
    return {"ok": True, "encoded": {f: _encode(f) for f in req.get("forms") or []}}


def op_generate(req):
    """M1: free continuation. No constraint — the control arm."""
    text = _build_prompt(req["prompt"], req.get("prefill", ""))
    ids = _encode(text)
    sampler = _sampler_for(req.get("mode", "greedy"), int(req.get("seed", 0)),
                           req.get("sampler") or {})
    eos = _eos_id()
    out = []
    for token, _lp in generate_step(mx.array(ids), _STATE["model"],
                                    max_tokens=int(req.get("maxTokens", 24)),
                                    sampler=sampler, prompt_cache=_fresh_cache()):
        if int(token) == eos:
            break
        out.append(int(token))
    tok = _STATE["tok"]
    inner = getattr(tok, "_tokenizer", tok)
    return {"ok": True, "text": inner.decode(out), "tokens": out,
            "logprobMean": _teacher_forced_logprobs(ids, out)}


def op_generate_endword(req):
    """M2: the terminal word comes from a phonology-valid pool, so off-menu output
    is unrepresentable rather than merely unlikely.

    TWO mechanisms run, and the difference between them is reported rather than
    assumed:

      * **Pool scoring produces the ANSWER.** Every pool word is teacher-forced
        against the prefix and ranked. That is the exact `argmax_w log P(w|prefix)`,
        it is deterministic, and it yields a real top-5.
      * **The trie decode is the MECHANISM under test.** Masked greedy takes the
        locally-greedy path, which is not the same thing — it is biased toward
        words with common first sub-tokens. `trieRankUnderExact` measures that gap.

    Why not just sample the trie k times: measured on a real bar, the masked
    first-token distribution put p=0.9998 on one token, so ten seeded draws
    returned one word and `topk` degenerated to `exact`. Resampling a degenerate
    distribution is wasted compute pretending to be diversity.
    """
    pool = [w for w in (req.get("pool") or []) if (w or "").strip()]
    if not pool:
        return {"ok": True, "candidates": [], "status": "no-pool", "offMenu": 0,
                "resampleCount": 0}

    trie = et.build_trie(pool, _encode)
    reachable = et.reachable_words(trie)
    text = _build_prompt(req["prompt"], req.get("prefill", ""))
    ids = _encode(text)
    eos = _eos_id()
    k = max(1, int(req.get("k", 5)))

    scored = _score_pool(ids, pool)
    ranking = [c["word"] for c in scored]

    # The mechanism, run once: constrained greedy decode through the trie.
    proc, _state = _trie_processor(trie, eos)
    sampler = _sampler_for("greedy", int(req.get("seed", 0)), {})
    got = []
    for token, _lp in generate_step(mx.array(ids), _STATE["model"],
                                    max_tokens=int(req.get("maxTokens", 12)),
                                    sampler=sampler, logits_processors=[proc],
                                    prompt_cache=_fresh_cache()):
        if int(token) == eos:
            break
        got.append(int(token))
    trie_word = _walk(trie, got)
    # `None` is unreachable by construction — counted, never swallowed, so a
    # broken mask surfaces as a number instead of as silence.
    off_menu = 0 if trie_word is not None else 1

    return {"ok": True, "status": "ok",
            "candidates": [{"word": c["word"], "tokens": c["tokens"],
                            "logprobMean": c["logprobMean"]} for c in scored[:k]],
            "trieTop1": trie_word,
            "trieRankUnderExact": (ranking.index(trie_word) if trie_word in ranking
                                   else None),
            "offMenu": off_menu, "resampleCount": 0,
            "poolSize": len(pool), "scored": len(scored), "reachable": len(reachable),
            "unreachable": sorted(set(pool) - reachable)[:8],
            # The FULL teacher-forced ordering, words only. Response-side
            # diagnostics: candidates carry top-k, which caps every precision
            # analysis at rank 5 — the fp ablation needed truth-rank-in-200 and
            # could not have it without re-paying the run. ~2KB per item.
            # The worker never sees the held-out truth; joining rank against it
            # happens offline in analysis.
            "poolRanking": ranking,
            "triePaths": trie.paths, "trieVersion": et.TRIE_VERSION}


OPS = {"hello": op_hello, "tokenize": op_tokenize, "generate": op_generate,
       "generate_endword": op_generate_endword}


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": f"bad request: {e}"}), flush=True)
            continue
        op = req.get("op", "")
        if op == "bye":
            return 0
        fn = OPS.get(op)
        if fn is None:
            print(json.dumps({"ok": False, "error": f"unknown op {op!r}"}), flush=True)
            continue
        try:
            print(json.dumps(fn(req)), flush=True)
        except Exception as e:  # noqa: BLE001 — a failure must be REPORTED, never
            import traceback         # turned into a plausible-looking empty result
            print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}",
                              "traceback": traceback.format_exc()[-1200:]}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
