"""Typed, versioned NDJSON boundary for the native DAWN bridge."""

from __future__ import annotations

import json
import math
import os
import stat
from dataclasses import dataclass
from typing import Callable, Dict

from .model import Action, Again, Hear, JsonValue, Keep, Put, Request, Response, Seek, Stop


PROTOCOL_VERSION = 1


@dataclass(frozen=True)  # noqa: SLOTS_OK - Live 11 embeds Python 3.7.
class Descriptor:
    host: str
    port: int
    secret: str


@dataclass(frozen=True)  # noqa: SLOTS_OK - Live 11 embeds Python 3.7.
class ProtocolError(Exception):
    code: str

    def __str__(self) -> str:
        return self.code


def load_descriptor(path: str) -> Descriptor:
    try:
        descriptor_fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as error:
        raise ProtocolError("descriptor_unavailable") from error
    with os.fdopen(descriptor_fd, "r", encoding="utf-8") as stream:
        details = os.fstat(stream.fileno())
        if not stat.S_ISREG(details.st_mode) or stat.S_IMODE(details.st_mode) != 0o600:
            raise ProtocolError("descriptor_permissions")
        if details.st_uid != os.getuid():
            raise ProtocolError("descriptor_owner")
        try:
            decoded = json.load(stream)
        except json.JSONDecodeError as error:
            raise ProtocolError("descriptor_json") from error
    if not isinstance(decoded, dict):
        raise ProtocolError("descriptor_shape")
    if decoded.get("protocol") != PROTOCOL_VERSION:
        raise ProtocolError("descriptor_protocol")
    host = decoded.get("host")
    port = decoded.get("port")
    secret = decoded.get("secret")
    if host != "127.0.0.1":
        raise ProtocolError("descriptor_host")
    if isinstance(port, bool) or not isinstance(port, int) or not 0 < port < 65536:
        raise ProtocolError("descriptor_port")
    if not isinstance(secret, str) or len(secret) < 32:
        raise ProtocolError("descriptor_secret")
    return Descriptor(host, port, secret)


def parse_request(line: str) -> Request:
    try:
        decoded = json.loads(line)
    except json.JSONDecodeError as error:
        raise ProtocolError("request_json") from error
    if not isinstance(decoded, dict):
        raise ProtocolError("request_shape")
    if decoded.get("protocol") != PROTOCOL_VERSION or decoded.get("type") != "action":
        raise ProtocolError("request_protocol")
    request_id = decoded.get("requestId")
    revision = decoded.get("expectedRevision")
    action_name = decoded.get("action")
    if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
        raise ProtocolError("request_id")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
        raise ProtocolError("expected_revision")
    if not isinstance(action_name, str):
        raise ProtocolError("action")
    if action_name == "seek":
        raw_position = decoded.get("positionBeats")
        if isinstance(raw_position, bool) or not isinstance(raw_position, (int, float)):
            raise ProtocolError("seek_position")
        position = float(raw_position)
        if not math.isfinite(position) or position < 0.0:
            raise ProtocolError("seek_position")
        return Request(request_id, revision, Seek(position))
    constructors: Dict[str, Callable[[], Action]] = {
        "put": Put, "keep": Keep, "again": Again, "hear": Hear, "stop": Stop,
    }
    constructor = constructors.get(action_name)
    if constructor is None:
        raise ProtocolError("action")
    return Request(request_id, revision, constructor())


def default_descriptor_path() -> str:
    """Return the owner-local per-launch native bridge descriptor path."""
    override = os.environ.get("MOSH_DAWN_DESCRIPTOR")
    if override:
        return override
    return os.path.expanduser("~/Library/Application Support/Mosh/DAWN Bridge/remote-script.json")


def hello_line(secret: str) -> bytes:
    return _line({"protocol": PROTOCOL_VERSION, "type": "hello", "secret": secret})


def snapshot_line(state: Dict[str, JsonValue]) -> bytes:
    return _line({"protocol": PROTOCOL_VERSION, "type": "snapshot", "state": state})


def response_line(response: Response) -> bytes:
    payload: Dict[str, JsonValue] = {
        "protocol": PROTOCOL_VERSION,
        "type": "result",
        "ok": response.ok,
        "requestId": response.request_id,
        "revision": response.revision,
        "state": response.state,
    }
    if response.error is not None:
        payload["error"] = response.error
    return _line(payload)


def _line(payload: Dict[str, JsonValue]) -> bytes:
    return (json.dumps(payload, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
