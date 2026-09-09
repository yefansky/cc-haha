"""Secret-safe command-line entry point for the outbound tunnel supervisor."""

from __future__ import annotations

import argparse
import asyncio
from dataclasses import dataclass
import json
import os
import sys
from typing import IO, Mapping, Sequence

from .supervisor import SupervisorState, TunnelSupervisor


_ACCESS_KEY_ENV = "CC_HAHA_TUNNEL_ACCESS_KEY"
_FORWARDER_TOKEN_ENV = "CC_HAHA_TUNNEL_FORWARDER_TOKEN"
_EVENT_FIELDS = frozenset(
    {"event", "state", "attempt", "retry_delay", "error_code"}
)


class _SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        del message
        self.print_usage(sys.stderr)
        self.exit(2, f"{self.prog}: error: invalid arguments\n")


@dataclass(frozen=True, slots=True)
class _Secrets:
    access_key: str
    forwarder_token: str


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = _SafeArgumentParser(
        prog="python -m cc_haha_tunnel",
        description="Run the supervised outbound cc-haha tunnel client.",
        epilog=(
            "Secrets come from CC_HAHA_TUNNEL_ACCESS_KEY and "
            "CC_HAHA_TUNNEL_FORWARDER_TOKEN. If either is absent, stdin must "
            "contain one UTF-8 JSON line with access_key and forwarder_token "
            "(at most 8192 bytes excluding LF or CRLF). Flush the line to start; "
            "stdin may remain open."
        ),
    )
    parser.add_argument("--gateway", required=True, help="Gateway HTTP(S) origin")
    parser.add_argument(
        "--upstream", required=True, help="Literal-loopback cc-haha HTTP(S) origin"
    )
    return parser.parse_args(argv)


def _load_secrets(stdin: IO[str]) -> _Secrets:
    access_key = os.environ.get(_ACCESS_KEY_ENV)
    forwarder_token = os.environ.get(_FORWARDER_TOKEN_ENV)
    if not access_key or not forwarder_token:
        try:
            payload = _read_secret_line(stdin)
            value = json.loads(payload)
        except (json.JSONDecodeError, OSError, UnicodeError) as exc:
            raise ValueError("invalid secret input") from exc
        if not isinstance(value, dict):
            raise ValueError("invalid secret input")
        access_key = access_key or value.get("access_key")
        forwarder_token = forwarder_token or value.get("forwarder_token")
    if not isinstance(access_key, str) or not access_key:
        raise ValueError("missing access key")
    if not isinstance(forwarder_token, str) or not forwarder_token:
        raise ValueError("missing forwarder token")
    return _Secrets(access_key=access_key, forwarder_token=forwarder_token)


def _read_secret_line(stdin: IO[str]) -> str:
    """Read one bounded UTF-8 message, without requiring pipe EOF.

    Use the binary buffer for real stdin so Windows locale settings cannot
    change decoding or the byte limit. Text streams remain usable by callers.
    An EOF-terminated final line is accepted for file/StringIO compatibility.
    """
    source = getattr(stdin, "buffer", stdin)
    payload = bytearray()
    while True:
        unit = source.read(1)
        if unit in (b"", "", b"\n", "\n"):
            break
        payload.extend(unit.encode("utf-8") if isinstance(unit, str) else unit)
        # Allow a CR beyond the payload limit only as part of CRLF.
        if len(payload) > 8192 and not (
            len(payload) == 8193 and payload[-1:] == b"\r"
        ):
            raise ValueError("secret input is too large")
    if unit in (b"\n", "\n") and payload.endswith(b"\r"):
        payload.pop()
    if len(payload) > 8192:
        raise ValueError("secret input is too large")
    return payload.decode("utf-8")


def _json_line_sink(output: IO[str]):
    def emit(event: Mapping[str, object]) -> None:
        safe = {name: event[name] for name in sorted(_EVENT_FIELDS) if name in event}
        output.write(
            json.dumps(safe, ensure_ascii=True, separators=(",", ":")) + "\n"
        )
        output.flush()

    return emit


async def _run(
    args: argparse.Namespace,
    secrets: _Secrets,
    *,
    stdout: IO[str],
) -> int:
    supervisor = TunnelSupervisor(
        gateway_url=args.gateway,
        upstream_url=args.upstream,
        access_key=secrets.access_key,
        forwarder_token=secrets.forwarder_token,
        event_sink=_json_line_sink(stdout),
    )
    try:
        await supervisor.run_forever()
        return 2 if supervisor.state is SupervisorState.TERMINAL_ERROR else 0
    finally:
        await supervisor.stop()


def main(
    argv: Sequence[str] | None = None,
    *,
    stdin: IO[str] | None = None,
    stdout: IO[str] | None = None,
    stderr: IO[str] | None = None,
) -> int:
    source = stdin or sys.stdin
    output = stdout or sys.stdout
    error_output = stderr or sys.stderr
    try:
        args = _parse_args(argv)
        secrets = _load_secrets(source)
    except ValueError:
        _json_line_sink(error_output)(
            {"event": "error", "error_code": "CONFIG_ERROR"}
        )
        return 2
    try:
        return asyncio.run(_run(args, secrets, stdout=output))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
