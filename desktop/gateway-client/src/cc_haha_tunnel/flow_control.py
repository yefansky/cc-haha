"""Connection-local, four-slot cumulative flow control; no payload buffering.

All synchronous methods run on the owning event loop. Each direction has one
producer and one ordered consumer. Callers own transport and task lifetimes.
"""

from __future__ import annotations

import asyncio
import math
from collections.abc import Awaitable, Callable
from typing import Any

from .protocol import CREDIT_WINDOW_SIZE, MAX_SAFE_SEQUENCE, ProtocolError, validate_sequence


class FlowClosedError(RuntimeError):
    """The connection/stream no longer owns this window."""


class SendWindow:
    def __init__(self) -> None:
        self._sent_seq = 0
        self._peer_consumed = 0
        self._reserved = 0
        self._error: BaseException | None = None
        self._changed = asyncio.Event()

    @property
    def sent_seq(self) -> int:
        return self._sent_seq

    @property
    def peer_consumed(self) -> int:
        return self._peer_consumed

    @property
    def reserved(self) -> int:
        return self._reserved

    def _check_open(self) -> None:
        if self._error is not None:
            raise self._error

    async def reserve(self, *, deadline: float | None = None) -> Reservation:
        if deadline is not None and (isinstance(deadline, bool) or not isinstance(deadline, (int, float)) or not math.isfinite(deadline)):
            raise ValueError("deadline must be finite event-loop time")
        while True:
            self._check_open()
            if deadline is not None and asyncio.get_running_loop().time() >= deadline:
                raise TimeoutError("flow deadline expired")
            if self._sent_seq + self._reserved >= MAX_SAFE_SEQUENCE:
                raise ProtocolError("flow sequence exhausted")
            if self._sent_seq - self._peer_consumed + self._reserved < CREDIT_WINDOW_SIZE:
                self._reserved += 1
                return Reservation(self)
            self._changed.clear()
            async with asyncio.timeout_at(deadline):
                await self._changed.wait()

    def apply_credit(self, consumed: int) -> None:
        self._check_open()
        validate_sequence(consumed)
        if consumed > self._sent_seq:
            raise ProtocolError("credit acknowledges unsent data")
        if consumed > self._peer_consumed:
            self._peer_consumed = consumed
            self._changed.set()

    def close(self, error: BaseException | None = None) -> None:
        if self._error is None:
            self._error = error if error is not None else FlowClosedError("flow closed")
            self._changed.set()


class Reservation:
    def __init__(self, window: SendWindow) -> None:
        self._window = window
        self._active = True

    def commit(self) -> int:
        if not self._active:
            raise ProtocolError("reservation already resolved")
        window = self._window
        window._check_open()
        self._active = False
        window._reserved -= 1
        window._sent_seq += 1
        return window._sent_seq

    def release(self) -> None:
        if self._active:
            self._active = False
            self._window._reserved -= 1
            self._window._changed.set()


class ReceiveWindow:
    def __init__(self) -> None:
        self._received_seq = 0
        self._local_consumed = 0
        self._closed = False
        self._ended = False

    @property
    def received_seq(self) -> int:
        return self._received_seq

    @property
    def local_consumed(self) -> int:
        return self._local_consumed

    def accept(self, seq: int) -> None:
        if self._closed:
            raise FlowClosedError("flow closed")
        validate_sequence(seq, minimum=1)
        if self._ended or seq != self._received_seq + 1:
            raise ProtocolError("unexpected data sequence")
        if self._received_seq - self._local_consumed >= CREDIT_WINDOW_SIZE:
            raise ProtocolError("peer exceeded flow window")
        self._received_seq = seq

    def delivered(self, seq: int) -> int:
        validate_sequence(seq, minimum=1)
        if self._closed:
            return self._local_consumed  # A late lease cannot revive a closed stream.
        if seq <= self._local_consumed:
            return self._local_consumed
        if seq != self._local_consumed + 1 or seq > self._received_seq:
            raise ProtocolError("out-of-order delivery")
        self._local_consumed = seq
        return seq

    def end(self, last_seq: int) -> None:
        if self._closed:
            raise FlowClosedError("flow closed")
        validate_sequence(last_seq)
        if self._ended or last_seq != self._received_seq:
            raise ProtocolError("invalid stream end sequence")
        self._ended = True

    def close(self) -> None:
        self._closed = True


class CreditPump:
    """One caller-owned run task; at most one pending ACK per admitted stream.

    send failures propagate out of run: its owner must close the transport.
    Stream IDs MUST NOT be reused within the owning connection.
    """

    def __init__(self, send: Callable[[dict[str, Any]], Awaitable[None]], *, max_streams: int = 48, send_timeout: float = 5.0) -> None:
        if isinstance(max_streams, bool) or not isinstance(max_streams, int) or max_streams <= 0:
            raise ValueError("max_streams must be positive")
        if isinstance(send_timeout, bool) or not isinstance(send_timeout, (int, float)) or not math.isfinite(send_timeout) or send_timeout <= 0:
            raise ValueError("send_timeout must be finite and positive")
        self._send = send
        self._maximum = max_streams
        self._timeout = send_timeout
        self._active: dict[str, int] = {}
        self._pending: dict[str, int] = {}
        self._changed = asyncio.Event()
        self._closed = False
        self._runner: asyncio.Task[Any] | None = None

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    def register(self, stream_id: str) -> None:
        if self._closed:
            raise FlowClosedError("credit pump closed")
        if stream_id in self._active:
            raise ProtocolError("duplicate flow registration")
        if len(self._active) >= self._maximum:
            raise ProtocolError("credit pump admission exceeded")
        self._active[stream_id] = 0

    def mark(self, stream_id: str, consumed: int) -> None:
        if self._closed or stream_id not in self._active:
            return
        validate_sequence(consumed)
        if consumed <= self._active[stream_id]:
            return
        self._active[stream_id] = consumed
        self._pending[stream_id] = consumed
        self._changed.set()

    def discard(self, stream_id: str) -> None:
        self._active.pop(stream_id, None)
        self._pending.pop(stream_id, None)

    async def run(self) -> None:
        if self._runner is not None:
            raise RuntimeError("credit pump already running")
        if self._closed:
            return
        self._runner = asyncio.current_task()
        try:
            while not self._closed:
                if not self._pending:
                    self._changed.clear()
                    await self._changed.wait()
                    continue
                stream_id = next(iter(self._pending))
                consumed = self._pending.pop(stream_id)
                async with asyncio.timeout(self._timeout):
                    await self._send({"type": "stream.credit", "stream_id": stream_id, "consumed": consumed})
        finally:
            self._closed = True
            self._active.clear()
            self._pending.clear()
            self._runner = None

    async def close(self) -> None:
        self._closed = True
        self._active.clear()
        self._pending.clear()
        self._changed.set()
        runner = self._runner
        if runner is not None and runner is not asyncio.current_task():
            runner.cancel()
            await asyncio.gather(runner, return_exceptions=True)
