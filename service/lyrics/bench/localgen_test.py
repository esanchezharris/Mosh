#!/usr/bin/env python3
"""Golden tests for the local generation façade + the two local arms (FMS WS1).

Hermetic under system python3 with NO MLX: `localgen.generate` takes the worker as
an argument, so a scripted stand-in drives the arms through their real code paths.
That is the same seam `torchjudge_test` uses for its backend.

The centrepiece is the cache-collision test. `ArmContext.cached_chat` keys on
`{"messages", **kw}` with no model identity, so a local arm that routed through it
with `llm-constrained`'s messages would be served DeepSeek's cached answer and the
local model would never run — silently, with a plausible-looking score. That is
the "cache-replayed fix reported no effect" failure this program has already been
bitten by, reproduced here as a test rather than described in a comment.

Real-model behaviour (BPE reachability, MLX seeding) is NOT provable here. That is
what LYRICS_BENCH_MLX_SMOKE=1 covers, in endword_trie_test.

Run:  python3 service/lyrics/bench/localgen_test.py     (exit 0 = all pass)
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import arms, llm_cache, localgen, runner  # noqa: E402
from lyrics.bench._testlex import make_pron  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


PRON = make_pron()
POOL_WORDS = ["mind", "grind", "blind", "lined", "sign", "mine", "shine", "line"]


def rhyme_item(n=0, partner="mind"):
    return {
        "itemId": f"v2:rhyme:gs:{1000 + n}:s0:l{n}", "granularity": "rhyme",
        "split": "dev", "songId": f"gs:{1000 + n}", "views": 10,
        "target": {"text": "grind", "syllables": 1, "stress": "X",
                   "tokenIndex": 5, "tokenSpan": None},
        "context": {"before": ["they said i would not make it out the cold"],
                    "maskedLine": "i came up from the ____",
                    "after": []},
        "constraints": {"syllables": 1, "syllableTol": 0, "rhymeWith": partner,
                        "rhymeStrictness": "slant"},
    }


def word_item():
    it = rhyme_item(9)
    it["granularity"] = "word"
    it["itemId"] = "v2:word:gs:1009:s0:l9"
    it["constraints"]["rhymeWith"] = None
    return it


class FakeWorker:
    """A localgen.Worker stand-in. Counts calls so 'was the local model actually
    reached?' is answerable, and answers deterministically from the request."""

    def __init__(self, backend=None, fail_with=""):
        self.cfg = localgen.LocalConfig(model="fake/model-4bit", revision="rev0")
        self.backend = backend if backend is not None else {
            "python": "/fake/python", "model": "fake/model-4bit", "revision": "rev0",
            "quant": {"bits": 4, "groupSize": 64}, "tokenizerSha": "tsha",
            "chatTemplateSha": "csha", "eosId": 1, "mlxLmVersion": "0.0.0"}
        self.dead = bool(fail_with)
        self.error = fail_with
        self.calls = []

    def start(self):
        return not self.dead

    def close(self):
        pass

    def request(self, req, timeout=None):
        self.calls.append(req)
        if self.dead:
            return {"ok": False, "error": self.error, "status": "unavailable"}
        if req["op"] == "generate":
            return {"ok": True, "text": f"grind number {len(self.calls)}",
                    "tokens": [1, 2], "logprobMean": -0.5}
        if req["op"] == "generate_endword":
            pool = req.get("pool") or []
            return {"ok": True, "status": "ok", "offMenu": 0, "resampleCount": 0,
                    "poolSize": len(pool), "scored": len(pool),
                    "reachable": len(pool), "unreachable": [], "triePaths": 2 * len(pool),
                    "trieVersion": "v1", "trieTop1": pool[0] if pool else None,
                    "trieRankUnderExact": 0,
                    "candidates": [{"word": w, "tokens": [1], "logprobMean": -i * 1.0}
                                   for i, w in enumerate(pool[:5])]}
        return {"ok": False, "error": f"unexpected op {req['op']}"}


