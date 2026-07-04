#!/usr/bin/env python3
"""Phonology CLI — runs the deterministic phonology core (core.py) under the
dedicated phonology venv (~/Library/Mosh/venvs/phonology), invoked by server.py's
/get_rhymes when the service interpreter lacks cmudict. Emits a JSON result
envelope to stdout; any library noise goes to stderr so stdout carries ONLY JSON
(mirrors transcribe_cli.py).

Usage:  phonology_cli.py get_rhymes <word> <strictness> <max_n> [syllables]
        phonology_cli.py pronounce <word> [<word> …]   # → {ok, phones:{word:[…]|null}}
"""
import json
import os
import sys

# Keep stdout clean for the JSON result; route any chatter to stderr.
_OUT = sys.stdout
sys.stdout = sys.stderr

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))  # service/

from phonology import core  # noqa: E402


def main(argv) -> int:
    # pronounce <word> … — phones for words via the venv's layered Pronouncer (real g2p for
    # slang). Used by the vocabulary palette write path so palette entries store real phones.
    if len(argv) >= 3 and argv[1] == "pronounce":
        p = core.Pronouncer()  # cmudict + lazy g2p_en (present in this venv)
        phones = {w: p.phones(w) for w in argv[2:]}
        _OUT.write(json.dumps({"ok": True, "phones": phones}))
        return 0
    if len(argv) < 3 or argv[1] != "get_rhymes":
        _OUT.write(json.dumps({"ok": False,
                               "error": "usage: get_rhymes <word> <strictness> <max_n> [syllables]"}))
        return 1
    word = argv[2]
    strictness = argv[3] if len(argv) > 3 and argv[3] else "slant"
    try:
        max_n = int(argv[4]) if len(argv) > 4 and argv[4] else 50
    except ValueError:
        max_n = 50
    syllables = None
    if len(argv) > 5 and argv[5] not in ("", "-", "none", "0"):
        try:
            syllables = int(argv[5])
        except ValueError:
            syllables = None
    res = core.get_rhymes(word, strictness=strictness, max_n=max_n, syllables=syllables)
    _OUT.write(json.dumps(res))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
