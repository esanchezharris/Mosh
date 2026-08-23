from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from validate import validate  # noqa: E402


SURFACES = [
    "global-chrome-transport",
    "arrangement-grid-rulers",
    "track-headers-mixer",
    "clips-automation-take-lanes",
    "browser-devices-plugins",
    "midi-editor",
    "audio-device-workflow",
    "core-producer-flows",
]


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


class Live11ParityValidatorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.reference = self.root / ".omo/evidence/live11/reference.png"
        self.reference.parent.mkdir(parents=True)
        self.reference.write_bytes(b"reference")
        digest = hashlib.sha256(self.reference.read_bytes()).hexdigest()
        self.manifest = {
            "schemaVersion": 1,
            "references": [{
                "id": "live11-arrangement",
                "app": {"name": "Ableton Live 11 Standard", "version": "11.3.43"},
                "viewport": {"width": 1351, "height": 768, "scale": 1},
                "state": {"view": "arrangement", "theme": "default", "fixture": "owner-reference"},
                "localPath": ".omo/evidence/live11/reference.png",
                "sha256": digest,
                "capturedAt": "2026-08-23T00:00:00Z",
            }],
            "requiredCaptures": [{
                "surfaceId": surface,
                "status": "captured" if surface == "arrangement-grid-rulers" else "missing",
                **({"referenceIds": ["live11-arrangement"]}
                   if surface == "arrangement-grid-rulers"
                   else {"reason": "Reference capture is still required."}),
            } for surface in SURFACES],
        }
        self.ledger = {
            "schemaVersion": 1,
            "revision": "2026-08-23.1",
            "overallStatus": "not-parity",
            "parityClaimed": False,
            "testedSourceSha": "",
            "referenceManifest": "docs/live-clone/live11-reference-manifest.json",
            "policy": {"maxActiveRepairs": 3},
            "surfaces": [{
                "id": surface,
                "required": True,
                "status": "unproven",
                "gapReason": "No installed-app differential proof yet.",
                "referenceIds": ["live11-arrangement"],
                "testIds": [],
                "artifacts": [],
            } for surface in SURFACES],
            "repairs": [{"id": "grid", "rank": 1, "state": "active"}],
            "documentation": ["docs/live-clone/PARITY.md"],
        }
        (self.root / "docs/live-clone").mkdir(parents=True)
        (self.root / "docs/live-clone/PARITY.md").write_text(
            "Live 11 parity status: NOT PROVEN\n", encoding="utf-8"
        )
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        subprocess.run(["git", "config", "user.name", "Mosh Test"], cwd=self.root, check=True)
        subprocess.run(
            ["git", "config", "user.email", "mosh-test@example.invalid"],
            cwd=self.root,
            check=True,
        )
        subprocess.run(["git", "add", "docs/live-clone/PARITY.md"], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "-qm", "fixture"], cwd=self.root, check=True)
        self.source_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=self.root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.ledger["testedSourceSha"] = self.source_sha
        self.manifest_path = self.root / "docs/live-clone/live11-reference-manifest.json"
        self.ledger_path = self.root / "docs/live-clone/live11-parity.json"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def errors(
        self,
        ledger: dict | None = None,
        manifest: dict | None = None,
        expected_source_sha: str | None = None,
    ) -> list[str]:
        write_json(self.ledger_path, ledger or self.ledger)
        write_json(self.manifest_path, manifest or self.manifest)
        return validate(
            self.root,
            self.ledger_path,
            self.manifest_path,
            expected_source_sha or self.source_sha,
        )

    def test_valid_unproven_ledger_passes(self) -> None:
        self.assertEqual(self.errors(), [])

    def test_nonexistent_source_revision_fails(self) -> None:
        ledger = deepcopy(self.ledger)
        ledger["testedSourceSha"] = "a" * 40
        errors = self.errors(ledger=ledger, expected_source_sha="a" * 40)
        self.assertTrue(any("not an existing commit" in error for error in errors))

    def test_wrong_handoff_source_revision_fails(self) -> None:
        (self.root / "second.txt").write_text("second\n", encoding="utf-8")
        subprocess.run(["git", "add", "second.txt"], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "-qm", "second"], cwd=self.root, check=True)
        wrong_existing_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=self.root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        errors = self.errors(expected_source_sha=wrong_existing_sha)
        self.assertTrue(any("expected handoff revision" in error for error in errors))

    def test_missing_reference_sha_fails(self) -> None:
        manifest = deepcopy(self.manifest)
        del manifest["references"][0]["sha256"]
        self.assertTrue(any("sha256" in error for error in self.errors(manifest=manifest)))

    def test_missing_viewport_fails(self) -> None:
        manifest = deepcopy(self.manifest)
        del manifest["references"][0]["viewport"]
        self.assertTrue(any("viewport" in error for error in self.errors(manifest=manifest)))

    def test_missing_required_surface_capture_row_fails(self) -> None:
        manifest = deepcopy(self.manifest)
        manifest["requiredCaptures"].pop()
        self.assertTrue(any("requiredCaptures" in error for error in self.errors(manifest=manifest)))

    def test_missing_app_version_or_state_fails(self) -> None:
        manifest = deepcopy(self.manifest)
        del manifest["references"][0]["app"]["version"]
        del manifest["references"][0]["state"]
        errors = self.errors(manifest=manifest)
        self.assertTrue(any("app.version" in error for error in errors))
        self.assertTrue(any("state" in error for error in errors))

    def test_missing_or_hash_mismatched_local_reference_fails(self) -> None:
        self.reference.unlink()
        self.assertTrue(any("missing local reference" in error for error in self.errors()))
        self.reference.write_bytes(b"changed")
        self.assertTrue(any("hash mismatch" in error for error in self.errors()))

    def test_verified_surface_requires_test_id_and_fresh_artifact(self) -> None:
        ledger = deepcopy(self.ledger)
        surface = ledger["surfaces"][0]
        surface.update({
            "status": "verified",
            "gapReason": "",
            "verifiedSourceSha": "b" * 40,
            "testIds": [],
            "artifacts": [{"path": "proof.json", "sourceSha": "b" * 40}],
        })
        errors = self.errors(ledger=ledger)
        self.assertTrue(any("testIds" in error for error in errors))
        self.assertTrue(any("stale source SHA" in error for error in errors))

    def test_candidate_artifact_deletion_and_tampering_fail_closed(self) -> None:
        proof = self.root / ".omo/evidence/live11/proof.json"
        proof.write_bytes(b"proof")
        ledger = deepcopy(self.ledger)
        ledger["surfaces"][0].update({
            "status": "candidate",
            "testIds": ["test::candidate"],
            "artifacts": [{
                "path": ".omo/evidence/live11/proof.json",
                "sourceSha": ledger["testedSourceSha"],
                "sha256": hashlib.sha256(proof.read_bytes()).hexdigest(),
            }],
        })
        self.assertEqual(self.errors(ledger=ledger), [])
        proof.unlink()
        self.assertTrue(any("missing evidence artifact" in error for error in self.errors(ledger=ledger)))
        proof.write_bytes(b"tampered")
        self.assertTrue(any("evidence hash mismatch" in error for error in self.errors(ledger=ledger)))

    def test_unsupported_overall_pass_claim_fails(self) -> None:
        ledger = deepcopy(self.ledger)
        ledger["overallStatus"] = "parity"
        ledger["parityClaimed"] = True
        self.assertTrue(any("unsupported parity claim" in error for error in self.errors(ledger=ledger)))

    def test_more_than_three_active_repairs_fails(self) -> None:
        ledger = deepcopy(self.ledger)
        ledger["repairs"] = [
            {"id": f"r{i}", "rank": i, "state": "active"} for i in range(1, 5)
        ]
        self.assertTrue(any("active repairs" in error for error in self.errors(ledger=ledger)))

    def test_contradictory_documentation_fails(self) -> None:
        (self.root / "docs/live-clone/PARITY.md").write_text(
            "Live 11 parity status: COMPLETE\n", encoding="utf-8"
        )
        self.assertTrue(any("documentation" in error for error in self.errors()))


if __name__ == "__main__":
    unittest.main()
