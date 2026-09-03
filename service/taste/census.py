"""Taste-label census over a Mosh session dir (charter Q1/Q3 groundwork).

Reads mosh-log.jsonl + renders/<layerId>/ and classifies every accept_render /
reject_render event (both carry their own layerId join key; see join_renders for the
legacy-archive fallback covering rejects logged before that was true):

- scripted:      the enclosing boot is a known harness replay (the verify/demo scripts
                 run against the real ~/Library/Mosh — the "JUCE ignores $HOME" class).
                 Detection is structural, not path-based: a boot that goes straight
                 create->import->create_render_layer->...->accept->reject with no
                 listening (set_transport) is a replay, not a human.
- contradicted:  the same boot stamps accept AND reject on one clipId with no
                 render_layer between — both labels on the SAME audio, so the pair
                 carries no preference information whichever way it was produced.
- organic:       everything else — the archive the charter's probes may train on.

Pure stdlib; no audio decoding. Everything returns plain dicts so the census can be
golden-tested byte-identical and dumped straight into the results doc.
"""
from __future__ import annotations

import json
import os
from collections import Counter

LABEL_COMMANDS = ("accept_render", "reject_render")

# Commands that indicate a human auditioning/authoring rather than a script replay.
_HUMAN_SIGNS = ("set_transport", "enable_all_meters")


