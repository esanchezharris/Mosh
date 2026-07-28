#!/usr/bin/env python3
"""Token-trie constrained decoding (FMS WS1 / M2). Pure stdlib — no MLX, no model.

The tier-1 constraint: the bar's final word must come from a phonology-valid pool.
Prompting for that is a suggestion and post-filtering it throws away work, so we
enforce it *inside* the decoder — expand every allowed word into its token
sequences, build a trie, and mask the logits to trie-valid continuations at each
step. Off-menu output stops being unlikely and starts being unrepresentable.

Two design decisions carry the whole module:

**1. It is a self-contained state machine over `tokens[-1]`.**
mlx-lm hands a logits processor a `tokens` array that is NOT the generated
history: `generate_step` appends only the chunks passed through `_step`, and the
prefill loop calls the model directly, so prompt tokens consumed there never
appear. Anything computing `tokens[prompt_len:]` is wrong for short prompts and
wrong differently for long ones. `TrieState` instead advances one token at a time
and never looks at absolute positions.

**2. The model is injected, not imported.**
`decode` takes `logits_fn` and `sample_fn`. That is what lets the whole constraint
— the part that can actually be wrong — be tested under system python3 with no
MLX and no 8 GB of weights, which is where the gate runs.

Token misalignment is handled by construction rather than by special-casing. A
word whose first sub-token is not a standalone word-start (`guap` → `gu` + `ap`,
where `gu` is also the prefix of `gum`) is simply a path through the trie; the
mask at each step is the set of children of the current node. Variants (leading
space, capitalisation) are separate paths to the same leaf, so a word is
reachable if ANY of its tokenizations is.
"""
from __future__ import annotations

import hashlib
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple

# Bump when variant expansion changes what is REACHABLE — it belongs in the
# generation cache key, or a widened variant set replays narrow results.
# v2: pool_sha became ORDER-SENSITIVE. The v1 sha hashed the sorted SET, so two
# arms whose pools were the same words in different order (alpha vs freq
# truncation, any rime family that fits under the cap) shared cache keys and
# replayed each other's generations — and a freq-table change that only
# REORDERED a pool did not re-key it. Ordering participates in tie-breaks and
# in what the model is shown, so it is part of the computation's identity.
# Found by the 2026-07-28 adversarial review. Bumping this deliberately colds
# every local-arm cache entry; both local arms were re-run to repopulate.
TRIE_VERSION = "v2"

NEG_INF = float("-inf")


def word_variants(word: str) -> List[str]:
    """Surface forms to tokenize for one pool word.

    A BPE vocabulary encodes `" gold"` and `"gold"` as different tokens, and the
    end of a bar is mid-sentence, so the leading-space form is usually the one
    the model actually wants. Capitalisation is included because a bar may start
    or a model may prefer it. Dropping either makes real words unreachable —
    which is what `reachable_words` exists to catch.
    """
    w = (word or "").strip()
    if not w:
        return []
    forms = [w, " " + w]
    cap = w[:1].upper() + w[1:]
    if cap != w:
        forms += [cap, " " + cap]
    seen, out = set(), []
    for f in forms:
        if f not in seen:
            seen.add(f)
            out.append(f)
    return out


class _Node:
    __slots__ = ("children", "word")

    def __init__(self) -> None:
        self.children: Dict[int, "_Node"] = {}
        self.word: Optional[str] = None   # non-None ⇒ a complete pool word ends here


class Trie:
    """Prefix tree over token ids. A node may be BOTH a leaf and an interior node
    (`gu` completing a word while `gum` continues past it) — `allowed` therefore
    unions the children with EOS rather than choosing between them."""

    __slots__ = ("root", "pool", "_paths")

    def __init__(self, pool: Sequence[str]) -> None:
        self.root = _Node()
        self.pool = list(pool)
        self._paths = 0

    def add(self, tokens: Sequence[int], word: str) -> None:
        if not tokens:
            return
        node = self.root
        for t in tokens:
            node = node.children.setdefault(int(t), _Node())
        # First writer wins: two variants of the SAME word land on one leaf, and
        # a genuine collision (two pool words with identical token ids) keeps the
        # earlier one rather than silently rewriting it.
        if node.word is None:
            node.word = word
        self._paths += 1

    @property
    def paths(self) -> int:
        return self._paths


def build_trie(pool: Iterable[str], encode_fn: Callable[[str], Sequence[int]],
               *, variants: Callable[[str], List[str]] = word_variants) -> Trie:
    """Build the trie. `encode_fn` is the tokenizer's text→ids (no special tokens)."""
    words = [w for w in dict.fromkeys((p or "").strip() for p in pool) if w]
    trie = Trie(words)
    for w in words:
        for form in variants(w):
            try:
                ids = encode_fn(form)
            except Exception:  # noqa: BLE001 — an unencodable form is just not a path
                continue
            if ids:
                trie.add(ids, w)
    return trie


