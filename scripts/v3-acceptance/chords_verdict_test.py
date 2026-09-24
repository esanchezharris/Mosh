#!/usr/bin/env python3
"""Regression test for row_chords' verdict precedence (2026-09-24 followup, item 6).

Bug: row_chords (scripts/v3-acceptance/run.py, added/changed by PR #732) checked whether
`--bin` links libclang_rt.asan and, when it did not, reported the row BLOCKED "smoke only"
INSTEAD OF the row's real check outcome -- even when a real check had genuinely failed (a
crash, a sanitizer report, a bad summary, or a timeout). A failed check has to read FAIL, or
a real regression on a non-ASan build silently reads as an inconclusive smoke test.

This is a plain `unittest` module, run directly (`python3 chords_verdict_test.py`) -- the
same convention as the sibling scripts/verify-hardware/*_test.py files -- and wired into
scripts/auto-loop/gate.sh's run_harness_selftests() so a gate run always executes it.

Two layers:
  - TestChordsVerdict exercises the pure decision function `chords_verdict` directly: no
    binary, no subprocess, no filesystem.
  - TestRowChordsIntegration drives the real `row_chords(ctx)` with `subprocess.run` (both
    the system_profiler device probe and the `--chords-stress` binary run) and
    `_is_asan_build` mocked, so the wiring between the checks and the verdict function is
    covered too, not just the pure function in isolation.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run  # noqa: E402


class TestChordsVerdict(unittest.TestCase):
    """chords_verdict(checks_ok, asan_build, bin_path) -> str | None"""

    def test_non_asan_with_a_failing_check_is_not_blocked(self):
        # This is the exact bug: a real failure on a non-ASan binary must NOT be reported as
        # the "smoke only" BLOCKED message -- that reads as "inconclusive", not "broken".
        self.assertIsNone(run.chords_verdict(checks_ok=False, asan_build=False, bin_path="Mosh"))

    def test_asan_with_a_failing_check_is_not_blocked(self):
        self.assertIsNone(run.chords_verdict(checks_ok=False, asan_build=True, bin_path="Mosh"))

    def test_asan_with_all_checks_passing_is_not_blocked(self):
        # ASan + all green -> PASS: chords_verdict must stay out of the way (None).
        self.assertIsNone(run.chords_verdict(checks_ok=True, asan_build=True, bin_path="Mosh"))

    def test_non_asan_with_all_checks_passing_is_blocked_smoke_only(self):
        msg = run.chords_verdict(checks_ok=True, asan_build=False, bin_path="Mosh")
        self.assertIsNotNone(msg)
        self.assertIn("smoke only", msg)
        self.assertIn("no detection power", msg)
        self.assertIn("Mosh", msg)


class TestRowChordsIntegration(unittest.TestCase):
    """Drives row_chords(ctx) with subprocess.run and _is_asan_build mocked, so the checks ->
    chords_verdict wiring is proven, not just the pure function."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.ctx = run.Ctx()
        self.ctx.bin = Path("/nonexistent/Mosh")
        self.ctx.out = Path(self._tmp.name)
        self.ctx.pid = 999999

    def _run(self, *, stress_rc: int, stress_stdout: str, stress_stderr: str, asan_build: bool):
        def fake_run(cmd, **kwargs):
            if cmd[0] == "system_profiler":
                return mock.Mock(stdout=f"Devices:\n{run.LOOPBACK_DEVICE}: present\n")
            # the --chords-stress invocation of ctx.bin
            self.assertEqual(str(cmd[0]), str(self.ctx.bin))
            return mock.Mock(returncode=stress_rc, stdout=stress_stdout, stderr=stress_stderr)

        with mock.patch.object(run.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(run, "_is_asan_build", return_value=asan_build), \
             mock.patch.object(run, "reset_owned_harness_session", return_value=False):
            return run.row_chords(self.ctx)

    def _ok_summary(self, iterations=20, failures=0):
        return "CHORDS-STRESS: " + json.dumps({"iterations": iterations, "failures": failures})

    def test_non_asan_binary_with_a_failing_check_reads_fail_not_blocked(self):
        # The stress ran (rc=0) but reported a real failure in its own summary -- a genuine
        # regression the row must not let a missing ASan runtime paper over.
        row = self._run(stress_rc=0, stress_stdout=self._ok_summary(failures=1), stress_stderr="",
                        asan_build=False)
        self.assertIsNone(row.blocked, f"a real failure must not be reported BLOCKED (got: {row.blocked!r})")
        self.assertFalse(row.passed)

    def test_non_asan_binary_with_every_check_passing_is_blocked_smoke_only(self):
        row = self._run(stress_rc=0, stress_stdout=self._ok_summary(), stress_stderr="", asan_build=False)
        self.assertIsNotNone(row.blocked)
        self.assertIn("smoke only", row.blocked)
        self.assertFalse(row.passed)  # blocked rows are never "passed"

    def test_asan_binary_with_every_check_passing_is_pass(self):
        row = self._run(stress_rc=0, stress_stdout=self._ok_summary(), stress_stderr="", asan_build=True)
        self.assertIsNone(row.blocked)
        self.assertTrue(row.passed)

    def test_asan_binary_with_a_failing_check_reads_fail(self):
        row = self._run(stress_rc=0, stress_stdout=self._ok_summary(failures=2), stress_stderr="",
                        asan_build=True)
        self.assertIsNone(row.blocked)
        self.assertFalse(row.passed)

    def test_smoke_crashed_on_non_asan_binary_reads_fail_not_blocked(self):
        # The regression this row exists to catch: a crash (non-zero rc, no parseable
        # summary) on a Release (non-ASan) binary. Before the fix this was reported BLOCKED
        # "smoke only" -- indistinguishable from a clean run that merely lacked ASan -- which
        # would hide a real crash behind an "inconclusive" verdict.
        row = self._run(stress_rc=134, stress_stdout="", stress_stderr="", asan_build=False)
        self.assertIsNone(row.blocked, f"a crash must read FAIL, not BLOCKED (got: {row.blocked!r})")
        self.assertFalse(row.passed)


if __name__ == "__main__":
    unittest.main()