def parse_boots(log_path):
    """Split a mosh-log.jsonl into per-boot command lists. `seq` restarts (<= previous)
    mark an app relaunch — the log itself carries no session-boundary record."""
    boots, cur, last_seq = [], [], None
    with open(log_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            seq = row.get("seq", 0)
            if cur and last_seq is not None and seq <= last_seq:
                boots.append(cur)
                cur = []
            cur.append(row)
            last_seq = seq
    if cur:
        boots.append(cur)
    return boots


def _boot_is_scripted(boot):
    """A harness replay: contains label events but zero human signs. The observed
    archive signature (06-11..06-13) is the exact 7-command sequence ending
    accept_render, reject_render; generalize to "labels without listening"."""
    cmds = [r.get("command") for r in boot]
    if not any(c in LABEL_COMMANDS for c in cmds):
        return False
    return not any(c in _HUMAN_SIGNS for c in cmds)


def _contradicted_clips(boot):
    """clipIds that get BOTH an accept and a reject in this boot with no re-render
    (render_layer on that clip) between the two label events."""
    out = set()
    by_clip = {}
    for r in boot:
        cmd = r.get("command")
        clip = (r.get("args") or {}).get("clipId")
        if clip is None:
            continue
        if cmd == "render_layer":
            by_clip.setdefault(clip, []).append(("render", r.get("ts", 0)))
        elif cmd in LABEL_COMMANDS:
            by_clip.setdefault(clip, []).append((cmd, r.get("ts", 0)))
    for clip, events in by_clip.items():
        seen = set()
        for kind, _ts in events:
            if kind == "render_layer" or kind == "render":
                seen.clear()
            else:
                if seen and kind not in seen:
                    out.add(clip)  # second, different verdict without a re-render
                seen.add(kind)
    return out


def label_rows(boots):
    """Flatten every label event with its classification. A label is scripted when
    its boot has no human signs OR is a detected replay (see replay_flags)."""
    rows = []
    replays = replay_flags(boots)
    for bi, boot in enumerate(boots):
        scripted = _boot_is_scripted(boot) or replays[bi]
        contradicted = _contradicted_clips(boot)
        for r in boot:
            cmd = r.get("command")
            if cmd not in LABEL_COMMANDS:
                continue
            args = r.get("args") or {}
            rows.append({
                "ts": r.get("ts", 0),
                "boot": bi,
                "verdict": "accept" if cmd == "accept_render" else "reject",
                "clipId": args.get("clipId"),
                "layerId": args.get("layerId"),
                "scripted": scripted,
                "contradicted": args.get("clipId") in contradicted,
            })
    return rows


def join_renders(session_dir, labels):
    """Attach each label's on-disk render artifact (wav path + manifest fields).

    Labels carry their own layerId: accept_render always did, and reject_render does
    since the join-key fix (MoshOps::cmdRejectRender now builds an enriched taste label
    -- clipId/layerId/cacheKey/adapter -- instead of logging the caller's raw args).

    The last-layer-for-clip fallback below is LEGACY ONLY: reject rows already written
    to the archive before that fix carry clipId alone, so they are recovered from the
    most recent layerId seen for that clip in the same boot. It is a guess, not a join
    -- a boot that rejects a take it never accepted has no layer to recover -- so it
    applies only when the row itself has no layerId, and an unrecoverable row stays
    honestly unjoined (wav None) rather than being attached to someone else's render.
    Do not extend it: new rows must join on their own key."""
    rows = []
    last_layer_for_clip = {}
    for r in sorted(labels, key=lambda x: (x["ts"], x["verdict"])):
        layer = r["layerId"]
        if layer:
            last_layer_for_clip[(r["boot"], r["clipId"])] = layer
        else:
            layer = last_layer_for_clip.get((r["boot"], r["clipId"]))   # legacy rows only
        out = dict(r)
        out["layerId"] = layer
        out["wav"] = None
        out["adapter"] = None
        out["pq"] = None
        out["axes"] = None
        if layer:
            d = os.path.join(session_dir, "renders", str(layer))
            wav = os.path.join(d, "output.wav")
            man = os.path.join(d, "output_manifest.json")
            if os.path.exists(wav):
                out["wav"] = wav
            if os.path.exists(man):
                try:
                    m = json.load(open(man))
                except ValueError:
                    m = {}
                out["adapter"] = m.get("adapter")
                out["pq"] = m.get("pq")
                out["axes"] = m.get("axes")
        rows.append(out)
    return rows


def replay_flags(boots, min_repeats=3):
    """Per-boot: is this boot a script REPLAY? The archive is full of demo/verify
    scripts run dozens of times against the real ~/Library/Mosh; each replay is the
    identical command sequence with only timing jitter. An exact command-signature
    shared by >= min_repeats boots marks all of them."""
    sigs = [tuple(r.get("command") for r in boot) for boot in boots]
    counts = Counter(sigs)
    return [counts[s] >= min_repeats for s in sigs]


def undo_stats(boots, window_ms=30_000, min_repeats=3):
    """Charter Q3 (implicit labels): count undo events and attribute each to the
    nearest preceding non-undo command within the window — undo-shortly-after-X is
    the candidate implicit-negative signal the Sonnet contrarian bet mines.
    Reported twice: raw, and organic-only (replay boots excluded)."""
    undos = 0
    organic_undos = 0
    after = Counter()
    organic_after = Counter()
    replays = replay_flags(boots, min_repeats=min_repeats)
    for boot, is_replay in zip(boots, replays):
        prev = None  # (command, ts)
        for r in boot:
            cmd = r.get("command")
            ts = r.get("ts", 0)
            if cmd == "undo":
                undos += 1
                if not is_replay:
                    organic_undos += 1
                if prev is not None and ts - prev[1] <= window_ms:
                    after[prev[0]] += 1
                    if not is_replay:
                        organic_after[prev[0]] += 1
            else:
                prev = (cmd, ts)
    return {"undos": undos, "after": dict(sorted(after.items())),
            "organic_undos": organic_undos,
            "organic_after": dict(sorted(organic_after.items()))}


def summarize(session_dir):
    """The census headline: label counts by class + render-artifact survival."""
    log = os.path.join(session_dir, "mosh-log.jsonl")
    boots = parse_boots(log) if os.path.exists(log) else []
    labels = label_rows(boots)
    joined = join_renders(session_dir, labels)
    organic = [r for r in joined if not r["scripted"] and not r["contradicted"]]
    return {
        "boots": len(boots),
        "labels_total": len(labels),
        "scripted_labels": sum(1 for r in labels if r["scripted"]),
        "contradicted_labels": sum(1 for r in labels if r["contradicted"]),
        "organic_accepts": sum(1 for r in organic if r["verdict"] == "accept"),
        "organic_rejects": sum(1 for r in organic if r["verdict"] == "reject"),
        "labels_with_audio": sum(1 for r in joined if r["wav"]),
        "renders_with_axes": len({r["layerId"] for r in joined if r.get("axes")}),
        "undo_census": undo_stats(boots),
    }
