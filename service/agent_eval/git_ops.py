from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path


class GitOperationError(Exception):
    __slots__: tuple[str, str] = ("command", "reason")

    command: tuple[str, ...]
    reason: str

    def __init__(self, command: tuple[str, ...], reason: str) -> None:
        self.command = command
        self.reason = reason
        super().__init__(str(self))

    def __str__(self) -> str:
        return f"git operation failed ({' '.join(self.command)}): {self.reason}"


@dataclass(frozen=True, slots=True)
class CloneSpec:
    source_repo: Path
    candidate_repo: Path
    base_commit: str


@dataclass(frozen=True, slots=True)
class PreparedCandidate:
    head: str
    independent_git_dir: bool


@dataclass(frozen=True, slots=True)
class WorkingTreeCapture:
    head_after: str
    status: str
    patch: str


def _git(repo: Path, args: tuple[str, ...]) -> str:
    command = ("git", "-C", str(repo), *args)
    try:
        result = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as exc:
        raise GitOperationError(command=command, reason=str(exc)) from exc
    except subprocess.CalledProcessError as exc:
        reason = exc.stderr.strip() or exc.stdout.strip() or f"exit {exc.returncode}"
        raise GitOperationError(command=command, reason=reason) from exc
    return result.stdout


def prepare_candidate(spec: CloneSpec) -> PreparedCandidate:
    if spec.candidate_repo.exists():
        raise GitOperationError(
            command=("prepare-candidate",),
            reason=f"candidate path already exists: {spec.candidate_repo}",
        )
    spec.candidate_repo.mkdir(parents=True)
    _git(spec.candidate_repo, ("init", "--quiet"))
    _git(
        spec.candidate_repo,
        (
            "-c",
            "protocol.file.allow=always",
            "fetch",
            "--quiet",
            "--depth=1",
            "--no-tags",
            str(spec.source_repo.resolve()),
            spec.base_commit,
        ),
    )
    _git(spec.candidate_repo, ("checkout", "--quiet", "--detach", "FETCH_HEAD"))
    head = _git(spec.candidate_repo, ("rev-parse", "HEAD")).strip()
    status = _git(
        spec.candidate_repo,
        ("status", "--porcelain=v2", "--untracked-files=all"),
    )
    common_raw = _git(spec.candidate_repo, ("rev-parse", "--git-common-dir")).strip()
    common_dir = (spec.candidate_repo / common_raw).resolve()
    independent = (
        (spec.candidate_repo / ".git").is_dir()
        and common_dir.is_relative_to(spec.candidate_repo.resolve())
    )
    if head != spec.base_commit or status or not independent:
        raise GitOperationError(
            command=("prepare-candidate",),
            reason=(
                f"candidate isolation failed: head={head}, clean={not bool(status)}, "
                f"independent_git_dir={independent}"
            ),
        )
    return PreparedCandidate(head=head, independent_git_dir=independent)


def capture_working_tree(repo: Path, base_commit: str) -> WorkingTreeCapture:
    head_after = _git(repo, ("rev-parse", "HEAD")).strip()
    status = _git(repo, ("status", "--porcelain=v2", "--untracked-files=all"))
    _git(repo, ("add", "-N", "--", "."))
    patch = _git(repo, ("diff", "--binary", "--full-index", base_commit, "--"))
    return WorkingTreeCapture(head_after=head_after, status=status, patch=patch)


def apply_binary_patch(repo: Path, patch_path: Path) -> None:
    _git(repo, ("apply", "--binary", str(patch_path.resolve())))
