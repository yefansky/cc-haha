"""Reconnect supervision for the single-attempt :class:`TunnelClient`.

The supervisor owns transport lifecycle only.  Every reconnect creates a new
``TunnelClient`` and no HTTP request or WebSocket application message is kept
or replayed here.
"""

from __future__ import annotations

import asyncio
import contextlib
import random as random_module
import ssl
import time
from enum import StrEnum
from typing import Any, Awaitable, Callable, Mapping, Protocol

from aiohttp import ClientError, ClientSSLError

from .protocol import ErrorCode, ProtocolError

from .client import TunnelClient, TunnelClientError


class SupervisorState(StrEnum):
    """Observable tunnel supervisor lifecycle states."""

    STOPPED = "stopped"
    CONNECTING = "connecting"
    ONLINE = "online"
    BACKOFF = "backoff"
    TERMINAL_ERROR = "terminal_error"
    STOPPING = "stopping"


class _ManagedClient(Protocol):
    """Small lifecycle surface required from a single-attempt client."""

    _failure: BaseException | None

    async def start(self) -> None: ...

    async def wait_closed(self) -> None: ...

    async def stop(self) -> None: ...


ClientFactory = Callable[..., _ManagedClient]
Clock = Callable[[], float]
RandomRange = Callable[[float, float], float]
Sleep = Callable[[float], Awaitable[None]]
EventSink = Callable[[Mapping[str, object]], None]


_TERMINAL_CODES = frozenset(
    {
        ErrorCode.KEY_INVALID.value,
        ErrorCode.KEY_REVOKED.value,
        ErrorCode.PROTOCOL_ERROR.value,
    }
)
_BASE_BACKOFF = 0.5
_MAX_BACKOFF = 30.0
_KEY_IN_USE_MIN_BACKOFF = 5.0
_STABLE_ONLINE_SECONDS = 30.0