def ctx_with(worker=None, cache_dir=None, chat=None):
    return arms.ArmContext(chat=chat, pron=PRON, freq={"grind": 5, "mind": 9}, k=5,
                           cache=llm_cache.Cache(cache_dir) if cache_dir else None,
                           product_backend="fake", local=worker,
                           local_cfg=(worker.cfg if worker else None),
                           arm_config=(worker.cfg.arm_config() if worker else {}))


# ---- 1. interpreter discovery is honest about absence ----
old = os.environ.get("LYRICS_BENCH_MLX_PY")
os.environ["LYRICS_BENCH_MLX_PY"] = "/definitely/not/a/python"
try:
    os.environ["MOSH_VENVS_DIR"] = tempfile.mkdtemp()
    check("resolve_python: returns None when nothing has mlx_lm",
          localgen.resolve_python() is None)
finally:
    os.environ.pop("MOSH_VENVS_DIR", None)
    if old is None:
        os.environ.pop("LYRICS_BENCH_MLX_PY", None)
    else:
        os.environ["LYRICS_BENCH_MLX_PY"] = old

# ---- 2. unavailable is NOT zero ----
dead = FakeWorker(fail_with="no interpreter with mlx_lm found")
res = arms.ARMS["local-unconstrained"](rhyme_item(), ctx_with(dead))
check("unavailable: no candidates are produced", res["candidates"] == [],
      str(res["candidates"]))
check("unavailable: the reason is named", res["meta"]["status"] == "unavailable"
      and "mlx_lm" in res["meta"]["error"], str(res["meta"]))
res_c = arms.ARMS["local-constrained-endword"](rhyme_item(), ctx_with(dead))
check("unavailable: the constrained arm does not fall back to the rhyme floor",
      res_c["candidates"] == [], str(res_c["candidates"]))

# A dead worker and NO worker are different code paths; both must decline. The
# second was uncovered until a sabotage that replaced it with `arm_rhyme_floor`
# left the suite green — the floor's score would have been published as this
# arm's.
for arm_name in ("local-unconstrained", "local-constrained-endword"):
    none_ctx = arms.ArmContext(pron=PRON, freq={"grind": 5}, k=5,
                               product_backend="fake", local=None)
    r = arms.ARMS[arm_name](rhyme_item(), none_ctx)
    check(f"unavailable: {arm_name} with NO backend declines rather than substituting",
          r["candidates"] == [] and r["meta"]["status"] == "unavailable", str(r["meta"]))

# ---- 3. the constrained arm DECLINES non-rhyme granularities ----
res_w = arms.ARMS["local-constrained-endword"](word_item(), ctx_with(FakeWorker()))
check("decline: a word item is declined, not silently scored",
      res_w["candidates"] == [] and res_w["meta"]["status"] == "declined",
      str(res_w["meta"]))
check("decline: the registry records which granularities the arm answers",
      arms.ARM_GRANULARITIES["local-constrained-endword"] == ("rhyme",))
check("decline: unconstrained arm has no granularity restriction",
      "local-unconstrained" not in arms.ARM_GRANULARITIES)

# ---- 4. the constrained arm only ever answers with pool words ----
w = FakeWorker()
res = arms.ARMS["local-constrained-endword"](rhyme_item(), ctx_with(w))
pool = w.calls[-1]["pool"]
check("pool: the arm sent a non-empty phonology pool", len(pool) >= 2, str(len(pool)))
check("pool: every candidate is a pool word",
      all(c["text"] in pool for c in res["candidates"]),
      str([c["text"] for c in res["candidates"]]))
check("pool: offMenu is reported and zero", res["meta"]["offMenu"] == 0,
      str(res["meta"]["offMenu"]))
check("pool: the trie's own pick and its rank under exact scoring are recorded",
      res["meta"]["trieTop1"] is not None
      and res["meta"]["trieRankUnderExact"] is not None, str(res["meta"]))
