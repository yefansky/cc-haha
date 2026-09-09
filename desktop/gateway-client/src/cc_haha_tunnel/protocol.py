"""Versioned JSON-over-WebSocket protocol shared by both tunnel endpoints."""

from __future__ import annotations

import base64
import binascii
import json
import math
import re
from dataclasses import asdict, dataclass
from enum import StrEnum
from typing import Any, Iterable, Iterator, Mapping, Sequence


PROTOCOL_VERSION = 1
CREDIT_WINDOW_CAPABILITY = "credit-window-v1"
CREDIT_WINDOW_SIZE = 4
MAX_SAFE_SEQUENCE = (1 << 53) - 1
MAX_DECODED_CHUNK = 64 * 1024
MAX_CONTROL_FRAME = 256 * 1024
MAX_WS_MESSAGE = 32 * 1024
MAX_HEADER_COUNT = 128
MAX_HEADER_NAME = 128
MAX_HEADER_VALUE = 16 * 1024


class ErrorCode(StrEnum):
    """Stable machine-readable errors exposed by protocol version 1."""

    UNAUTHENTICATED = "UNAUTHENTICATED"
    KEY_INVALID = "KEY_INVALID"
    KEY_REVOKED = "KEY_REVOKED"
    KEY_IN_USE = "KEY_IN_USE"
    DEVICE_OFFLINE = "DEVICE_OFFLINE"
    UPSTREAM_TIMEOUT = "UPSTREAM_TIMEOUT"
    UPSTREAM_REJECTED = "UPSTREAM_REJECTED"
    PROTOCOL_ERROR = "PROTOCOL_ERROR"
    LIMIT_EXCEEDED = "LIMIT_EXCEEDED"


class ProtocolError(ValueError):
    """A malformed or disallowed protocol message."""

    def __init__(
        self,
        message: str,
        code: ErrorCode = ErrorCode.PROTOCOL_ERROR,
    ) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class ProtocolLimits:
    max_chunk_bytes: int = MAX_DECODED_CHUNK
    max_request_body: int = 2 * 1024 * 1024
    max_response_body: int = 32 * 1024 * 1024
    max_ws_message: int = MAX_WS_MESSAGE
    max_inflight_http: int = 32
    max_browser_websockets: int = 16
    upstream_connect_timeout: float = 5.0
    http_timeout: float = 30.0
    liveness_timeout: float = 45.0

    def to_wire(self) -> dict[str, int | float]:
        return asdict(self)


MESSAGE_TYPES = frozenset(
    {
        "hello",
        "ready",
        "error",
        "http.request.start",
        "http.response.start",
        "http.error",
        "stream.data",
        "stream.end",
        "stream.credit",
        "cancel",
        "ws.open",
        "ws.accept",
        "ws.reject",
        "ws.message",
        "ws.close",
    }
)

STREAM_MESSAGE_TYPES = frozenset(
    MESSAGE_TYPES - {"hello", "ready", "error"}
)

_STREAM_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_CONNECTION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_HEADER_NAME_RE = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")


