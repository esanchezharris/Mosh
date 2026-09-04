from __future__ import annotations

import json

from typing_extensions import TypeAliasType

from pydantic import RootModel, TypeAdapter

from .attempt import AttemptRecord
from .grade import GradePayload, GradeRecord
from .models import TaskManifest

# These were PEP 695 `type X = ...` statements, which are Python 3.12+ ONLY. The gate's
# CI interpreter is 3.11, where that is a SyntaxError — the module failed to import
# there, which is what made both agent_eval tests fail regardless of their contents.
#
# A plain `X: TypeAlias = "..."` is not a substitute: JsonValue is RECURSIVE, and
# pydantic rejects an implicit recursive alias (RecursionError, with a message pointing
# back at PEP 695). TypeAliasType is the runtime form of PEP 695 — pydantic's documented
# spelling for named recursive types — and it works on 3.11 and 3.12 alike.
JsonValue = TypeAliasType("JsonValue", "str | int | float | bool | None | list[JsonValue] | dict[str, JsonValue]")
JsonObject = TypeAliasType("JsonObject", "dict[str, JsonValue]")
SchemaMap = TypeAliasType("SchemaMap", "dict[str, JsonObject]")
JSON_OBJECT_ADAPTER = TypeAdapter(JsonObject)


class AgentEvalSchemas(RootModel[SchemaMap]):
    pass


def schema_bundle() -> AgentEvalSchemas:
    return AgentEvalSchemas(
        root={
            "task_manifest": JSON_OBJECT_ADAPTER.validate_json(
                json.dumps(TaskManifest.model_json_schema())
            ),
            "attempt_record": JSON_OBJECT_ADAPTER.validate_json(
                json.dumps(AttemptRecord.model_json_schema())
            ),
            "grade_payload": JSON_OBJECT_ADAPTER.validate_json(
                json.dumps(GradePayload.model_json_schema())
            ),
            "grade_record": JSON_OBJECT_ADAPTER.validate_json(
                json.dumps(GradeRecord.model_json_schema())
            ),
        }
    )
