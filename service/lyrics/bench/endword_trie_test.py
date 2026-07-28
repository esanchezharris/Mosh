#!/usr/bin/env python3
"""Golden tests for the end-word token trie (FMS WS1 / M2).

No MLX, no model, no tokenizer download — the trie takes an injected `encode_fn`
and `decode` takes injected `logits_fn`/`sample_fn`, so the part that can actually
be wrong is testable where the gate runs.

The fake vocabulary is built to EXHIBIT the failures being guarded, not merely to
be consistent with them:

  * `guap` has no single token — it is `gu` + `ap`, and `gu` is also the prefix of
    `gum`. So the trie must branch mid-word, and a "does the first sub-token look
    like a word?" heuristic would drop it.
  * `bag` is unencodable bare and exists only as ` bag`. Drop the leading-space
    variant and it becomes unreachable.
  * `ice` is unencodable lowercase and exists only as `Ice`. Drop the casing
    variant and it becomes unreachable.
  * `chain` is one token with a leading space but two without.

Without those three, `reachable_words(trie) == set(pool)` would pass against a
trie builder that ignored variants entirely — a guard whose fixture carries
nothing to guard. `_test_fixture_is_adequate` asserts that property directly.

A fake vocab proves the trie LOGIC. It proves nothing about Qwen's real BPE —
that is what LYRICS_BENCH_MLX_SMOKE=1 covers at the bottom of this file.

Run:  python3 service/lyrics/bench/endword_trie_test.py     (exit 0 = all pass)
"""
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import endword_trie as et  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# ── a fake byte-pair-ish vocabulary ──────────────────────────────────────────────
VOCAB = ["zzz", "gu", "ap", "m", " chain", "ch", "ain", "pain", "Pain",
         " gold", "gold", " gu", " ch", " p", "old", "g", " bag", "Ice", "<eos>"]
IDS = {t: i for i, t in enumerate(VOCAB)}
EOS = IDS["<eos>"]
OFF_MENU_TOKEN = IDS["zzz"]        # the adversary's favourite: never trie-valid


def fake_encode(text):
    """Greedy longest-match. Returns [] when the text cannot be tiled — which is
    how ` Pain`, `Gold` and bare `bag` end up with no path, exactly like a real
    tokenizer's coverage gaps."""
    out, i = [], 0
    while i < len(text):
        for ln in range(min(8, len(text) - i), 0, -1):
            piece = text[i:i + ln]
            if piece in IDS:
                out.append(IDS[piece])
                i += ln
                break
        else:
            return []
    return out


POOL = ["guap", "gum", "chain", "pain", "gold", "bag", "ice"]
TRIE = et.build_trie(POOL, fake_encode)


# ── 1. the fixture can actually exhibit what we guard ────────────────────────────
def _reach(variants):
    return et.reachable_words(et.build_trie(POOL, fake_encode, variants=variants))


check("fixture: `guap` tokenizes to >1 token whose first is not a standalone word",
      len(fake_encode("guap")) == 2 and fake_encode("guap")[0] == IDS["gu"]
      and "gu" not in POOL, str(fake_encode("guap")))
check("fixture: `gu` really branches (guap and gum share it)",
      fake_encode("gum")[0] == fake_encode("guap")[0])
check("fixture: `bag` is reachable ONLY via the leading-space form",
      fake_encode("bag") == [] and fake_encode(" bag") != [])
check("fixture: `ice` is reachable ONLY via the capitalised form",
      fake_encode("ice") == [] and fake_encode("Ice") != [])
# The adequacy proof: a builder that ignored variants would MISS words. If this
# ever passes, the reachability test below has stopped guarding anything.
bare_only = _reach(lambda w: [w])
check("fixture adequacy: a variant-blind builder loses words (so the guard bites)",
      bare_only != set(POOL) and {"bag", "ice"} <= (set(POOL) - bare_only),
      f"variant-blind reached {sorted(bare_only)}")

# ── 2. reachability: every pool word has a path ──────────────────────────────────
check("trie: every pool word is reachable", et.reachable_words(TRIE) == set(POOL),
      f"missing={sorted(set(POOL) - et.reachable_words(TRIE))}")
