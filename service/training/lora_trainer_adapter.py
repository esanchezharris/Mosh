from __future__ import annotations

from .trainer_job import available as trainer_available, backend_name as trainer_backend_name


def backend_name() -> str:
    return trainer_backend_name()


def available() -> bool:
    return trainer_available()
