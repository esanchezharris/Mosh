from __future__ import annotations

import json

from pydantic import RootModel, TypeAdapter

from .attempt import AttemptRecord
from .grade import GradePayload, GradeRecord
from .models import TaskManifest

type JsonValue = str | int | float | bool | None | list[JsonValue] | dict[str, JsonValue]
type JsonObject = dict[str, JsonValue]
type SchemaMap = dict[str, JsonObject]
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