def encode_message(message: Mapping[str, Any]) -> str:
    """Validate and encode one compact JSON control frame."""

    validated = validate_message(message)
    encoded = json.dumps(
        validated,
        ensure_ascii=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    if len(encoded.encode("utf-8")) > MAX_CONTROL_FRAME:
        raise ProtocolError("control frame is too large", ErrorCode.LIMIT_EXCEEDED)
    return encoded


def decode_message(payload: str | bytes) -> dict[str, Any]:
    """Decode one text frame; binary WebSocket protocol frames are forbidden."""

    if not isinstance(payload, str):
        raise ProtocolError("protocol frames must be WebSocket text frames")
    if len(payload.encode("utf-8")) > MAX_CONTROL_FRAME:
        raise ProtocolError("control frame is too large", ErrorCode.LIMIT_EXCEEDED)
    try:
        value = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise ProtocolError("invalid JSON protocol frame") from exc
    if not isinstance(value, dict):
        raise ProtocolError("protocol frame must be a JSON object")
    return validate_message(value)


def validate_message(message: Mapping[str, Any]) -> dict[str, Any]:
    """Return a plain validated mapping or raise :class:`ProtocolError`."""

    result = dict(message)
    message_type = result.get("type")
    if not isinstance(message_type, str) or message_type not in MESSAGE_TYPES:
        raise ProtocolError("unknown or missing message type")

    if message_type in STREAM_MESSAGE_TYPES:
        _require_identifier(result, "stream_id", _STREAM_ID_RE)

    if message_type == "hello":
        _require_protocol_version(result)
        _require_string(result, "client_version", 1, 128)
        _require_string_list(result, "capabilities", maximum=32)
        _require_credit_capability(result)
    elif message_type == "ready":
        _require_protocol_version(result)
        _require_identifier(result, "connection_id", _CONNECTION_ID_RE)
        result["limits"] = validate_protocol_limits(result.get("limits")).to_wire()
        _require_string_list(result, "capabilities", maximum=32)
        _require_credit_capability(result)
    elif message_type == "error":
        _validate_error(result)
    elif message_type == "http.request.start":
        _require_string(result, "method", 1, 32)
        _require_string(result, "target", 1, 16 * 1024)
        result["headers"] = normalize_headers(result.get("headers", []))
    elif message_type == "http.response.start":
        status = result.get("status")
        if not isinstance(status, int) or isinstance(status, bool) or not 100 <= status <= 599:
            raise ProtocolError("invalid HTTP response status")
        result["headers"] = normalize_headers(result.get("headers", []))
    elif message_type in {"http.error", "ws.reject"}:
        _validate_error(result)
    elif message_type == "stream.data":
        validate_sequence(result.get("seq"), minimum=1)
        decode_chunk(result)
    elif message_type == "stream.end":
        validate_sequence(result.get("last_seq"))
    elif message_type == "stream.credit":
        validate_sequence(result.get("consumed"))
    elif message_type == "cancel":
        reason = result.get("reason")
        if reason is not None and (not isinstance(reason, str) or len(reason) > 256):
            raise ProtocolError("invalid cancellation reason")
    elif message_type == "ws.open":
        _require_string(result, "target", 1, 16 * 1024)
        result["headers"] = normalize_headers(result.get("headers", []))
        protocols = result.get("protocols", [])
        result["protocols"] = _validate_protocols(protocols)
    elif message_type == "ws.accept":
        protocol = result.get("protocol")
        if protocol is not None and (not isinstance(protocol, str) or len(protocol) > 256):
            raise ProtocolError("invalid WebSocket subprotocol")
        result["headers"] = normalize_headers(result.get("headers", []))
    elif message_type == "ws.message":
        validate_sequence(result.get("seq"), minimum=1)
        kind = result.get("kind")
        if kind not in {"text", "binary", "ping", "pong"}:
            raise ProtocolError("invalid WebSocket message kind")
        if kind == "text":
            text = result.get("text")
            if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_WS_MESSAGE:
                raise ProtocolError(
                    "WebSocket message is too large",
                    ErrorCode.LIMIT_EXCEEDED,
                )
            if "data" in result:
                raise ProtocolError("text WebSocket message cannot contain data")
        else:
            if len(decode_chunk(result)) > MAX_WS_MESSAGE:
                raise ProtocolError(
                    "WebSocket message is too large",
                    ErrorCode.LIMIT_EXCEEDED,
                )
    elif message_type == "ws.close":
        code = result.get("code", 1000)
        if not isinstance(code, int) or isinstance(code, bool) or not 1000 <= code <= 4999:
            raise ProtocolError("invalid WebSocket close code")
        reason = result.get("reason", "")
        if not isinstance(reason, str) or len(reason.encode("utf-8")) > 123:
            raise ProtocolError("invalid WebSocket close reason")

    return result


def make_chunk(stream_id: str, data: bytes, *, seq: int | None = None) -> dict[str, Any]:
    if not _STREAM_ID_RE.fullmatch(stream_id):
        raise ProtocolError("invalid stream_id")
    if len(data) > MAX_DECODED_CHUNK:
        raise ProtocolError("decoded chunk exceeds 64 KiB", ErrorCode.LIMIT_EXCEEDED)
    message: dict[str, Any] = {
        "type": "stream.data",
        "stream_id": stream_id,
        "data": base64.b64encode(data).decode("ascii"),
    }
    if seq is not None:
        message["seq"] = validate_sequence(seq, minimum=1)
    return message


def make_ws_data(stream_id: str, kind: str, data: bytes, *, seq: int | None = None) -> dict[str, Any]:
    if kind not in {"binary", "ping", "pong"}:
        raise ProtocolError("binary WebSocket kind required")
    if len(data) > MAX_WS_MESSAGE:
        raise ProtocolError(
            "WebSocket message is too large", ErrorCode.LIMIT_EXCEEDED
        )
    message = make_chunk(stream_id, data, seq=seq)
    message["type"] = "ws.message"
    message["kind"] = kind
    return message


def decode_chunk(message: Mapping[str, Any]) -> bytes:
    encoded = message.get("data")
    if not isinstance(encoded, str):
        raise ProtocolError("chunk data must be Base64 text")
    if len(encoded) > ((MAX_DECODED_CHUNK + 2) // 3) * 4:
        raise ProtocolError("decoded chunk exceeds 64 KiB", ErrorCode.LIMIT_EXCEEDED)
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ProtocolError("invalid Base64 chunk") from exc
    if len(decoded) > MAX_DECODED_CHUNK:
        raise ProtocolError("decoded chunk exceeds 64 KiB", ErrorCode.LIMIT_EXCEEDED)
    return decoded


def chunk_bytes(data: bytes, chunk_size: int = MAX_DECODED_CHUNK) -> Iterator[bytes]:
    if not 1 <= chunk_size <= MAX_DECODED_CHUNK:
        raise ValueError("chunk_size must be between 1 and 65536")
    for offset in range(0, len(data), chunk_size):
        yield data[offset : offset + chunk_size]


_INTEGER_LIMIT_FIELDS = frozenset(
    {
        "max_chunk_bytes",
        "max_request_body",
        "max_response_body",
        "max_ws_message",
        "max_inflight_http",
        "max_browser_websockets",
    }
)
_FLOAT_LIMIT_FIELDS = frozenset(
    {"upstream_connect_timeout", "http_timeout", "liveness_timeout"}
)


def validate_protocol_limits(
    value: Any,
    *,
    local_limits: ProtocolLimits | None = None,
) -> ProtocolLimits:
    """Validate ready limits without allowing the peer to raise local caps.

    Missing fields retain the local default.  Unknown fields are rejected so a
    misspelled safety limit cannot silently fall back to a less restrictive
    value.  Booleans are rejected explicitly because ``bool`` subclasses
    ``int`` in Python.
    """

    if not isinstance(value, dict):
        raise ProtocolError("ready.limits must be an object")
    local = local_limits or ProtocolLimits()
    known = _INTEGER_LIMIT_FIELDS | _FLOAT_LIMIT_FIELDS
    unknown = set(value) - known
    if unknown:
        raise ProtocolError("ready.limits contains unknown fields")

    negotiated: dict[str, int | float] = {}
    for name in _INTEGER_LIMIT_FIELDS:
        candidate = value.get(name, getattr(local, name))
        maximum = getattr(local, name)
        if (
            not isinstance(candidate, int)
            or isinstance(candidate, bool)
            or candidate <= 0
            or candidate > maximum
        ):
            raise ProtocolError(f"invalid ready limit: {name}")
        negotiated[name] = candidate

    for name in _FLOAT_LIMIT_FIELDS:
        candidate = value.get(name, getattr(local, name))
        maximum = getattr(local, name)
        if (
            not isinstance(candidate, (int, float))
            or isinstance(candidate, bool)
            or not math.isfinite(candidate)
            or candidate <= 0
            or candidate > maximum
        ):
            raise ProtocolError(f"invalid ready limit: {name}")
        negotiated[name] = float(candidate)

    return ProtocolLimits(**negotiated)


def normalize_headers(value: Any) -> list[list[str]]:
    """Validate the wire representation while preserving duplicate headers."""

    if isinstance(value, Mapping):
        items: Iterable[Sequence[Any]] = value.items()
    elif isinstance(value, list):
        items = value
    else:
        raise ProtocolError("headers must be a list of pairs")

    normalized: list[list[str]] = []
    for item in items:
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            raise ProtocolError("each header must be a name/value pair")
        name, header_value = item
        if not isinstance(name, str) or not isinstance(header_value, str):
            raise ProtocolError("header name and value must be text")
        if (
            not name
            or len(name) > MAX_HEADER_NAME
            or not _HEADER_NAME_RE.fullmatch(name)
        ):
            raise ProtocolError("invalid header name")
        if (
            len(header_value) > MAX_HEADER_VALUE
            or "\r" in header_value
            or "\n" in header_value
            or "\x00" in header_value
        ):
            raise ProtocolError("invalid header value")
        normalized.append([name, header_value])
        if len(normalized) > MAX_HEADER_COUNT:
            raise ProtocolError("too many headers", ErrorCode.LIMIT_EXCEEDED)
    return normalized


def error_message(code: ErrorCode, message: str, *, stream_id: str | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"type": "error", "code": code.value, "message": message[:256]}
    if stream_id is not None:
        if not _STREAM_ID_RE.fullmatch(stream_id):
            raise ProtocolError("invalid stream_id")
        result["stream_id"] = stream_id
    return result


def _validate_error(message: Mapping[str, Any]) -> None:
    code = message.get("code")
    try:
        ErrorCode(code)
    except (TypeError, ValueError) as exc:
        raise ProtocolError("invalid stable error code") from exc
    _require_string(message, "message", 0, 256)


def _require_protocol_version(message: Mapping[str, Any]) -> None:
    version = message.get("protocol_version")
    if not isinstance(version, int) or isinstance(version, bool) or version != PROTOCOL_VERSION:
        raise ProtocolError("unsupported protocol version")


def validate_sequence(value: Any, *, minimum: int = 0) -> int:
    """Validate a non-wrapping, JSON-safe flow counter (never a bool)."""
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= MAX_SAFE_SEQUENCE:
        raise ProtocolError("invalid flow sequence")
    return value


def _require_credit_capability(message: Mapping[str, Any]) -> None:
    capabilities = message["capabilities"]
    if len(set(capabilities)) != len(capabilities):
        raise ProtocolError("duplicate capabilities")
    if CREDIT_WINDOW_CAPABILITY not in capabilities:
        raise ProtocolError("credit-window-v1 capability is required")


def _require_identifier(message: Mapping[str, Any], key: str, pattern: re.Pattern[str]) -> str:
    value = message.get(key)
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ProtocolError(f"invalid {key}")
    return value


def _require_string(
    message: Mapping[str, Any], key: str, minimum: int, maximum: int
) -> str:
    value = message.get(key)
    if not isinstance(value, str) or not minimum <= len(value) <= maximum:
        raise ProtocolError(f"invalid {key}")
    if "\x00" in value:
        raise ProtocolError(f"invalid {key}")
    return value


def _require_string_list(
    message: Mapping[str, Any], key: str, *, maximum: int
) -> list[str]:
    value = message.get(key)
    if not isinstance(value, list) or len(value) > maximum:
        raise ProtocolError(f"invalid {key}")
    if any(not isinstance(item, str) or not item or len(item) > 128 for item in value):
        raise ProtocolError(f"invalid {key}")
    return value


def _validate_protocols(value: Any) -> list[str]:
    if not isinstance(value, list) or len(value) > 32:
        raise ProtocolError("invalid WebSocket protocols")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item or len(item) > 256:
            raise ProtocolError("invalid WebSocket protocol")
        if any(char in item for char in "\r\n\x00,"):
            raise ProtocolError("invalid WebSocket protocol")
        result.append(item)
    return result
