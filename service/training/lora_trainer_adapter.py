from __future__ import annotations

import json
from typing import Any

from .trainer_job import available as trainer_available, backend_name as trainer_backend_name, train


def backend_name() -> str:
    return trainer_backend_name()


def available() -> bool:
    return trainer_available()


def train_adapter(corpus_bundle: str, output_dir: str, config: dict[str, Any]) -> dict[str, Any]:
    return train(corpus_bundle, output_dir, config)


def main() -> int:
    import argparse

    p = argparse.ArgumentParser(description="Run the LoRA trainer adapter.")
    p.add_argument("--corpus-bundle", required=True)
    p.add_argument("--output-dir", required=True)
    p.add_argument("--config-json", default="{}")
    ns = p.parse_args()
    config = json.loads(ns.config_json)
    result = train_adapter(ns.corpus_bundle, ns.output_dir, config)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
