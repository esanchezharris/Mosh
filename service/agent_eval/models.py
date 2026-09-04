from __future__ import annotations

import hashlib
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path, PurePosixPath
from typing import Annotated, Literal, assert_never

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

CommitSha = Annotated[str, Field(pattern=r"^[0-9a-f]{40}$")]
Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
TaskId = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9._-]+$")]
PositiveInt = Annotated[int, Field(strict=True, gt=0)]


class TaskStatus(StrEnum):
    DRAFT = "draft"
    READY = "ready"


class PromptPathError(ValueError):
    __slots__ = ("path",)

    path: str

    def __init__(self, path: str) -> None:
        self.path = path
        super().__init__(f"prompt path must stay inside the task bundle: {path}")


class RepositorySpec(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    name: Annotated[str, Field(min_length=1)]
    base_commit: CommitSha


class PromptSpec(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    path: Annotated[str, Field(min_length=1)]
    sha256: Sha256

    @field_validator("path")
    @classmethod
    def relative_public_path(cls, value: str) -> str:
        path = PurePosixPath(value)
        if path.is_absolute() or ".." in path.parts:
            raise PromptPathError(value)
        return value


class BudgetSpec(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    wall_seconds: PositiveInt
    token_limit: PositiveInt
    tool_call_limit: PositiveInt


class PublicCheckSpec(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    id: TaskId
    command: tuple[Annotated[str, Field(min_length=1)], ...] = Field(min_length=1)
    timeout_seconds: PositiveInt


class TaskManifest(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    schema_version: Literal[1]
    task_id: TaskId
    status: TaskStatus
    repository: RepositorySpec
    prompt: PromptSpec
    budget: BudgetSpec
    public_checks: tuple[PublicCheckSpec, ...]


@dataclass(frozen=True, slots=True)
class LoadedTask:
    manifest: TaskManifest
    manifest_path: Path
    manifest_sha256: str
    prompt_path: Path
    prompt_sha256: str
    prompt_text: str


class TaskManifestError(Exception):
    __slots__: tuple[str, str] = ("path", "reason")

    path: Path
    reason: str

    def __init__(self, path: Path, reason: str) -> None:
        self.path = path
        self.reason = reason
        super().__init__(str(self))

    def __str__(self) -> str:
        return f"invalid task manifest {self.path}: {self.reason}"


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_task(path: Path) -> LoadedTask:
    try:
        raw = path.read_bytes()
        manifest = TaskManifest.model_validate_json(raw)
        prompt_path = path.parent / manifest.prompt.path
        prompt_raw = prompt_path.read_bytes()
        prompt_text = prompt_raw.decode("utf-8")
    except (OSError, UnicodeDecodeError, ValidationError, ValueError) as exc:
        raise TaskManifestError(path=path, reason=str(exc)) from exc
    prompt_sha = sha256_bytes(prompt_raw)
    if prompt_sha != manifest.prompt.sha256:
        raise TaskManifestError(
            path=path,
            reason=(
                "prompt sha256 mismatch: "
                f"registered {manifest.prompt.sha256}, observed {prompt_sha}"
            ),
        )
    return LoadedTask(
        manifest=manifest,
        manifest_path=path.resolve(),
        manifest_sha256=sha256_bytes(raw),
        prompt_path=prompt_path.resolve(),
        prompt_sha256=prompt_sha,
        prompt_text=prompt_text,
    )


def require_ready(task: LoadedTask) -> LoadedTask:
    match task.manifest.status:
        case TaskStatus.READY:
            return task
        case TaskStatus.DRAFT:
            raise TaskManifestError(
                path=task.manifest_path,
                reason="task is draft; freeze the public contract before execution",
            )
        case unreachable:
            assert_never(unreachable)