# Fixture adequacy: the pool must be able to contain a non-pool answer, i.e. the
# check above is not true merely because the pool is everything.
check("pool fixture: the pool is a strict subset of the lexicon (so 'in pool' bites)",
      len(pool) < len(PRON._lexicon), f"pool={len(pool)} lex={len(PRON._lexicon)}")

# ---- 5. no arm prompt may contain the held-out answer ----
# The POOL may legitimately contain it — the artist's word is one of the partner's
# rhymes, and finding it there is the skill being measured (arms.py:57). What
# would be a leak is the target reaching the text the model reads, so that is what
# is asserted, precisely, rather than a substring search over the whole request.
for arm_name in ("local-unconstrained", "local-constrained-endword"):
    ww = FakeWorker()
    it = rhyme_item()
    arms.ARMS[arm_name](it, ctx_with(ww))
    read_by_model = " ".join(c.get("prompt", "") + " " + c.get("prefill", "")
                             for c in ww.calls)
    check(f"blindness: {arm_name} never puts the target in the model's text",
          it["target"]["text"] not in read_by_model, read_by_model[:120])
# Fixture adequacy: the pool DOES carry the target, so the precise check above is
# distinguishing "in the pool" from "in the prompt" rather than passing vacuously.
_pw = FakeWorker()
arms.ARMS["local-constrained-endword"](rhyme_item(), ctx_with(_pw))
check("blindness fixture: the target is present in the pool (so the check is sharp)",
      "grind" in (_pw.calls[-1].get("pool") or []), str(_pw.calls[-1].get("pool")))

# ---- 5b. the prefix is located with the blank regex, never with tokenize() ----
# `tokenize()`'s word pattern ([A-Za-z']+) silently DROPS underscore tokens, which
# is the documented product-llm review blocker. If the prefix were built from it,
# the model would be handed the whole bar including the words after the gap and
# the blank would vanish — so this asserts the split, not the mechanism.
_pfx, _sfx = arms._prefix_suffix({"context": {"maskedLine": "i came up from the ____"}})
check("prefix: everything before the blank is kept, the blank is not",
      _pfx == "i came up from the " and "_" not in _pfx, repr(_pfx))
_pfx2, _sfx2 = arms._prefix_suffix(
    {"context": {"maskedLine": "i put the ____ on my ____, yeah"}})
check("prefix: a mid-line blank splits at the FIRST blank",
      _pfx2 == "i put the " and _sfx2.endswith("yeah"), repr((_pfx2, _sfx2)))
check("prefix: the suffix is not silently folded into the prefix",
      "on my" not in _pfx2, repr(_pfx2))
# Fixture adequacy. For an END-of-line blank the two agree up to whitespace, so
# that case alone could not tell them apart — the MID-line one can: tokenize()
# drops the underscores and keeps everything after them, handing the model the
# words it was supposed to write.
from lyrics.bench.mask import tokenize as _tok  # noqa: E402
_mid = "i put the ____ on my ____, yeah"
check("prefix fixture: tokenize() would hand over the words AFTER the gap",
      " ".join(_tok(_mid)) != _pfx2.strip() and "yeah" in " ".join(_tok(_mid)),
      str(_tok(_mid)))

# ---- 6. per-item seeding: independent of position, of batch, and of neighbours --
cfg = localgen.LocalConfig(model="m", revision="r", mode="greedy")
items = [rhyme_item(i) for i in range(6)]
seeds = {i["itemId"]: localgen.item_seed(i["itemId"], arms._seed_sha(i), cfg)
         for i in items}
shuffled = list(reversed(items))
seeds2 = {i["itemId"]: localgen.item_seed(i["itemId"], arms._seed_sha(i), cfg)
          for i in shuffled}
subset = {i["itemId"]: localgen.item_seed(i["itemId"], arms._seed_sha(i), cfg)
          for i in items[:3]}
check("seed: identical for an item regardless of batch ORDER", seeds == seeds2)
check("seed: identical for an item regardless of batch SIZE",
      all(subset[k] == seeds[k] for k in subset))