def reachable_words(trie: Trie) -> Set[str]:
    """Every word that some path through the trie can actually produce.

    The honest completeness check: if this is not equal to `set(pool)`, some word
    is in the menu but cannot be decoded, and the arm is quietly narrower than it
    claims. Walked rather than accumulated during `add`, so it measures the built
    structure instead of the intent.
    """
    out: Set[str] = set()
    stack = [trie.root]
    while stack:
        node = stack.pop()
        if node.word is not None:
            out.add(node.word)
        stack.extend(node.children.values())
    return out


class TrieState:
    """Position in the trie. One instance per decoded word; advanced by `tokens[-1]`."""

    __slots__ = ("_trie", "_node", "_consumed")

    def __init__(self, trie: Trie) -> None:
        self._trie = trie
        self._node = trie.root
        self._consumed: List[int] = []

    @property
    def consumed(self) -> List[int]:
        return list(self._consumed)

    def is_leaf(self) -> bool:
        return self._node.word is not None

    def word(self) -> Optional[str]:
        return self._node.word

    def advance(self, token_id: int) -> bool:
        """Follow `token_id`. False (and no state change) if it is not valid here."""
        nxt = self._node.children.get(int(token_id))
        if nxt is None:
            return False
        self._node = nxt
        self._consumed.append(int(token_id))
        return True

    def allowed(self, eos_id: Optional[int] = None) -> Set[int]:
        """Token ids legal at this position. EOS only at a leaf — that single rule
        is what stops the decoder from stopping on `cha` when the pool word is
        `chain`."""
        ids = set(self._node.children)
        if eos_id is not None and self.is_leaf():
            ids.add(int(eos_id))
        return ids


def mask_logits(logits: Sequence[float], allowed: Set[int]) -> List[float]:
    """-inf everywhere outside `allowed`. The list form used by `decode` and the
    tests; the MLX worker applies the same `allowed` set to an mx.array itself."""
    return [(v if i in allowed else NEG_INF) for i, v in enumerate(logits)]


class DecodeResult:
    __slots__ = ("word", "tokens", "status", "steps")

    def __init__(self, word: Optional[str], tokens: List[int], status: str, steps: int):
        self.word, self.tokens, self.status, self.steps = word, tokens, status, steps

    def __repr__(self) -> str:  # pragma: no cover — debugging aid
        return f"DecodeResult({self.word!r}, {self.status}, steps={self.steps})"


def decode(trie: Trie, logits_fn: Callable[[List[int]], Sequence[float]],
           sample_fn: Callable[[Sequence[float]], int], *, eos_id: int,
           max_steps: int = 16) -> DecodeResult:
    """Constrained decode of ONE word.

    `logits_fn(tokens_so_far)` returns raw logits; `sample_fn(masked_logits)`
    picks an id (argmax for greedy, a seeded categorical draw for sampled). The
    masking happens between them, so a caller cannot accidentally sample off-menu:
    every id outside the trie is -inf before `sample_fn` ever sees it.

    A leaf with no children has `allowed == {eos}`, so termination is forced
    rather than hoped for — there is no path that runs off the end of a word.
    """
    state = TrieState(trie)
    tokens: List[int] = []
    for step in range(int(max_steps)):
        allowed = state.allowed(eos_id)
        if not allowed:
            return DecodeResult(None, tokens, "dead-end", step)
        picked = int(sample_fn(mask_logits(logits_fn(tokens), allowed)))
        if picked not in allowed:
            # The sampler ignored -inf (a broken mask, or a sampler that reads the
            # unmasked logits). Fail loudly: silently accepting it is exactly how
            # an "off-menu rate is 0" claim becomes false without any test noticing.
            return DecodeResult(None, tokens, "sampler-off-menu", step)
        if picked == eos_id:
            return DecodeResult(state.word(), tokens, "ok", step)
        if not state.advance(picked):
            return DecodeResult(None, tokens, "invalid-advance", step)
        tokens.append(picked)
    return DecodeResult(None, tokens, "max-steps", int(max_steps))


def pool_sha(pool: Iterable[str]) -> str:
    """Stable id for a candidate pool — a phonology or lexicon change moves
    `rhyme_search`'s output, and without this in the cache key the arm would
    replay stale picks against a new menu.

    ORDER-SENSITIVE (v2): the same words in a different order are a different
    pool. Ordering decides stable-sort tie-breaks in the worker's ranking and
    the sequence a model is shown, so two arms with set-equal, order-different
    pools must never share a cache entry. (The v1 set-hash let exactly that
    happen — see TRIE_VERSION.)"""
    words = [(w or "").strip().lower() for w in pool if (w or "").strip()]
    return hashlib.sha256("\n".join(words).encode("utf-8")).hexdigest()
