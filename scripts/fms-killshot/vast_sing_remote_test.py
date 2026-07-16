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


def test_remote_launch_detaches_stdin() -> None:
    """Given a detached render, the launch SSH command must leave its SSH session."""
    # Given / When
    driver = Path(__file__).with_name("vast_sing_remote.sh").read_text()

    # Then
    assert "setsid -f bash ksa/remote_sing_fresh.sh </dev/null > ksa/run.log 2>&1" in driver