check("seed: distinct across items", len(set(seeds.values())) == len(seeds),
      f"{len(set(seeds.values()))} distinct of {len(seeds)}")
check("seed: moves when the model or mode changes",
      localgen.item_seed("x", "y", localgen.LocalConfig(model="a"))
      != localgen.item_seed("x", "y", localgen.LocalConfig(model="b")))
check("seed: moves when the item CONTENT changes under the same id",
      localgen.item_seed("same-id", "sha-a", cfg)
      != localgen.item_seed("same-id", "sha-b", cfg))

# ---- 7. cache namespace: local keys can never collide with chat keys ----
backend = FakeWorker().backend
local_payload = localgen.payload_for("generate", prompt="p", cfg=cfg, seed=1,
                                     backend=backend)
chat_payload = {"messages": [{"role": "user", "content": "p"}], "max_tokens": 300,
                "temperature": 0.9}
check("cache: the local payload carries a namespace",
      local_payload["cacheNamespace"] == localgen.CACHE_NAMESPACE)
check("cache: the local payload has NO messages key (disjoint by construction)",
      "messages" not in local_payload)
check("cache: the two keys differ",
      llm_cache.cache_key(local_payload) != llm_cache.cache_key(chat_payload))
check("cache: the key moves with model, revision, quant, seed and prompt",
      len({llm_cache.cache_key(localgen.payload_for("generate", prompt=p, cfg=c,
                                                    seed=s, backend=b))
           for p, c, s, b in [
               ("p", cfg, 1, backend),
               ("q", cfg, 1, backend),
               ("p", localgen.LocalConfig(model="other"), 1, backend),
               ("p", cfg, 2, backend),
               ("p", cfg, 1, {**backend, "revision": "rev9"}),
               ("p", cfg, 1, {**backend, "quant": {"bits": 8}})]}) == 6)

# ---- 7b. BEHAVIOURAL: a populated chat cache does not answer for the local arm --
# This is the one that matters. Populate the shared cache via llm-constrained,
# then run the local arm over the SAME item and prove the local backend was
# actually called and its answer used.
class ScriptedChat:
    def __init__(self):
        self.n = 0

    def __call__(self, messages, **kw):
        self.n += 1
        return {"ok": True, "provider": "scripted", "model": "s1",
                "content": json.dumps({"fills": ["gold", "cold"]})}


with tempfile.TemporaryDirectory() as td:
    cache_dir = os.path.join(td, "shared")
    chat = ScriptedChat()
    item = rhyme_item(3)
    hot = ctx_with(None, cache_dir=cache_dir, chat=chat)
    got_chat = arms.ARMS["llm-constrained"](item, hot)
    check("collision fixture: llm-constrained populated the shared cache",
          chat.n > 0 and [c["text"] for c in got_chat["candidates"]] == ["gold", "cold"],
          str(got_chat["candidates"]))

    lw = FakeWorker()
    got_local = arms.ARMS["local-unconstrained"](item, ctx_with(lw, cache_dir=cache_dir))
    check("collision: the local arm actually reached the local backend",
          len(lw.calls) == 1, f"{len(lw.calls)} local calls")
    check("collision: the local arm's answer is its OWN, not the chat cache's",
          [c["text"] for c in got_local["candidates"]] != ["gold", "cold"]
          and got_local["candidates"], str(got_local["candidates"]))

# ---- 8. the local cache does save work on a rerun ----
with tempfile.TemporaryDirectory() as td:
    lw = FakeWorker()
    c1 = ctx_with(lw, cache_dir=os.path.join(td, "c"))
    item = rhyme_item(4)
    a = arms.ARMS["local-unconstrained"](item, c1)
    first = len(lw.calls)
    b = arms.ARMS["local-unconstrained"](item, c1)
    check("cache: a repeat of the same item makes NO new backend call",
          len(lw.calls) == first, f"{len(lw.calls)} vs {first}")
    check("cache: and returns the same candidates",
          [x["text"] for x in a["candidates"]] == [x["text"] for x in b["candidates"]])

