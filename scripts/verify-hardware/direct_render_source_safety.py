#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pydantic>=2"]
# ///
# ─── How to run ───
# Imported by verify-direct-reimagine.py; uses only disposable fixture copies.
"""Native regressions for same-size audio changes across async boundaries."""
from __future__ import annotations

import json
import os
import struct
import threading
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal, assert_never

from direct_render_harness import Harness, Result, Snapshot, command, digest, setup, snap, target

PADDING_BYTES: Final = 256 * 1024 * 1024


def padded_source(source: Path) -> Path:
    payload = source.read_bytes()
    destination = source.with_name("source-with-leading-junk.wav")
    with destination.open("wb") as output:
        output.write(b"RIFF" + struct.pack("<I", len(payload) - 8 + PADDING_BYTES + 8) + b"WAVEJUNK")
        output.write(struct.pack("<I", PADDING_BYTES))
        output.seek(PADDING_BYTES, 1)
        output.write(payload[12:])
    return destination


@dataclass(frozen=True, slots=True)
class Mutation:
    at_submit: bool
    material: Literal["source", "result"]
    project: Path | None = None

    def observe(self, directory: Path) -> None:
        source: Path | None = None
        deadline = time.monotonic() + 40
        with (directory / "stdout.log").open() as output:
            while time.monotonic() < deadline:
                position = output.tell()
                line = output.readline()
                if not line.endswith("\n"):
                    output.seek(position)
                    threading.Event().wait(0.002)
                    continue
                if not line.startswith("{"):
                    continue
                result = Result.model_validate_json(line)
                if result.label in ("before", "mutation_window"):
                    source = Path(Snapshot.model_validate(result.data).clip().sourceFile)
                if (self.at_submit and result.command == "render_layer") or result.label == "mutation_window":
                    assert source is not None
                    match self.material:
                        case "source":
                            file = source
                        case "result":
                            if self.project is not None:
                                layer = ET.parse(self.project).find(".//MOSH_RENDERLAYER")
                                assert layer is not None
                                file = self.project.parent / layer.attrib["cacheArtifact"]
                            else:
                                file = next(source.parent.parent.glob("renders/*/*/output.wav"))
                        case unreachable:
                            assert_never(unreachable)
                    stat = file.stat()
                    with file.open("r+b") as audio:
                        assert audio.read(4) == b"RIFF"
                        audio.seek(12)
                        while True:
                            chunk, length = struct.unpack("<4sI", audio.read(8))
                            if chunk == b"data":
                                offset = audio.tell() + min(length - 2, 88200 * 2)
                                break
                            audio.seek(length + length % 2, 1)
                        audio.seek(offset)
                        sample = audio.read(2)
                        audio.seek(offset)
                        audio.write(bytes((sample[0] ^ 0x7F, sample[1] ^ 0x1F)))
                    os.utime(file, ns=(stat.st_atime_ns, stat.st_mtime_ns))
                    assert file.stat().st_size == stat.st_size and file.stat().st_mtime_ns == stat.st_mtime_ns
                    (directory / "mutation.json").write_text(json.dumps({"path": str(file), "offset": offset,
                        "size": stat.st_size, "restored_mtime_ns": stat.st_mtime_ns, "sample_before": sample.hex(),
                        "sha256_after": digest(file)}))
                    return
        raise AssertionError("Native mutation boundary was not observed")


def source_safety(harness: Harness, source: Path) -> None:
    checks: list[tuple[str, bool]] = []
    # Given slow-to-hash four-second audio. When bytes change after submission.
    padded = padded_source(source)
    observer = Mutation(at_submit=True, material="source")
    run = Harness(harness.binary, harness.evidence, observer.observe).run("mutate_after_submit",
        setup(padded) + [target("render_layer"), command("__wait", {"ms": 20000}), snap("after")])
    run.passed()
    # Then the request never accepts the changed source as its original input.
    result = run.snapshot("after").clip()
    assert result.renderLayer is not None
    checks.append((str(run.directory), result.renderLayer.status in ("error", "cancelled") and not result.renderLayer.hasPending))
    assert result.sourceFile == run.snapshot("before").clip().sourceFile
    scenarios: tuple[tuple[Literal["source", "result"], str, bool], ...] = (
        ("source", "bypass_layer", False), ("source", "accept_render", False),
        ("result", "bypass_layer", False), ("result", "accept_render", False), ("result", "accept_render", True))
    for material, decision, reopen in scenarios:
            # Given ready output. When original or output bytes change invisibly to stat.
            project = harness.evidence / "pending-reopen" / "pending.mosh" if reopen else None
            persistence = []
            if project is not None:
                project.parent.mkdir()
                persistence = [command("save_as", {"file": str(project)}), command("new_project", {"name": "Disposable"}),
                               command("open_project", {"file": str(project)})]
            observer = Mutation(at_submit=False, material=material, project=project)
            run = Harness(harness.binary, harness.evidence, observer.observe).run(f"mutate_{material}_{decision}",
                setup(source) + [target("render_layer", {"wait": True})] + persistence + [snap("mutation_window"),
                command("__wait", {"ms": 1000}), target(decision, {"audition": "result"}),
                command("__wait", {"ms": 2000}), snap("after")])
            # Then validation refuses Result and Keep while retaining committed playback.
            clip = run.snapshot("after").clip()
            ready = run.snapshot("mutation_window").clip()
            assert all(row.ok or row.command == decision for row in run.results)
            assert ready.renderLayer is not None and ready.renderLayer.status == "ready"
            assert clip.renderLayer is not None
            checks.append((str(run.directory), clip.sourceFile == ready.sourceFile
                and clip.renderLayer.audition == "committed" and clip.renderLayer.status in ("error", "cancelled")))
    (harness.evidence / "source-safety-checks.json").write_text(json.dumps(checks, indent=2))
    assert all(passed for _, passed in checks), checks
