"""Best-of-n escalation runtime (WP-11) — the impure half around the pure scorer
core: draws n−1 extra candidates from the CLOUD brain (`brain_client.chat_json`),
parses leniently, scores + ranks via core, and archives the chosen/rejected set as
DPO fuel. Spec: docs/superpowers/specs/2026-07-04-bestofn-serving-skeleton.md.

Contract points (panel-driven):
- ESCALATE-ONLY: the caller (UI, via the native relay) already has its single-shot
  reply — it is posted as candidate #0 and re-executed by the caller whenever this
  route degrades or errors, so a failure here never costs an extra cloud call.
- The posted `messages` are the UI-rendered prompt VERBATIM (no Python prompt copy
  to drift). Draws run in parallel threads with a per-draw timeout and an overall
  route budget kept below the UI's wait.
- Sampling diversity: a temperature ladder for providers that accept it; reasoning
  providers ignore sampling params — recorded per candidate, and near-duplicate
  draws dedupe away with the response honestly `degraded` when <2 usable remain.
- Archive is BEST-EFFORT (O_APPEND single write, never route-fatal, surfaced as
  archived:false) to MOSH_DPO_PAIRS_DIR (default ~/Library/Mosh/dpo-pairs — out of
  iCloud). Rows self-identify ties (tieBreak/scoreMargin) so the DPO harvest can
  filter tie-break artifacts. k<2 usable candidates ⇒ nothing to prefer ⇒ no row.
- MOSH_ENABLE_BESTOFN=0 pins the deterministic FAKE backend (the transform/soulx
  convention) so goldens and smokes are hermetic.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from typing import Callable, List, Optional

from bestofn import core

# Temperature ladder for exploratory draws (draw i uses TEMPS[i % len]).
TEMPS = [0.9, 1.1, 0.7, 1.0, 0.8, 1.2, 0.6]
DEFAULT_N = 4
MAX_N = 8
PER_DRAW_TIMEOUT_S = 20
ROUTE_BUDGET_S = 45


def pairs_dir_default() -> str:
    return os.environ.get("MOSH_DPO_PAIRS_DIR") or os.path.expanduser("~/Library/Mosh/dpo-pairs")


def enabled() -> bool:
    return os.environ.get("MOSH_ENABLE_BESTOFN", "1") != "0"


def parse_reply(content: str) -> Optional[dict]:
    """Lenient reply parse (the brainCore.ts posture): strip code fences, extract
    the outermost {...}, require a commands array of {command:str} dicts."""
    if not isinstance(content, str) or not content.strip():
        return None
    text = re.sub(r"```[a-zA-Z]*", "", content).replace("```", "").strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        obj = json.loads(text[start:end + 1])
    except Exception:  # noqa: BLE001 (malformed model output → unusable draw)
        return None
    if not isinstance(obj, dict):
        return None
    cmds = obj.get("commands")
    if not isinstance(cmds, list) or not all(
            isinstance(c, dict) and isinstance(c.get("command"), str) for c in cmds):
        return None
    return {"say": obj.get("say"), "intent": obj.get("intent"), "commands": cmds}


def _fake_draws(first: dict) -> List[dict]:
    """Deterministic placeholder backend (MOSH_ENABLE_BESTOFN=0 or no brain): one
    drop-last variant when the single-shot has ≥2 commands — enough to exercise
    the ranked path hermetically; never invents entities."""
    cmds = first.get("commands") or []
    if len(cmds) < 2:
        return []
    return [{"say": "(fake variant: drop last)", "intent": first.get("intent"),
             "commands": cmds[:-1], "sampling": {"backend": "fake"}}]


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def archive_append(row: dict, pairs_dir: Optional[str] = None, now: Optional[float] = None) -> bool:
    """Append one JSONL row, O_APPEND single write, best-effort. Returns success."""
    d = pairs_dir or pairs_dir_default()
    ts = time.time() if now is None else now
    row = dict(row)
    row.setdefault("ts", ts)
    try:
        os.makedirs(d, exist_ok=True)
        day = time.strftime("%Y%m%d", time.gmtime(ts))
        line = json.dumps(row, separators=(",", ":"), sort_keys=True) + "\n"
        fd = os.open(os.path.join(d, f"pairs-{day}.jsonl"), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        try:
            os.write(fd, line.encode("utf-8"))
        finally:
            os.close(fd)
        return True
    except Exception:  # noqa: BLE001 (archive is best-effort by contract)
        return False


def escalate(payload: dict, chat: Optional[Callable] = None, now: Optional[float] = None,
             pairs_dir: Optional[str] = None) -> dict:
    """Escalate a taste-classified turn: draw, parse, dedupe, score, rank, archive.

    `chat(messages, temperature=None) -> {ok, content, ...}` is injectable for
    hermetic tests; when None the real brain (or the fake backend) is resolved.
    `now` pins timestamps for determinism."""
    t0 = time.monotonic()
    first = payload.get("first") or {}
    messages = payload.get("messages") or []
    catalog = payload.get("catalog") or []
    manifest = payload.get("manifest") or {}
    n = max(2, min(int(payload.get("n") or DEFAULT_N), MAX_N))

    backend = "injected"
    if chat is None:
        from brain_client import available, chat_json
        if enabled() and available():
            backend = "llm"

            def chat(messages, temperature=None):  # noqa: A001 (intentional shadow)
                return chat_json(messages, max_tokens=800, timeout=PER_DRAW_TIMEOUT_S,
                                 temperature=temperature)
        else:
            backend = "fake"

    candidates: List[dict] = [{"say": first.get("say"), "intent": first.get("intent"),
                               "commands": first.get("commands") or [], "sampling": {"origin": "single-shot"}}]
    draws_failed = 0

    if backend == "fake":
        candidates.extend(_fake_draws(first))
    else:
        results: List[Optional[dict]] = [None] * (n - 1)

        def draw(i: int) -> None:
            temp = TEMPS[i % len(TEMPS)]
            try:
                results[i] = {"resp": chat(messages, temperature=temp), "temp": temp}
            except Exception as e:  # noqa: BLE001 (one bad draw must not kill the route)
                results[i] = {"resp": {"ok": False, "error": str(e)}, "temp": temp}

        threads = [threading.Thread(target=draw, args=(i,), daemon=True) for i in range(n - 1)]
        for t in threads:
            t.start()
        deadline = t0 + ROUTE_BUDGET_S
        for t in threads:
            t.join(max(0.1, deadline - time.monotonic()))
        for r in results:
            if r is None or not (r["resp"] or {}).get("ok"):
                draws_failed += 1
                continue
            parsed = parse_reply(r["resp"].get("content") or "")
            if parsed is None:
                draws_failed += 1
                continue
            parsed["sampling"] = {"temperature": r["temp"], "provider": r["resp"].get("provider"),
                                  "model": r["resp"].get("model")}
            candidates.append(parsed)

    unique, dups = core.dedupe_candidates(candidates)
    for c in unique:
        verdict = core.score_candidate(manifest, catalog, c["commands"])
        c["score"], c["reasons"] = verdict["score"], verdict["reasons"]

    ranking = core.rank_candidates(unique)
    ranked = [unique[i] for i in ranking["order"]]
    first_index = next((idx for idx, c in enumerate(ranked)
                        if c["sampling"].get("origin") == "single-shot"), 0)
    # Degraded ⇒ the caller keeps its single-shot reply. The FAKE backend is always
    # degraded: it exists to exercise the pipeline hermetically, and its placeholder
    # variants must never beat real user-facing content on a tie-break (smoke-caught:
    # drop-last outranked the actual reply via fewer-commands) nor enter the archive.
    degraded = backend == "fake" or len(ranked) < 2 or all(c["score"] == 0.0 for c in ranked)
    # `now` is the injected-clock seam: when pinned (tests), latency pins too.
    latency_ms = 0 if now is not None else int((time.monotonic() - t0) * 1000)

    archived = False
    if not degraded:
        archived = archive_append({
            "source": "escalate", "policy": "taste",
            # The RAW utterance is the DPO prompt (program item 4 — the archive is
            # DPO fuel; a hash is inert). Disclosed by the setting help ("your
            # request text"), local-only. The snapshot is hashed (huge; a sha is
            # enough to group rows without bloating the archive).
            "utterance": str(payload.get("utterance") or ""),
            "snapshotSha": _sha(json.dumps(manifest, sort_keys=True)),
            "messagesBytes": len(json.dumps(messages)),
            "backend": backend if backend != "injected" else "llm",
            "candidates": [{"commands": c["commands"], "say": c.get("say"), "score": c["score"],
                            "reasons": c["reasons"], "sampling": c["sampling"]} for c in ranked],
            "chosenIndex": 0, "firstIndex": first_index,
            "scoreMargin": ranking["scoreMargin"], "tieBreak": ranking["tieBreak"],
            "drawsFailed": draws_failed, "dups": dups, "latencyMs": latency_ms,
        }, pairs_dir=pairs_dir, now=now)

    return {"ok": True, "backend": backend if backend != "injected" else "llm",
            "degraded": degraded, "candidates": ranked, "firstIndex": first_index,
            "tieBreak": ranking["tieBreak"], "scoreMargin": ranking["scoreMargin"],
            "drawsFailed": draws_failed, "dups": dups, "archived": archived,
            "latencyMs": latency_ms}