# ---- 9. runner: armConfig is in the key ONLY when non-empty ----
# The stakes: `cache_key` hashes the whole payload, so if the runner inserted
# `armConfig` unconditionally every pre-existing key would change and every API
# response already paid for under the program's ceiling would cold-miss. This
# pins the exact payload a config-less arm produces.
class SpyCache(llm_cache.Cache):
    """Records the payloads the RUNNER actually keys on. Reproducing the runner's
    payload construction inside the test instead would test the copy, not the
    code — which is exactly how the first version of this check passed a sabotage
    that made the insertion unconditional."""

    def __init__(self, root):
        super().__init__(root)
        self.payloads = []

    def cached_call(self, payload, fn):
        self.payloads.append(payload)
        return super().cached_call(payload, fn)


with tempfile.TemporaryDirectory() as td:
    spy_no_cfg = SpyCache(os.path.join(td, "a"))
    no_cfg = arms.ArmContext(pron=PRON, freq={}, k=5, product_backend="llm",
                             cache=spy_no_cfg)
    runner.run_arm("oracle", [rhyme_item(7)], no_cfg, out_dir=os.path.join(td, "o1"))

    spy_cfg = SpyCache(os.path.join(td, "b"))
    with_cfg = ctx_with(FakeWorker(), cache_dir=None)
    with_cfg.cache = spy_cfg
    runner.run_arm("oracle", [rhyme_item(7)], with_cfg, out_dir=os.path.join(td, "o2"))

    check("runner: a config-less arm's key carries NO armConfig key at all",
          spy_no_cfg.payloads and "armConfig" not in spy_no_cfg.payloads[0],
          str(sorted(spy_no_cfg.payloads[0])) if spy_no_cfg.payloads else "no payload")
    check("runner: every pre-existing paid key is therefore unchanged",
          llm_cache.cache_key(spy_no_cfg.payloads[0]) == llm_cache.cache_key(
              {k: v for k, v in spy_no_cfg.payloads[0].items() if k != "armConfig"}))
    check("runner: an arm WITH config does carry it (a model swap is detected)",
          spy_cfg.payloads and "armConfig" in spy_cfg.payloads[0]
          and llm_cache.cache_key(spy_cfg.payloads[0])
          != llm_cache.cache_key(spy_no_cfg.payloads[0]),
          str(sorted(spy_cfg.payloads[0])) if spy_cfg.payloads else "no payload")
with tempfile.TemporaryDirectory() as td:
    lw = FakeWorker()
    ctx = ctx_with(lw, cache_dir=os.path.join(td, "c"))
    out = runner.run_arm("local-unconstrained", [rhyme_item(5)], ctx, out_dir=td)
    summ = out["summary"]
    check("runner: the summary records which weights produced the numbers",
          summ["arm"]["config"].get("model") == "fake/model-4bit", str(summ["arm"]["config"]))
    check("runner: a healthy run reports no unusable items",
          summ["unusableItems"] == {}, str(summ["unusableItems"]))
with tempfile.TemporaryDirectory() as td:
    ctx = ctx_with(FakeWorker(fail_with="dead"), cache_dir=os.path.join(td, "c"))
    summ = runner.run_arm("local-unconstrained", [rhyme_item(6)], ctx,
                          out_dir=td)["summary"]
    check("runner: a dead backend surfaces as unusableItems, not a clean zero",
          summ["unusableItems"].get("unavailable") == 1 and summ["emptyCandidates"] == 1,
          str(summ["unusableItems"]))


