"""Local binary WebSocket seam. No encryption, authentication or handler default.

Handlers are trusted local code and must cooperate with cancellation, bound
their own application work, and await/clean up any child tasks they create.
"""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from typing import Any, Protocol
from urllib.parse import unquote, urlsplit

from .flow_control import ReceiveWindow, SendWindow
from .protocol import decode_chunk, make_ws_data

PRIVACY_CHANNEL_PATH = "/_privacy/channel"
_IN_LOCAL_HANDLER: ContextVar[bool] = ContextVar("in_local_ws_handler", default=False)


def is_privacy_target(target: str) -> bool:
    """Reserve decoded namespace components, including noncanonical aliases.

Do not normalize an alias into an accepted endpoint: only the exact raw path
may be opened locally. Ordinary forwarding must reject every reserved alias.
"""
    path = urlsplit(target).path
    while True:
        decoded = unquote(path)
        if decoded == path:
            break
        path = decoded
    return any(part.lower().split(";", 1)[0] == "_privacy"
               for part in path.replace("\\", "/").split("/"))


def local_handler_active() -> bool:
    return _IN_LOCAL_HANDLER.get()


class LocalChannelClosed(RuntimeError):
    """This local channel no longer accepts messages."""


class LocalChannelProtocolError(ValueError):
    """A non-binary or oversized local message was rejected."""


class _State(Protocol):
    queue: asyncio.Queue[dict[str, Any]]
    sending: SendWindow
    receiving: ReceiveWindow
    changed: asyncio.Event
    terminal: dict[str, Any] | None
    failed: bool


class LocalWSChannel:
    """One ordered binary channel backed by the existing four-slot windows.

    All closes are aborts: receive() returns None and may discard queued
    records. Neither None nor a normal outer WS close proves a complete
    application transfer; a future authenticated session must verify its own
    FINAL/confirmation. Each returned message counts as consumed;
the handler must not move messages into an unbounded secondary queue.
"""

    def __init__(self, *, stream_id: str, state: _State,
                 send_frame: Callable[[dict[str, Any]], Awaitable[None]],
                 delivered: Callable[[int], None], max_message: int,
                 send_timeout: float) -> None:
        self._stream_id = stream_id
        self._state = state
        self._send_frame = send_frame
        self._delivered = delivered
        self._max_message = max_message
        self._send_timeout = send_timeout
        self._closed = False
        self._receive_lock = asyncio.Lock()
        self._send_lock = asyncio.Lock()

    @property
    def closed(self) -> bool:
        return self._closed

    async def receive(self) -> bytes | None:
        async with self._receive_lock:
            while True:
                if self._closed or self._state.terminal is not None or self._state.failed:
                    return None
                if not self._state.queue.empty():
                    message = self._state.queue.get_nowait()
                    if message["kind"] != "binary":
                        raise LocalChannelProtocolError("local channel requires binary messages")
                    data = decode_chunk(message)
                    if len(data) > self._max_message:
                        raise LocalChannelProtocolError("local message exceeds limit")
                    self._delivered(message["seq"])
                    return data
                self._state.changed.clear()
                await self._state.changed.wait()

    async def send(self, data: bytes) -> None:
        if not isinstance(data, bytes) or len(data) > self._max_message:
            raise LocalChannelProtocolError("local channel requires bounded bytes")
        try:
            # One deadline covers producer serialization, peer credit and I/O.
            async with asyncio.timeout(self._send_timeout):
                async with self._send_lock:
                    if self._closed or self._state.terminal is not None or self._state.failed:
                        raise LocalChannelClosed("local channel closed")
                    reservation = await self._state.sending.reserve()
                    try:
                        frame = make_ws_data(self._stream_id, "binary", data, seq=reservation.commit())
                        await self._send_frame(frame)
                    finally:
                        reservation.release()
        except BaseException:
            # A committed record may have reached the peer; never reuse
            # this channel after an uncertain send, credit timeout or cancel.
            await self.close()
            raise

    async def close(self) -> None:
        self._closed = True
        self._state.sending.close()
        self._state.receiving.close()
        while not self._state.queue.empty():
            self._state.queue.get_nowait()
        self._state.changed.set()

    async def _wait_closed(self) -> None:
        while not self._closed and self._state.terminal is None and not self._state.failed:
            self._state.changed.clear()
            await self._state.changed.wait()

    async def run(self, handler: LocalWSHandler) -> None:
        """Run after ws.accept; any peer close cancels local work promptly."""
        async def invoke() -> None:
            token = _IN_LOCAL_HANDLER.set(True)
            try:
                await handler(self)
            finally:
                _IN_LOCAL_HANDLER.reset(token)

        task = asyncio.create_task(invoke())
        watcher = asyncio.create_task(self._wait_closed())
        try:
            done, _ = await asyncio.wait((task, watcher), return_when=asyncio.FIRST_COMPLETED)
            if task in done:
                task.result()
        finally:
            await self.close()
            for child in (task, watcher):
                child.cancel()
            await asyncio.gather(task, watcher, return_exceptions=True)


LocalWSHandler = Callable[[LocalWSChannel], Awaitable[None]]
