from __future__ import annotations

from pathlib import Path
from typing import Annotated, TypeVar

import typer
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .attempt import AttemptConfig, run_attempt
from .git_ops import GitOperationError
from .grade import ArtifactIntegrityError, RegradeConfig, run_regrade
from .models import TaskManifestError, load_task
from .schema import schema_bundle

app = typer.Typer(no_args_is_help=True, pretty_exceptions_enable=False)
ModelT = TypeVar("ModelT", bound=BaseModel)
EnvironmentName = Annotated[str, Field(pattern=r"^[A-Z][A-Z0-9_]*$")]


class AttemptCliInput(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    task: Path
    source_repo: Path
    candidate_repo: Path
    artifacts_dir: Path
    agent_command: tuple[Annotated[str, Field(min_length=1)], ...] = Field(min_length=1)
    passed_environment: tuple[EnvironmentName, ...] = ()


class RegradeCliInput(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    attempt: Path
    source_repo: Path
    grader_repo: Path
    artifacts_dir: Path
    grader_command: tuple[Annotated[str, Field(min_length=1)], ...] = Field(min_length=1)
    grader_version: Annotated[str, Field(min_length=1)]
    grader_manifest: Path
    timeout_seconds: Annotated[int, Field(strict=True, gt=0)]
    passed_environment: tuple[EnvironmentName, ...] = ()


def _load_config(path: Path, model: type[ModelT]) -> ModelT:
    try:
        return model.model_validate_json(path.read_bytes())
    except (OSError, ValidationError) as exc:
        raise typer.BadParameter(f"invalid config {path}: {exc}") from exc


@app.command("attempt")
def attempt_command(
    config: Annotated[Path, typer.Option(exists=True, dir_okay=False, readable=True)],
) -> None:
    parsed = _load_config(config, AttemptCliInput)
    try:
        record = run_attempt(
            AttemptConfig(
                task=load_task(parsed.task),
                source_repo=parsed.source_repo,
                candidate_repo=parsed.candidate_repo,
                artifacts_dir=parsed.artifacts_dir,
                agent_command=parsed.agent_command,
                passed_environment=parsed.passed_environment,
            )
        )
    except (TaskManifestError, GitOperationError, FileExistsError) as exc:
        raise typer.BadParameter(str(exc)) from exc
    typer.echo(record.model_dump_json())


@app.command("regrade")
def regrade_command(
    config: Annotated[Path, typer.Option(exists=True, dir_okay=False, readable=True)],
) -> None:
    parsed = _load_config(config, RegradeCliInput)
    try:
        record = run_regrade(
            RegradeConfig(
                attempt_path=parsed.attempt,
                source_repo=parsed.source_repo,
                grader_repo=parsed.grader_repo,
                artifacts_dir=parsed.artifacts_dir,
                grader_command=parsed.grader_command,
                grader_version=parsed.grader_version,
                grader_manifest_path=parsed.grader_manifest,
                timeout_seconds=parsed.timeout_seconds,
                passed_environment=parsed.passed_environment,
            )
        )
    except (ArtifactIntegrityError, GitOperationError, FileExistsError) as exc:
        raise typer.BadParameter(str(exc)) from exc
    typer.echo(record.model_dump_json())


@app.command("schema")
def schema_command(
    output: Annotated[Path, typer.Option(dir_okay=False)],
) -> None:
    output.write_text(schema_bundle().model_dump_json(indent=2) + "\n", encoding="utf-8")
    typer.echo(str(output))


if __name__ == "__main__":
    app()