# ── the fp arm really sends the FREQ pool (2026-07-27 truncation fix) ───────────
# FakeWorker records every request, so "which pool did the model actually see"
# is a recorded fact, not an inference. The freq ctx makes the two orders differ
# ('grind' carries the only nonzero count in its grade), so a sabotage that
# routes the fp arm through the alpha pool cannot produce the expected order.
_wa, _wf = FakeWorker(), FakeWorker()
res_a = arms.ARMS["local-constrained-endword"](rhyme_item(), ctx_with(_wa))
res_f = arms.ARMS["local-constrained-endword-fp"](rhyme_item(), ctx_with(_wf))
_pool_a = _wa.calls[-1].get("pool")
_pool_f = _wf.calls[-1].get("pool")
check("fp arm: worker received a freq-ordered pool, alpha arm an alpha one",
      _pool_a is not None and _pool_f is not None
      and sorted(_pool_a) == sorted(_pool_f) and _pool_a != _pool_f
      and _pool_f[0] == "grind",
      f"alpha={_pool_a[:4] if _pool_a else None} freq={_pool_f[:4] if _pool_f else None}")
check("fp arm: candidates come from the freq pool head (FakeWorker echoes it)",
      [c["text"] for c in res_f["candidates"]][0] == "grind",
      str(res_f["candidates"][:2]))
check("fp arm: offMenu still zero, poolSize reported",
      res_f["meta"].get("offMenu") == 0
      and res_f["meta"].get("poolSize") == len(_pool_f), str(res_f["meta"]))
check("fp arm: declines non-rhyme granularity like its alpha twin",
      arms.ARMS["local-constrained-endword-fp"](word_item(), ctx_with(FakeWorker()))
      ["meta"]["status"] == "declined")
check("fp arm registered rhyme-only in ARM_GRANULARITIES",
      arms.ARM_GRANULARITIES.get("local-constrained-endword-fp") == ("rhyme",))

# ── local-rerank-fp40: the M6 zero-training bracket ─────────────────────────────
# The fixture must be able to show a REORDER, so the scoring worker prefers the
# base arm's LAST candidate — pool-order echo (like FakeWorker) could pass a
# sabotage that never reranks.


class ScoringWorker(FakeWorker):
    """Scores by a fixed preference map instead of pool order."""

    def __init__(self, prefer):
        super().__init__()
        self.prefer = prefer          # word -> score, higher wins

    def request(self, req, timeout=None):
        self.calls.append(req)
        if req["op"] != "generate_endword":
            return super().request(req, timeout)
        pool = req.get("pool") or []
        ranked = sorted(pool, key=lambda w: -self.prefer.get(w, -99))
        return {"ok": True, "status": "ok", "offMenu": 0, "resampleCount": 0,
                "poolSize": len(pool), "scored": len(pool), "reachable": len(pool),
                "unreachable": [], "triePaths": 2 * len(pool), "trieVersion": "v2",
                "trieTop1": ranked[0] if ranked else None, "trieRankUnderExact": 0,
                "candidates": [{"word": w, "tokens": [1],
                                "logprobMean": self.prefer.get(w, -99.0)}
                               for w in ranked]}


def rerank_chat(messages, **kw):
    return {"ok": True, "provider": "fake", "model": "spy",
            "content": json.dumps({"fills": ["mine", "line", "shine"]})}


def rerank_ctx(worker, cache_dir=None):
    c = ctx_with(worker, cache_dir=cache_dir)
    c.chat = rerank_chat
    return c


_rw = ScoringWorker({"shine": 0.0, "line": -1.0, "mine": -2.0})
res_r = arms.ARMS["local-rerank-fp40"](rhyme_item(), rerank_ctx(_rw))
_words = [c["text"] for c in res_r["candidates"]]
check("rerank: the scorer's preference REORDERS the base candidates",
      _words == ["shine", "line", "mine"]
      and res_r["meta"]["movedTop1"] is True
      and res_r["meta"]["baseTop1"] == "mine", str(_words))
check("rerank: worker was handed exactly the base candidates as the pool",
      _rw.calls[-1].get("pool") == ["mine", "line", "shine"],
      str(_rw.calls[-1].get("pool")))


class InventingWorker(ScoringWorker):
    def request(self, req, timeout=None):
        out = super().request(req, timeout)
        if req["op"] == "generate_endword":
            out["candidates"].insert(0, {"word": "zzzinvented", "tokens": [1],
                                         "logprobMean": 9.9})
        return out


