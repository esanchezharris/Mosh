#!/usr/bin/env python3
"""§0.5 end-to-end proof — the retrieval/recombination generator → real rendered audio.

Generates several beats (varied seeds/moods), renders each through the real engine, and
asserts: NON-SILENT, no failed commands, the 808 compiled to a MELODIC sampler (not a drum
pad), and that recombination actually pulled elements from MORE THAN ONE source recipe
(provenance) — i.e. real cross-recipe variety, not template-fill.

Needs the (gitignored) palette + the built binary; SKIPs cleanly otherwise.

    MOSH_BIN=build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh \
    MOSH_RECIPE_LIBRARY=.cache/mosh-teardown/midi-ingredients/<run>/library \
    MOSH_PALETTE_MANIFEST=/path/to/service/palette/palette/manifest.json \
        service/teardown/.venv/bin/python scripts/verify-hardware/generate_render_check.py
"""
from __future__ import annotations

import os
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SERVICE = os.path.join(REPO, "service")
if SERVICE not in sys.path:
    sys.path.insert(0, SERVICE)

DEFAULT_BIN = os.path.join(REPO, "build-macos-arm64", "Mosh_artefacts", "Debug",
                           "Mosh.app", "Contents", "MacOS", "Mosh")


def _skip(msg):
    print(f"SKIP: {msg}")
    sys.exit(0)


def main() -> int:
    from recipes import generate as G
    from teardown.render.compile import compile_recipe
    from teardown.render.execute import execute_recipe

    binp = os.environ.get("MOSH_BIN", "").strip() or DEFAULT_BIN
    if not os.path.isfile(binp):
        _skip(f"no Mosh binary at {binp!r}")
    library_dir = os.environ.get("MOSH_RECIPE_LIBRARY", "").strip() or G.LIB_DIR
    palette_manifest = os.environ.get("MOSH_PALETTE_MANIFEST", "").strip()
    palette = G.load_palette(palette_manifest) if palette_manifest else G.load_palette()
    if not palette:
        _skip("no palette manifest (owner-private, gitignored)")

    fails: list[str] = []

    def check(name, cond, extra=""):
        print(("  ok   " if cond else "  FAIL ") + name + ("" if cond or not extra else f"  [{extra}]"))
        if not cond:
            fails.append(name)

    requests = [
        ({"mood": "dark", "tempo": 140, "key": "F minor"}, 3),
        ({"mood": "emotional", "tempo": 146, "key": "C# minor"}, 5),
        ({"mood": "aggressive", "tempo": 150, "key": "D minor"}, 9),
    ]

    multi_source_seen = False
    with tempfile.TemporaryDirectory(prefix="gen-render-") as td:
        for i, (req, seed) in enumerate(requests):
            rec, prov = G.generate(req, library_dir=library_dir, seed=seed, palette=palette)
            prog = compile_recipe(rec).commands
            has_melodic_808 = any(c["command"] == "assign_sample" and c["args"].get("mode") == "melodic"
                                  for c in prog)
            distinct_sources = set(prov.sources.values())
            multi_source_seen = multi_source_seen or len(distinct_sources) > 1

            wav = os.path.join(td, f"gen{i}.wav")
            res = execute_recipe(rec, bin_path=binp, out_wav=wav,
                                 session_dir=os.path.join(td, f"s{i}"), timeout_s=180,
                                 write_back=False, resolve_synth_patches=False)
            tag = f"[{req['mood']} {req['tempo']}bpm {req['key']}]"
            print(f"  .. {tag} sources={prov.sources} transpose={prov.transpose}")
            check(f"{tag} rendered NON-SILENT", res.nonsilent, f"rms={res.audio_rms:.5f} err={res.error}")
            check(f"{tag} no failed commands", res.error is None, res.error or "")
            check(f"{tag} 808 compiled MELODIC (not a drum pad)", has_melodic_808)

        check("recombination drew from MORE THAN ONE source recipe (real variety)",
              multi_source_seen, "all elements came from a single recipe")

    print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
    return len(fails)


if __name__ == "__main__":
    raise SystemExit(main())
