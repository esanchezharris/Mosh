from __future__ import annotations

import json
import os
import subprocess
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Final, assert_never

from pydantic import BaseModel, ConfigDict

from .git_ops import CloneSpec, capture_working_tree, prepare_candidate
from .models import LoadedTask, require_ready, sha256_file

BASE_ENVIRONMENT: Final = ("PATH", "LANG", "LC_ALL", "TERM")


class AttemptOutcome(StrEnum):
    COMPLETED = "completed"
    AGENT_ERROR = "agent_error"
    TIMEOUT = "timeout"
    INFRA_ERROR = "infra_error"


class ArtifactFile(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    path: str
    sha256: str
    bytes: int


class ArtifactSet(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    patch: ArtifactFile
    status: ArtifactFile
    transcript: ArtifactFile


class RepositoryIdentity(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str
    base_commit: str
    head_after: str
    independent_git_dir: bool


class AgentResult(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    command: tuple[str, ...]
    passed_environment: tuple[str, ...]
    exit_code: int | None
    elapsed_seconds: float


class TaskIdentity(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    task_id: str
    manifest_sha256: str
    prompt_sha256: str


class BudgetObservation(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    wall_seconds_limit: int
    token_limit: int
    tool_call_limit: int
    token_usage: int | None = None
    tool_call_usage: int | None = None


class AttemptRecord(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    schema_version: int = 1
    attempt_id: str
    created_at: str
    outcome: AttemptOutcome
    task: TaskIdentity
    repository: RepositoryIdentity
    agent: AgentResult
    budget: BudgetObservation
    artifacts: ArtifactSet


@dataclass(frozen=True, slots=True)
class AttemptConfig:
    task: LoadedTask
    source_repo: Path
    candidate_repo: Path
    artifacts_dir: Path
    agent_command: tuple[str, ...]
    passed_environment: tuple[str, ...]


def _artifact(root: Path, path: Path) -> ArtifactFile:
    return ArtifactFile(
        path=str(path.relative_to(root)),
        sha256=sha256_file(path),
        bytes=path.stat().st_size,
    )


def _stream_text(value: str | bytes | None) -> str:
    match value:
        case str():
            return value
        case bytes():
            return value.decode("utf-8", errors="replace")
        case None:
            return ""
        case unreachable:
            assert_never(unreachable)


def _agent_environment(config: AttemptConfig) -> dict[str, str]:
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
    environment.update(
        {
            "HOME": str(home),
            "TMPDIR": str(temporary),
            "MOSH_AGENT_TASK_ID": config.task.manifest.task_id,
        }
    )
    return environment


def run_attempt(config: AttemptConfig) -> AttemptRecord:
    task = require_ready(config.task)
    if config.artifacts_dir.exists():
        raise FileExistsError(config.artifacts_dir)
    config.artifacts_dir.mkdir(parents=True)
    prepared = prepare_candidate(
        CloneSpec(
            source_repo=config.source_repo,
            candidate_repo=config.candidate_repo,
            base_commit=task.manifest.repository.base_commit,
        )
    )
    started_at = datetime.now(tz=UTC).isoformat()
    started = time.monotonic()
    exit_code: int | None = None
    stdout = ""
    stderr = ""
    try:
        result = subprocess.run(
            config.agent_command,
            check=False,
            cwd=config.candidate_repo,
            env=_agent_environment(config),
            input=task.prompt_text,
            capture_output=True,
            text=True,
            timeout=task.manifest.budget.wall_seconds,
        )
        exit_code = result.returncode
        stdout = result.stdout
        stderr = result.stderr
        outcome = (
            AttemptOutcome.COMPLETED
            if result.returncode == 0
            else AttemptOutcome.AGENT_ERROR
        )
    except subprocess.TimeoutExpired as exc:
        stdout = _stream_text(exc.stdout)
        stderr = _stream_text(exc.stderr)
        outcome = AttemptOutcome.TIMEOUT
    except FileNotFoundError as exc:
        stderr = str(exc)
        outcome = AttemptOutcome.INFRA_ERROR
    elapsed = round(time.monotonic() - started, 6)
    capture = capture_working_tree(
        config.candidate_repo,
        task.manifest.repository.base_commit,
    )
    patch_path = config.artifacts_dir / "patch.diff"
    status_path = config.artifacts_dir / "status.porcelain-v2"
    transcript_path = config.artifacts_dir / "transcript.jsonl"
    patch_path.write_text(capture.patch, encoding="utf-8")
    status_path.write_text(capture.status, encoding="utf-8")
    transcript_path.write_text(
        "\n".join(
            (
                json.dumps({"stream": "stdout", "text": stdout}, sort_keys=True),
                json.dumps({"stream": "stderr", "text": stderr}, sort_keys=True),
            )
        )
        + "\n",
        encoding="utf-8",
    )
    record = AttemptRecord(
        attempt_id=uuid.uuid4().hex,
        created_at=started_at,
        outcome=outcome,
        task=TaskIdentity(
            task_id=task.manifest.task_id,
            manifest_sha256=task.manifest_sha256,
            prompt_sha256=task.prompt_sha256,
        ),
        repository=RepositoryIdentity(
            name=task.manifest.repository.name,
            base_commit=prepared.head,
            head_after=capture.head_after,
            independent_git_dir=prepared.independent_git_dir,
        ),
        agent=AgentResult(
            command=config.agent_command,
            passed_environment=config.passed_environment,
            exit_code=exit_code,
            elapsed_seconds=elapsed,
        ),
        budget=BudgetObservation(
            wall_seconds_limit=task.manifest.budget.wall_seconds,
            token_limit=task.manifest.budget.token_limit,
            tool_call_limit=task.manifest.budget.tool_call_limit,
        ),
        artifacts=ArtifactSet(
            patch=_artifact(config.artifacts_dir, patch_path),
            status=_artifact(config.artifacts_dir, status_path),
            transcript=_artifact(config.artifacts_dir, transcript_path),
        ),
    )
    (config.artifacts_dir / "attempt.json").write_text(
        record.model_dump_json(indent=2) + "\n",
        encoding="utf-8",
    )
    return record