res_i = arms.ARMS["local-rerank-fp40"](rhyme_item(),
                                       rerank_ctx(InventingWorker({"shine": 0.0})))
check("rerank: output ⊆ input ENFORCED — an invented word is dropped and counted",
      "zzzinvented" not in [c["text"] for c in res_i["candidates"]]
      and res_i["meta"]["invented"] == 1,
      str((res_i["meta"].get("invented"), [c["text"] for c in res_i["candidates"]])))

res_d = arms.ARMS["local-rerank-fp40"](rhyme_item(),
                                       rerank_ctx(FakeWorker(fail_with="dead")))
check("rerank: dead scorer → unavailable, NEVER the base order laundered through",
      res_d["candidates"] == [] and res_d["meta"]["status"] == "unavailable",
      str(res_d))
# The OTHER laundering route: no worker configured at all. Distinct code path
# from a dead worker (the arm bails before localgen.generate) and it produced a
# vacuous sabotage until this fixture existed.
res_n = arms.ARMS["local-rerank-fp40"](rhyme_item(), rerank_ctx(None))
check("rerank: NO scorer configured → unavailable with empty candidates too",
      res_n["candidates"] == [] and res_n["meta"]["status"] == "unavailable",
      str(res_n))
check("rerank: declines non-rhyme granularity",
      arms.ARMS["local-rerank-fp40"](word_item(), rerank_ctx(FakeWorker()))
      ["meta"]["status"] == "declined")

# The base fp replay is CACHED: a second run in the same cache dir makes zero
# fresh chat calls — the paid responses carry the whole rerank lane for free.
_chatcalls = {"n": 0}


def counting_chat(messages, **kw):
    _chatcalls["n"] += 1
    return rerank_chat(messages, **kw)


with tempfile.TemporaryDirectory() as td:
    c1 = rerank_ctx(ScoringWorker({"shine": 0.0}), cache_dir=td)
    c1.chat = counting_chat
    arms.ARMS["local-rerank-fp40"](rhyme_item(), c1)
    first = _chatcalls["n"]
    c2 = rerank_ctx(ScoringWorker({"shine": 0.0}), cache_dir=td)
    c2.chat = counting_chat
    arms.ARMS["local-rerank-fp40"](rhyme_item(), c2)
    check("rerank: second run replays the fp chat from cache (zero fresh calls)",
          first > 0 and _chatcalls["n"] == first,
          f"first={first} second={_chatcalls['n'] - first}")

# ── adapter identity (I4): joins the cache payload ONLY when configured ─────────
_base_cfg = localgen.LocalConfig(model="fake/model-4bit", revision="rev0")
_base_cfg.adapter = ""
_ad_cfg = localgen.LocalConfig(model="fake/model-4bit", revision="rev0")
_ad_cfg.adapter = "/fake/adapters/fim-v1"
_bk = {"revision": "rev0", "quant": {}, "tokenizerSha": "t", "chatTemplateSha": "c"}
_p_base = localgen.payload_for("generate", prompt="p", cfg=_base_cfg, seed=1,
                               backend=_bk)
_p_ad = localgen.payload_for("generate", prompt="p", cfg=_ad_cfg, seed=1,
                             backend=_bk)
check("adapter ABSENT → payload has no adapter key (existing caches keep "
      "their keys byte-for-byte)", "adapter" not in _p_base, str(sorted(_p_base)))
check("adapter SET → payload carries it (an adapter swap re-keys, never "
      "replays base-model generations)",
      _p_ad.get("adapter") == "/fake/adapters/fim-v1" and _p_base != _p_ad)
_hw = FakeWorker()
_hw.cfg.adapter = "/fake/adapters/fim-v1"
check("FakeWorker path still green with an adapter configured",
      arms.ARMS["local-unconstrained"](rhyme_item(), ctx_with(_hw))
      ["meta"]["status"] == "ok")

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