check("trie: no word is invented", et.reachable_words(TRIE) <= set(POOL))
check("trie: variants collapse onto ONE leaf per word (paths > words)",
      TRIE.paths > len(POOL), f"paths={TRIE.paths} words={len(POOL)}")


# ── 3. each word is decodable when the logits favour its path ────────────────────
def biased_logits_for(word):
    """logits_fn that always prefers the next token on `word`'s first path."""
    target = None
    for form in et.word_variants(word):
        ids = fake_encode(form)
        if ids:
            target = ids
            break

    def logits_fn(tokens_so_far):
        v = [0.0] * len(VOCAB)
        v[OFF_MENU_TOKEN] = 100.0                 # the adversary, always loudest
        step = len(tokens_so_far)
        if step < len(target):
            v[target[step]] = 50.0
        else:
            v[EOS] = 50.0
        return v
    return logits_fn


def argmax(v):
    return max(range(len(v)), key=lambda i: v[i])


decoded = {}
for w in POOL:
    r = et.decode(TRIE, biased_logits_for(w), argmax, eos_id=EOS)
    decoded[w] = (r.word, r.status)
check("decode: every pool word decodes to itself under a path-biased sampler",
      all(decoded[w][0] == w and decoded[w][1] == "ok" for w in POOL),
      str({k: v for k, v in decoded.items() if v[0] != k}))

# ── 4. off-menu rate is 0 under an adversarial sampler ───────────────────────────
rng = random.Random(20260727)


def adversarial_logits(_tokens):
    """Random noise with the off-menu token pinned above everything."""
    v = [rng.random() for _ in VOCAB]
    v[OFF_MENU_TOKEN] = 99.0
    return v


results = [et.decode(TRIE, adversarial_logits, argmax, eos_id=EOS) for _ in range(50)]
off_menu = [r for r in results if r.word is not None and r.word not in POOL]
unfinished = [r for r in results if r.status != "ok"]
check("off-menu: 0 of 50 adversarial decodes produced a word outside the pool",
      not off_menu, str([r.word for r in off_menu[:5]]))
check("off-menu: every adversarial decode still COMPLETED a real word",
      not unfinished, str([(r.word, r.status) for r in unfinished[:5]]))
check("off-menu: the 50 decodes were not all the same word (the mask isn't pinning one)",
      len({r.word for r in results}) >= 2, str({r.word for r in results}))


# Fixture adequacy for the off-menu guard: with masking removed, the SAME
# adversary wins immediately. This is what stops the check above from being a
# guard whose fixture cannot fail.
def decode_unmasked(trie, logits_fn, sample_fn, *, eos_id, max_steps=16):
    state = et.TrieState(trie)
    tokens = []
    for step in range(max_steps):
        picked = int(sample_fn(logits_fn(tokens)))      # ← no mask_logits
        if picked == eos_id:
            return et.DecodeResult(state.word(), tokens, "ok", step)
        if not state.advance(picked):
            return et.DecodeResult(None, tokens, "invalid-advance", step)
        tokens.append(picked)
    return et.DecodeResult(None, tokens, "max-steps", max_steps)


unmasked = [decode_unmasked(TRIE, adversarial_logits, argmax, eos_id=EOS)
            for _ in range(50)]
check("fixture adequacy: WITHOUT the mask the same adversary breaks every decode",
      all(r.status != "ok" for r in unmasked),
      f"{sum(1 for r in unmasked if r.status == 'ok')} of 50 still ok")

# ── 5. EOS is legal only at a leaf ───────────────────────────────────────────────
st = et.TrieState(TRIE)
st.advance(IDS["ch"])                       # inside `chain`, not a word yet
check("eos: not offered mid-word", EOS not in st.allowed(EOS), str(sorted(st.allowed(EOS))))
check("eos: mid-word state is not a leaf", not st.is_leaf())
st.advance(IDS["ain"])
check("eos: offered once the word is complete", EOS in st.allowed(EOS))
check("eos: the completed word is the pool word", st.word() == "chain", str(st.word()))

