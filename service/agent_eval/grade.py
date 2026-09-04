from __future__ import annotations

import os
import subprocess
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Annotated, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .attempt import ArtifactFile, AttemptRecord
from .git_ops import CloneSpec, apply_binary_patch, prepare_candidate
from .models import sha256_file

BASE_ENVIRONMENT: Final = ("PATH", "LANG", "LC_ALL", "TERM")


class FailureClass(StrEnum):
    BUILD_FAILURE = "build_failure"
    TEST_FAILURE = "test_failure"
    STATIC_INTEGRITY = "static_integrity"
    NO_PATCH = "no_patch"
    REPO_ESCAPE = "repo_escape"
    BUDGET_EXCEEDED = "budget_exceeded"


class CheckResult(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    id: Annotated[str, Field(min_length=1)]
    passed: bool
    score: Annotated[float, Field(ge=0.0, le=1.0)]
    failure_class: FailureClass | None
    detail: str


class GradePayload(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    schema_version: Literal[1]
    grader_version: Annotated[str, Field(min_length=1)]
    score: Annotated[float, Field(ge=0.0, le=1.0)]
    passed: bool
    checks: tuple[CheckResult, ...] = Field(min_length=1)


class GradeOutcome(StrEnum):
    COMPLETED = "completed"
    INFRA_ERROR = "infra_error"
    TIMEOUT = "timeout"


class GraderIdentity(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    version: str
    bundle_sha256: str
    command: tuple[str, ...]
    elapsed_seconds: float


class GradedAttemptIdentity(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    attempt_id: str
    task_id: str
    base_commit: str
    patch_sha256: str


class GradeArtifacts(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    stdout: ArtifactFile
    stderr: ArtifactFile


class GradeRecord(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    schema_version: int = 1
    grade_id: str
    created_at: str
    outcome: GradeOutcome
    attempt: GradedAttemptIdentity
    grader: GraderIdentity
    result: GradePayload | None
    infrastructure_error: str | None
    artifacts: GradeArtifacts


@dataclass(frozen=True, slots=True)
class RegradeConfig:
    attempt_path: Path
    source_repo: Path
    grader_repo: Path
    artifacts_dir: Path
    grader_command: tuple[str, ...]
    grader_version: str
    grader_manifest_path: Path
    timeout_seconds: int
    passed_environment: tuple[str, ...]


class ArtifactIntegrityError(Exception):
    __slots__: tuple[str, str] = ("path", "reason")

    path: Path
    reason: str

    def __init__(self, path: Path, reason: str) -> None:
        self.path = path
        self.reason = reason
        super().__init__(str(self))

    def __str__(self) -> str:
        return f"attempt artifact integrity failed for {self.path}: {self.reason}"


def _load_attempt(path: Path) -> AttemptRecord:
    try:
        return AttemptRecord.model_validate_json(path.read_bytes())
    except (OSError, ValidationError) as exc:
        raise ArtifactIntegrityError(path=path, reason=str(exc)) from exc


def _verify_artifact(root: Path, name: str, artifact: ArtifactFile) -> Path:
    path = root / artifact.path
    observed = sha256_file(path)
    if observed != artifact.sha256:
        raise ArtifactIntegrityError(
            path=path,
            reason=f"{name} sha256 mismatch: registered {artifact.sha256}, observed {observed}",
        )
    return path


def _artifact(root: Path, path: Path) -> ArtifactFile:
    return ArtifactFile(
        path=str(path.relative_to(root)),
        sha256=sha256_file(path),
        bytes=path.stat().st_size,
    )


def _grader_environment(config: RegradeConfig) -> dict[str, str]:
    runtime = config.artifacts_dir / "runtime"
    home = runtime / "home"
    temporary = runtime / "tmp"
    home.mkdir(parents=True)
    temporary.mkdir()
    environment = {
        name: os.environ[name]
        for name in BASE_ENVIRONMENT
        if name in os.environ
    }
    for name in config.passed_environment:
        if name in os.environ:
            environment[name] = os.environ[name]
    environment.update({"HOME": str(home), "TMPDIR": str(temporary)})
    return environment


def run_regrade(config: RegradeConfig) -> GradeRecord:
    attempt = _load_attempt(config.attempt_path)
    attempt_root = config.attempt_path.parent
    patch_path = _verify_artifact(attempt_root, "patch", attempt.artifacts.patch)
    _verify_artifact(attempt_root, "status", attempt.artifacts.status)
    _verify_artifact(attempt_root, "transcript", attempt.artifacts.transcript)
    grader_bundle_sha = sha256_file(config.grader_manifest_path)
    if config.artifacts_dir.exists():
        raise FileExistsError(config.artifacts_dir)
    config.artifacts_dir.mkdir(parents=True)
    prepare_candidate(
        CloneSpec(
            source_repo=config.source_repo,
            candidate_repo=config.grader_repo,
            base_commit=attempt.repository.base_commit,
        )
    )
    apply_binary_patch(config.grader_repo, patch_path)
    started = time.monotonic()
    result_payload: GradePayload | None = None
    infrastructure_error: str | None = None
    try:
        process = subprocess.run(
            config.grader_command,
            check=False,
            cwd=config.grader_repo,
            env=_grader_environment(config),
            capture_output=True,
            text=True,
            timeout=config.timeout_seconds,
        )
        stdout = process.stdout
        stderr = process.stderr
        if process.returncode != 0:
            outcome = GradeOutcome.INFRA_ERROR
            infrastructure_error = f"grader exited {process.returncode}"
        else:
            try:
                parsed = GradePayload.model_validate_json(stdout)
            except ValidationError as exc:
                outcome = GradeOutcome.INFRA_ERROR
                infrastructure_error = f"invalid grader result: {exc}"
            else:
                if parsed.grader_version != config.grader_version:
                    outcome = GradeOutcome.INFRA_ERROR
                    infrastructure_error = (
                        f"grader version mismatch: expected {config.grader_version}, "
                        f"observed {parsed.grader_version}"
                    )
                else:
                    outcome = GradeOutcome.COMPLETED
                    result_payload = parsed
    except subprocess.TimeoutExpired as exc:
        outcome = GradeOutcome.TIMEOUT
        stdout = (
            exc.stdout.decode("utf-8", errors="replace")
            if isinstance(exc.stdout, bytes)
            else exc.stdout or ""
        )
        stderr = (
            exc.stderr.decode("utf-8", errors="replace")
            if isinstance(exc.stderr, bytes)
            else exc.stderr or ""
        )
        infrastructure_error = f"grader exceeded {config.timeout_seconds}s timeout"
    except FileNotFoundError as exc:
        outcome = GradeOutcome.INFRA_ERROR
        stdout = ""
        stderr = str(exc)
        infrastructure_error = str(exc)
    elapsed = round(time.monotonic() - started, 6)
    stdout_path = config.artifacts_dir / "grader.stdout"
    stderr_path = config.artifacts_dir / "grader.stderr"
    stdout_path.write_text(stdout, encoding="utf-8")
    stderr_path.write_text(stderr, encoding="utf-8")
    record = GradeRecord(
        grade_id=uuid.uuid4().hex,
        created_at=datetime.now(tz=UTC).isoformat(),
        outcome=outcome,
        attempt=GradedAttemptIdentity(
            attempt_id=attempt.attempt_id,
            task_id=attempt.task.task_id,
            base_commit=attempt.repository.base_commit,
            patch_sha256=attempt.artifacts.patch.sha256,
        ),
        grader=GraderIdentity(
            version=config.grader_version,
            bundle_sha256=grader_bundle_sha,
            command=config.grader_command,
            elapsed_seconds=elapsed,
        ),
        result=result_payload,
        infrastructure_error=infrastructure_error,
        artifacts=GradeArtifacts(
            stdout=_artifact(config.artifacts_dir, stdout_path),
            stderr=_artifact(config.artifacts_dir, stderr_path),
        ),
    )
    (config.artifacts_dir / "grade.json").write_text(
        record.model_dump_json(indent=2) + "\n",
        encoding="utf-8",
    )
    return record
