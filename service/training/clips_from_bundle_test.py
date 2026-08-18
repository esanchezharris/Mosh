"""Golden for trainer_job._clips_from_bundle — the bundle reader, against the
manifest the bundle WRITER actually produces.

This test exists because of a bug it would have caught and its predecessor did
not. The reader looked for `audio_path` / `path` / `file`; the real manifest
(TrainerRegistry's `build_training_corpus`) writes `copied_path` and
`local_path`, and has never written any of the three. So it matched nothing,
returned an empty list, and the job died several layers later with "corpus
bundle contains no usable clips" — a message that points at the corpus, not at
the reader.

The Stage-1 unit tests passed the whole time, because their fixture was
hand-written to agree with the READER. That is the trap: a fixture invented
alongside the code under test proves only that the code agrees with itself. The
manifest below is therefore copied from a real bundle, keys and all, and the
comment stays here so nobody "tidies" it into something more convenient.

Also pinned: `copied_path` is ABSOLUTE, so it goes stale whenever the bundle
moves — which is routine, since harness runs copy the bundle out of a session
dir that gets wiped at startup. A bundle that claims to be self-contained has
to be readable after a move.

Run:  python3 service/training/clips_from_bundle_test.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))          # service/

from training.trainer_job import _clips_from_bundle   # noqa: E402

CHECKS = 0


def check(cond, msg):
    global CHECKS
    CHECKS += 1
    if not cond:
        print(f"FAIL: {msg}")
        sys.exit(1)


def real_manifest(session_dir: str) -> dict:
    """Verbatim shape from a real `build_training_corpus` (2026-08-17), trimmed
    to two sources. Do not "simplify" the keys — the point is that they are the
    writer's, not the reader's."""
    return {
        "schema_version": 1,
        "bundle_id": "item",
        "bundle_hash": "deadbeef",
        "created_at": "2026-08-17T09:00:00Z",
        "registry_path": f"{session_dir}/training/rights_registry.json",
        "source_count": 2,
        "skipped_sources": [],
        "sources": [
            {
                "index": 0,
                "source_id": "beat-001",
                "title": "kxc, rage trap instrumental, heavy distorted 808 bass, 152 bpm",
                "creator": "Emilio Sanchez-Harris",
                "source_url": "",
                "local_path": f"{session_dir}/orig/keni_00_00.wav",
                "copied_path": f"{session_dir}/training/corpora/item/sources/000-beat-001-keni_00_00.wav",
                "user_claimed_license": "owner-created",
                "license_name": "owner-created",
                "proof_of_rights": "self-authored",
                "approved_for_training": True,
                "expiration": None,
                "notes": "",
                "sha256": "5ce47626",
                "bytes": 3528078,
            },
            {
                "index": 1,
                "source_id": "beat-002",
                "title": "kxc, rage trap, 152 bpm",
                "creator": "Emilio Sanchez-Harris",
                "source_url": "",
                "local_path": f"{session_dir}/orig/keni_00_01.wav",
                "copied_path": f"{session_dir}/training/corpora/item/sources/001-beat-002-keni_00_01.wav",
                "user_claimed_license": "owner-created",
                "license_name": "owner-created",
                "proof_of_rights": "self-authored",
                "approved_for_training": True,
                "expiration": None,
                "notes": "",
                "sha256": "aa11bb22",
                "bytes": 3528078,
            },
        ],
    }


def touch(p: Path) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"RIFF\x00\x00\x00\x00WAVE")   # content is irrelevant here


def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="clips-bundle-test-"))
    session = tmp / "session"
    bundle = session / "training" / "corpora" / "item"
    manifest = real_manifest(str(session))

    # ── 1) the in-place case: copied_path resolves ──────────────────────────
    for s in manifest["sources"]:
        touch(Path(s["copied_path"]))
    clips = _clips_from_bundle(bundle, manifest)
    check(len(clips) == 2, f"expected 2 clips from a REAL manifest, got {len(clips)} "
                           "(the reader is looking for keys the writer never writes)")
    check([c["id"] for c in clips] == ["beat-001", "beat-002"],
          f"ids should be source_ids: {[c['id'] for c in clips]}")
    check(all(Path(c["wav"]).is_file() for c in clips), "clip wavs do not resolve to real files")
    check(clips[0]["caption"].startswith("kxc,"),
          f"caption should come from the title: {clips[0]['caption']!r}")
    check("sources/000-beat-001" in clips[0]["wav"],
          f"should read the bundle's OWN copy, not the original: {clips[0]['wav']}")

    # ── 2) the MOVED bundle: absolute copied_path is stale ──────────────────
    # Harness runs copy the bundle out of a session dir that is wiped at
    # startup, so this is the normal case, not an exotic one. A bundle that
    # only reads in the place it was built is not self-contained.
    moved = tmp / "elsewhere" / "corpus-bundle"
    moved.parent.mkdir(parents=True, exist_ok=True)
    import shutil
    shutil.copytree(bundle, moved)
    shutil.rmtree(session / "training")          # the original location is gone
    clips = _clips_from_bundle(moved, manifest)
    check(len(clips) == 2, f"a MOVED bundle yielded {len(clips)} clips — stale absolute "
                           "copied_path was not recovered from the bundle itself")
    check(all(str(moved) in c["wav"] for c in clips),
          f"moved bundle resolved outside itself: {[c['wav'] for c in clips]}")

    # ── 3) fallback to local_path when the bundle copy is truly absent ──────
    gone = tmp / "empty-bundle"
    gone.mkdir(parents=True, exist_ok=True)
    for s in manifest["sources"]:
        touch(Path(s["local_path"]))
    clips = _clips_from_bundle(gone, manifest)
    check(len(clips) == 2, f"local_path fallback yielded {len(clips)} clips")
    check(all("/orig/" in c["wav"] for c in clips),
          f"fallback did not use local_path: {[c['wav'] for c in clips]}")

    # ── 4) a source with NO readable audio is skipped, not faked ────────────
    # Returning a path that does not exist would push the failure into
    # precompute, where the message no longer names the source.
    broken = json.loads(json.dumps(manifest))
    broken["sources"][0]["copied_path"] = "/nope/missing.wav"
    broken["sources"][0]["local_path"] = "/nope/missing.wav"
    clips = _clips_from_bundle(gone, broken)
    check(len(clips) == 1, f"unreadable source not skipped (got {len(clips)} clips)")
    check(clips[0]["id"] == "beat-002", f"skipped the wrong one: {clips[0]['id']}")

    # ── 5) an empty manifest is empty, not a crash ─────────────────────────
    check(_clips_from_bundle(gone, {"sources": []}) == [], "empty manifest should yield []")
    check(_clips_from_bundle(gone, {}) == [], "manifest with no sources key should yield []")

    print(f"clips_from_bundle_test OK ({CHECKS} checks)")


if __name__ == "__main__":
    main()
