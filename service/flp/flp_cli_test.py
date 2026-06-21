#!/usr/bin/env python3
"""Unit test for flp_cli._pat_key — the playlist-vs-pattern dedup identity.

stdlib only, no PyFLP needed (flp_cli imports pyflp lazily inside main()), so this
runs under any python3:  python3 service/flp/flp_cli_test.py   (exit 0 = all pass)

Guards the same-name dedup bug: the playlist walk records which patterns it placed,
and the unplaced remainder is appended sequentially so nothing is lost. Keying that
set by pattern NAME silently treats a *different* same-name pattern as already-placed
and drops it (FL allows duplicate names; unnamed patterns all read back as None).
_pat_key must key by the intrinsic pattern index instead.
"""
import sys

# flp_cli redirects sys.stdout -> sys.stderr at import time (so its real stdout
# carries only JSON). Preserve the real stdout for this test's own output.
_real_stdout = sys.stdout
import flp_cli  # noqa: E402

sys.stdout = _real_stdout


class _Pat:
    """Minimal stand-in for a PyFLP Pattern (name + index attributes)."""

    def __init__(self, name, index):
        self.name = name
        self.index = index


class _NoIndexPat:
    """A pattern whose index getter raises (mirrors PyFLP descriptors raising
    KeyError when the underlying event prop is absent) -> _sg returns None ->
    _pat_key must fall back to object identity."""

    def __init__(self, name):
        self.name = name

    @property
    def index(self):
        raise KeyError("index")


def main() -> int:
    fails = []

    def check(label, cond):
        print(f"  {'ok  ' if cond else 'FAIL'} {label}")
        if not cond:
            fails.append(label)

    key = flp_cli._pat_key

    # The core bug: two DISTINCT patterns that share a name must NOT collide.
    verse_a = _Pat("Verse", 1)
    verse_b = _Pat("Verse", 2)
    check("same name + different index -> distinct keys", key(verse_a) != key(verse_b))
    check("the two share a name (name-keying would have collided them)", verse_a.name == verse_b.name)

    # Same intrinsic pattern reached via two wrapper objects -> same key.
    check("same index -> equal keys regardless of object identity", key(_Pat("A", 5)) == key(_Pat("B", 5)))

    # Unnamed patterns (name None) must still be distinguished by index.
    check("unnamed (None) patterns with distinct indices -> distinct keys",
          key(_Pat(None, 3)) != key(_Pat(None, 4)))

    # No usable index -> fall back to object identity (over-include, never silently
    # drop): distinct objects differ, the same object is stable.
    n1, n2 = _NoIndexPat("x"), _NoIndexPat("x")
    check("no-index fallback: distinct objects -> distinct keys", key(n1) != key(n2))
    check("no-index fallback: same object -> equal key", key(n1) == key(n1))

    print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