# A greedy sampler that WANTS to stop early must not be able to.
early = et.decode(TRIE, lambda t: [0.0] * (len(VOCAB) - 1) + [99.0], argmax, eos_id=EOS)
check("eos: a stop-now sampler cannot terminate on a non-word",
      early.word in (None,) or early.word in POOL, str((early.word, early.status)))

# ── 6. a leaf that is also an interior node offers BOTH ──────────────────────────
sub = et.build_trie(["gu", "guap"], fake_encode)
st2 = et.TrieState(sub)
st2.advance(IDS["gu"])
allowed = st2.allowed(EOS)
check("branching: a node that both completes a word and continues offers EOS + children",
      st2.is_leaf() and EOS in allowed and IDS["ap"] in allowed, str(sorted(allowed)))
check("branching: both words remain reachable", et.reachable_words(sub) == {"gu", "guap"})

# ── 7. advance() rejects invalid tokens without corrupting state ─────────────────
st3 = et.TrieState(TRIE)
before = st3.consumed
check("advance: an invalid token is refused", not st3.advance(OFF_MENU_TOKEN))
check("advance: a refused token does not move the state", st3.consumed == before)

# ── 8. empty / degenerate pools ──────────────────────────────────────────────────
empty = et.build_trie([], fake_encode)
check("empty pool: no reachable words", et.reachable_words(empty) == set())
check("empty pool: nothing is allowed, so decode reports dead-end",
      et.decode(empty, adversarial_logits, argmax, eos_id=EOS).status == "dead-end")
blank = et.build_trie(["", "   ", None], fake_encode)
check("blank pool entries are dropped, not turned into paths",
      et.reachable_words(blank) == set() and blank.paths == 0)

# ── 9. pool_sha is ORDER-SENSITIVE (v2) and moves with content ───────────────────
# v1 hashed the sorted set, which let two arms with set-equal, order-different
# pools (alpha vs freq truncation of a small rime family) share cache entries
# and replay each other's generations. Ordering is part of the computation's
# identity: it breaks stable-sort ties in the worker and is the sequence a
# model is shown.
check("pool_sha: DIFFERENT when the same words are reordered",
      et.pool_sha(["gold", "chain"]) != et.pool_sha(["chain", "gold"]))
check("pool_sha: case-insensitive at fixed order",
      et.pool_sha(["Gold", "chain"]) == et.pool_sha(["gold", "chain"]))
check("pool_sha: changes when the pool changes",
      et.pool_sha(["gold", "chain"]) != et.pool_sha(["gold", "chain", "pain"]))
check("pool_sha: stable across calls",
      et.pool_sha(["gold", "chain"]) == et.pool_sha(["gold", "chain"]))

# ── 10. opt-in: the REAL tokenizer (not in the gate) ─────────────────────────────
if os.environ.get("LYRICS_BENCH_MLX_SMOKE") == "1":
    from lyrics.bench import localgen  # noqa: E402
    py = localgen.resolve_python()
    if not py:
        check("smoke: an interpreter with mlx_lm was found", False,
              "set LYRICS_BENCH_MLX_PY or run setup-lyrics-bench.sh --mlx")
    else:
        out = localgen.tokenize_pool(POOL + ["money", "problems", "everything"], python=py)
        if not out.get("ok"):
            check("smoke: the real tokenizer answered", False, str(out.get("error"))[:200])
        else:
            real = et.build_trie(out["pool"], lambda s: out["encoded"][s],
                                 variants=lambda w: [f for f in et.word_variants(w)
                                                     if f in out["encoded"]])
            missing = set(out["pool"]) - et.reachable_words(real)
            check("smoke: every word is reachable under the REAL Qwen tokenizer",
                  not missing, str(sorted(missing)[:8]))
else:
    print("[SKIP ] smoke: real-tokenizer reachability "
          "(set LYRICS_BENCH_MLX_SMOKE=1 — a fake vocab proves the logic, not the BPE)")

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
