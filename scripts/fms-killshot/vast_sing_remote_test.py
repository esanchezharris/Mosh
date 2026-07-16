#!/usr/bin/env python3
"""Regression test for non-interactive Vast instance destruction."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path


def test_destroy_skips_confirmation_prompt(tmp_path: Path) -> None:
    """Given recorded state, destroy must pass Vast's non-interactive flag."""
    # Given
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    calls = tmp_path / "calls"
    vastai = fake_bin / "vastai"
    vastai.write_text(f"#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{calls}'\n")
    vastai.chmod(0o755)
    (tmp_path / ".mosh-vast-instance").write_text("44799949\n")
    env = {**os.environ, "HOME": str(tmp_path), "PATH": f"{fake_bin}:{os.environ['PATH']}"}

    # When
    result = subprocess.run(
        ["bash", str(Path(__file__).with_name("vast_sing_remote.sh")), "destroy"],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )

    # Then
    assert result.returncode == 0
    assert calls.read_text().strip() == "destroy instance 44799949 -y"
    assert not (tmp_path / ".mosh-vast-instance").exists()


def test_pick_offer_honors_vast_exclude(tmp_path: Path) -> None:
    """A machine that failed SSH-ready must be skippable on retry (by offer OR machine id)."""
    # Given
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    offers = ('[{"id":111,"machine_id":9001,"dph_total":0.25},'
              '{"id":222,"machine_id":9002,"dph_total":0.30}]')
    vastai = fake_bin / "vastai"
    vastai.write_text(f"#!/bin/sh\ncase \"$1\" in search) printf '%s' '{offers}';; esac\n")
    vastai.chmod(0o755)
    base = {**os.environ, "HOME": str(tmp_path), "PATH": f"{fake_bin}:{os.environ['PATH']}"}
    base.pop("VAST_EXCLUDE", None)
    script = str(Path(__file__).with_name("vast_sing_remote.sh"))

    def pick(exclude: str) -> str:
        env = {**base, **({"VAST_EXCLUDE": exclude} if exclude else {})}
        r = subprocess.run(["bash", script, "search"], check=False,
                           capture_output=True, text=True, env=env)
        assert r.returncode == 0, r.stderr
        return r.stdout.strip()

    # Then
    assert "offer 111 at $0.25/hr" in pick("")
    assert "offer 222 at $0.3/hr" in pick("111")     # excluded by OFFER id
    assert "offer 222 at $0.3/hr" in pick("9001")    # excluded by MACHINE id
    assert "offer NONE" in pick("111 9002")          # nothing left -> honest NONE


def test_remote_launch_detaches_stdin() -> None:
    """Given a detached render, the launch SSH command must leave its SSH session."""
    # Given / When
    driver = Path(__file__).with_name("vast_sing_remote.sh").read_text()

    # Then
    assert "setsid -f bash ksa/remote_sing_fresh.sh </dev/null > ksa/run.log 2>&1" in driver