class TunnelSupervisor:
    """Supervise fresh, single-attempt tunnel clients until stopped.

    Transient transport failures reconnect with full-jitter exponential
    backoff.  Backoff is reset only after one transport stays online for at
    least 30 seconds.  Terminal credential/protocol errors leave the
    supervisor in :attr:`SupervisorState.TERMINAL_ERROR` until explicitly
    stopped or started again.
    """

    def __init__(
        self,
        *,
        gateway_url: str,
        access_key: str,
        upstream_url: str,
        forwarder_token: str | None,
        client_factory: ClientFactory = TunnelClient,
        clock: Clock = time.monotonic,
        random: RandomRange = random_module.uniform,
        sleep: Sleep = asyncio.sleep,
        event_sink: EventSink | None = None,
    ) -> None:
        self.gateway_url = gateway_url
        self.upstream_url = upstream_url
        self._access_key = access_key
        self._forwarder_token = forwarder_token
        self.client_factory = client_factory
        self._clock = clock
        self._random = random
        self._sleep = sleep
        self.event_sink = event_sink

        self.state = SupervisorState.STOPPED
        self.last_error_code: str | None = None
        self._attempt = 0
        self._runner_task: asyncio.Task[None] | None = None
        self._client: _ManagedClient | None = None
        self._stop_requested = asyncio.Event()
        self._closed = asyncio.Event()
        self._closed.set()
        self._lifecycle_lock = asyncio.Lock()

    async def start(self) -> None:
        """Start supervision in the background; repeated calls are harmless."""

        async with self._lifecycle_lock:
            if self._runner_task is not None and not self._runner_task.done():
                return
            self.last_error_code = None
            self._attempt = 0
            self._stop_requested.clear()
            self._closed.clear()
            self._transition(SupervisorState.CONNECTING, attempt=0)
            self._runner_task = asyncio.create_task(
                self._supervise(), name="cc-haha-tunnel-supervisor"
            )

    async def run_forever(self) -> None:
        """Start supervision and wait for a terminal error or explicit stop."""

        await self.start()
        await self.wait_closed()

    async def wait_closed(self) -> None:
        await self._closed.wait()

    async def stop(self) -> None:
        """Interrupt connect, hello, online wait, or backoff and stop cleanly."""

        async with self._lifecycle_lock:
            runner = self._runner_task
            client = self._client
            if (
                self.state is SupervisorState.STOPPED
                and (runner is None or runner.done())
            ):
                self._closed.set()
                return
            self._stop_requested.set()
            self._transition(SupervisorState.STOPPING)

        if client is not None:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await client.stop()
        if runner is not None and runner is not asyncio.current_task():
            if not runner.done():
                runner.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await runner

        async with self._lifecycle_lock:
            # The captured runner identifies this stop operation's epoch.
            # Its client.stop() may outlive the runner and a later start().
            # No cleanup from that old epoch may touch the replacement.
            if self._runner_task is not runner:
                return
            self._runner_task = None
            self._client = None
            self._transition(SupervisorState.STOPPED)
            self._closed.set()

    async def _supervise(self) -> None:
        try:
            while not self._stop_requested.is_set():
                if self.state is not SupervisorState.CONNECTING:
                    self._transition(
                        SupervisorState.CONNECTING, attempt=self._attempt
                    )
                client = self.client_factory(
                    gateway_url=self.gateway_url,
                    access_key=self._access_key,
                    upstream_url=self.upstream_url,
                    forwarder_token=self._forwarder_token,
                )
                self._client = client
                online_started: float | None = None
                try:
                    await client.start()
                    if self._stop_requested.is_set():
                        break
                    online_started = self._clock()
                    self._transition(
                        SupervisorState.ONLINE, attempt=self._attempt
                    )
                    await client.wait_closed()
                    failure = getattr(client, "_failure", None)
                    if failure is not None:
                        raise failure
                    raise TunnelClientError(
                        ErrorCode.DEVICE_OFFLINE,
                        "tunnel transport closed",
                    )
                except asyncio.CancelledError:
                    if self._stop_requested.is_set():
                        break
                    raise
                except Exception as exc:
                    if self._stop_requested.is_set():
                        break
                    code, terminal = _classify_failure(exc)
                    self.last_error_code = code
                    if terminal:
                        self._transition(
                            SupervisorState.TERMINAL_ERROR,
                            attempt=self._attempt,
                            error_code=code,
                        )
                        return

                    if (
                        online_started is not None
                        and self._clock() - online_started
                        >= _STABLE_ONLINE_SECONDS
                    ):
                        self._attempt = 0
                    delay = self._retry_delay(code, self._attempt)
                    self._transition(
                        SupervisorState.BACKOFF,
                        attempt=self._attempt,
                        retry_delay=delay,
                        error_code=code,
                    )
                    self._attempt = min(self._attempt + 1, 63)
                    await self._sleep(delay)
                finally:
                    with contextlib.suppress(
                        asyncio.CancelledError, Exception
                    ):
                        await client.stop()
                    if self._client is client:
                        self._client = None
        except asyncio.CancelledError:
            if not self._stop_requested.is_set():
                raise
        except Exception:
            # Internal supervisor defects must not become a hot retry loop, and
            # exception messages are deliberately excluded from state events.
            self.last_error_code = ErrorCode.PROTOCOL_ERROR.value
            self._transition(
                SupervisorState.TERMINAL_ERROR,
                attempt=self._attempt,
                error_code=self.last_error_code,
            )
        finally:
            if self._stop_requested.is_set():
                self._transition(SupervisorState.STOPPED)
            self._closed.set()

    def _retry_delay(self, code: str, attempt: int) -> float:
        exponent = min(attempt, 16)
        upper = min(_MAX_BACKOFF, _BASE_BACKOFF * (2**exponent))
        lower = 0.0
        if code == ErrorCode.KEY_IN_USE.value:
            lower = _KEY_IN_USE_MIN_BACKOFF
            upper = max(lower, upper)
        delay = float(self._random(lower, upper))
        if not lower <= delay <= upper:
            raise ValueError("random backoff result is outside the requested window")
        return delay

    def _transition(self, state: SupervisorState, **fields: object) -> None:
        if self.state is state:
            return
        self.state = state
        event: dict[str, object] = {"event": "state", "state": state.value}
        for name in ("attempt", "retry_delay", "error_code"):
            if name in fields:
                event[name] = fields[name]
        sink = self.event_sink
        if sink is not None:
            with contextlib.suppress(Exception):
                sink(event)


def _classify_failure(exc: BaseException) -> tuple[str, bool]:
    # These inherit ClientError/OSError: classify before transient transports.
    # TLS_ERROR is a local supervisor/desktop event, not a tunnel wire code.
    # Fail closed until an explicit restart; never retry with weaker validation
    # or include certificate/hostname/exception details in status output.
    if isinstance(exc, (ClientSSLError, ssl.SSLError, ssl.CertificateError)):
        return "TLS_ERROR", True
    if isinstance(exc, ProtocolError):
        return ErrorCode.PROTOCOL_ERROR.value, True
    if isinstance(exc, TunnelClientError):
        code = str(exc.code)
        return code, code in _TERMINAL_CODES
    if isinstance(
        exc,
        (asyncio.TimeoutError, TimeoutError, ClientError, ConnectionError, OSError),
    ):
        return ErrorCode.DEVICE_OFFLINE.value, False
    return ErrorCode.PROTOCOL_ERROR.value, True


__all__ = ["SupervisorState", "TunnelSupervisor"]
