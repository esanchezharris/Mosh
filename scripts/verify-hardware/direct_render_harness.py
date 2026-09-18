#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["pydantic>=2"]
# ///
# ─── How to run ───
# Imported by verify-direct-reimagine.py; use its documented invocation.
"""Typed command, snapshot and process helpers for direct-render verification."""
from __future__ import annotations

import hashlib
import json
import math
import os
import socket
import struct
import subprocess
import uuid
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, TypedDict

from pydantic import BaseModel, ConfigDict, Field, JsonValue


class Command(TypedDict):
    command: str
    args: dict[str, JsonValue]
    capture: dict[str, str]


class Result(BaseModel):
    model_config = ConfigDict(frozen=True)
    command: str
    ok: bool
    label: str = ""
    data: JsonValue = None
    error: JsonValue = None


class Layer(BaseModel):
    model_config = ConfigDict(frozen=True, extra="allow", strict=True)
    id: str
    status: str
    decisionPolicy: str
    hasPending: bool = False
    audition: str = "committed"
    jobId: str = ""
    requestId: str = ""
    testFixture: bool = False
    userKept: bool = False
    seed: int = 0
    nl: float = 0.4
    sourceStart: float = 0
    sourceDuration: float = 0


class Clip(BaseModel):
    model_config = ConfigDict(frozen=True, extra="allow")
    id: str
    name: str
    sourceFile: str
    offset: float
    renderLayer: Layer | None = None


class Track(BaseModel):
    model_config = ConfigDict(frozen=True, extra="allow")
    id: str
    name: str
    clips: list[Clip] = Field(default_factory=list)


class Snapshot(BaseModel):
    model_config = ConfigDict(frozen=True)
    tracks: list[Track]

    def clip(self, name: str = "Target") -> Clip:
        return next(clip for track in self.tracks for clip in track.clips if clip.name == name)


@dataclass(frozen=True, slots=True)
class Run:
    directory: Path
    results: list[Result]
    exit_code: int

    def snapshot(self, label: str) -> Snapshot:
        return Snapshot.model_validate(next(result.data for result in self.results if result.label == label))

    def passed(self) -> None:
        assert self.exit_code == 0, self.directory
        assert all(result.ok for result in self.results), [result for result in self.results if not result.ok]


def command(name: str, args: dict[str, JsonValue] | None = None, capture: dict[str, str] | None = None) -> Command:
    return {"command": name, "args": args or {}, "capture": capture or {}}


def snap(label: str) -> Command:
    return command("__snapshot", {"label": label})


def target(name: str, args: dict[str, JsonValue] | None = None) -> Command:
    return command(name, {"clipId": "${C}", **(args or {})})


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tone(path: Path) -> None:
    """Create exactly four seconds of deterministic stereo PCM at 44.1 kHz."""
    with wave.open(str(path), "wb") as output:
        output.setparams((2, 2, 44100, 0, "NONE", "not compressed"))
        samples = (struct.pack("<hh", int(7000 * math.sin(2 * math.pi * 220 * frame / 44100)),
                               int(6000 * math.sin(2 * math.pi * 330 * frame / 44100))) for frame in range(176400))
        output.writeframes(b"".join(samples))


def setup(source: Path) -> list[Command]:
    return [command("create_track", {"name": "Target Track"}, {"T": "trackId"}),
            command("import_clip", {"file": str(source), "trackId": "${T}", "name": "Target"}, {"C": "clipId"}),
            target("trim_clip", {"start": 0, "length": 2, "offset": 1}),
            command("create_track", {"name": "Unrelated Track"}, {"U": "trackId"}),
            command("import_clip", {"file": str(source), "trackId": "${U}", "name": "Unrelated", "startSeconds": 5}),
            command("set_track_volume", {"trackId": "${U}", "value": 0.6}),
            target("create_render_layer", {"decisionPolicy": "explicit", "adapter": "stable_audio3"}),
            target("set_render_param", {"prompt": "A sustained synthesizer tone.", "nl": 0.4, "seed": 0}), snap("before")]


@dataclass(frozen=True, slots=True)
class Harness:
    binary: Path
    evidence: Path
    observer: Callable[[Path], None] | None = None
    settle_decisions: bool = True

    def run(self, name: str, commands: list[Command], mode: str = "normal") -> Run:
        """Own a fresh session/port; retain stdout, stderr, result and PID evidence."""
        directory = self.evidence / (name + "-" + uuid.uuid4().hex[:10])
        directory.mkdir(parents=True)
        binary_hash = digest(self.binary)
        script, output = directory / "commands.jsonl", directory / "results.jsonl"
        commands = [step for item in commands for step in ([item, command("__wait", {"ms": 2000})]
                    if self.settle_decisions and item["command"] in ("accept_render", "bypass_layer") else [item])]
        script.write_text("\n".join(json.dumps(item) for item in commands) + "\n")
        with socket.socket() as port_socket:
            port_socket.bind(("127.0.0.1", 0))
            port = str(port_socket.getsockname()[1])
        env = dict(os.environ, MOSH_NO_AUDIO="1", MOSH_ENABLE_SA3="0", MOSH_SA3_QA="0",
                   MOSH_DIRECT_RENDER_TEST_FIXTURE="1", MOSH_SELFTEST_SESSION="_harness/" + directory.name,
                   MOSH_RUN_SCRIPT=str(script), MOSH_RUN_SCRIPT_OUT=str(output), MOSH_SERVICE_PORT=port,
                   MOSH_SERVICE_SCRIPT=str(Path(__file__).with_name("direct_render_fixture_service.py")),
                   MOSH_SERVICE_IDLE_EXIT_SECONDS="2", MOSH_TEST_DIRECT_MODE=mode,
                   MOSH_TEST_DIRECT_MARKER=str(directory / "service-started.pid"),
                   MOSH_SERVICE_LOG=str(directory / "service.log"))
        if mode == "unavailable":
            env["MOSH_DIRECT_RENDER_TEST_FIXTURE"] = "0"
        with (directory / "stdout.log").open("w") as stdout, (directory / "stderr.log").open("w") as stderr:
            with subprocess.Popen([str(self.binary), "--run-script"], env=env, stdout=stdout, stderr=stderr) as process:
                (directory / "app.pid").write_text(str(process.pid))
                if self.observer is not None:
                    self.observer(directory)
                code = process.wait(timeout=180)
        (directory / "process-result.json").write_text(json.dumps({"pid": process.pid, "exit_code": code, "port": port,
                                                                  "binary": str(self.binary), "binary_sha256": binary_hash}))
        exited = subprocess.run(["ps", "-p", str(process.pid), "-o", "pid=,command="], capture_output=True, text=True)
        (directory / "app-exit.txt").write_text(f"ps exit={exited.returncode}\n{exited.stdout}")
        assert exited.returncode == 1
        assert digest(self.binary) == binary_hash, "Binary changed during verification"
        results = [Result.model_validate_json(line) for line in output.read_text().splitlines()] if output.exists() else []
        return Run(directory, results, code)
