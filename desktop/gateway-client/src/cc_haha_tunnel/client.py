"""Outbound protocol-v1 tunnel client for a fixed literal-loopback upstream."""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import posixpath
import re
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Iterable
from urllib.parse import unquote, urlsplit, urlunsplit

from aiohttp import (
    ClientError,
    ClientResponse,
    ClientRequest,
    ClientSession,
    ClientTimeout,
    ClientWebSocketResponse,
    WSMsgType,
    WSServerHandshakeError,
)

try:  # aiohttp 3.12+; older supported releases accept a float timeout.
    from aiohttp import ClientWSTimeout
except ImportError:  # pragma: no cover - exercised by the aiohttp 3.9 gate
    ClientWSTimeout = None  # type: ignore[assignment,misc]

from .protocol import (
    CREDIT_WINDOW_CAPABILITY,
    MAX_CONTROL_FRAME,
    ErrorCode,
    ProtocolError,
    ProtocolLimits,
    decode_chunk,
    decode_message,
    encode_message,
    make_chunk,
    make_ws_data,
    validate_protocol_limits,
)
from .flow_control import CreditPump, ReceiveWindow, SendWindow


_TOKEN_RE = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
_BLOCKED_PATHS = ("/_gateway", "/_local", "/api/h5-access", "/sdk")
_FORWARDER_HEADER = "X-CC-Haha-Gateway-Forwarder"
_ALWAYS_DROPPED_HEADERS = {
    "authorization",
    "connection",
    "cookie",
    "forwarded",
    "host",
    "keep-alive",
    "origin",
    "proxy-authenticate",
    "proxy-authorization",
    "referer",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "via",
    "x-cc-haha-gateway-forwarder",
    "x-real-ip",
}


class TunnelClientError(RuntimeError):
    """A client failure carrying one stable protocol error code."""

    def __init__(self, code: ErrorCode | str, message: str) -> None:
        super().__init__(message)
        self.code = code.value if isinstance(code, ErrorCode) else code


_HTTP_WRITERS: ContextVar[list[asyncio.Task[Any]] | None] = ContextVar("http_writers", default=None)


class _TrackedClientRequest(ClientRequest):
    async def send(self, conn: Any) -> ClientResponse:
        response = await super().send(conn)
        writers = _HTTP_WRITERS.get()
        writer = getattr(self, "_writer", None)
        if writers is not None and writer is not None:
            writers.append(writer)
            writer.add_done_callback(_retrieve_writer_result)
        return response


class _NoRedirectClientSession(ClientSession):
    """Make aiohttp's WebSocket handshake inherit the no-redirect policy."""

    async def _request(self, method: str, str_or_url: Any, **kwargs: Any) -> ClientResponse:
        kwargs.setdefault("allow_redirects", False)
        return await super()._request(method, str_or_url, **kwargs)


@dataclass(slots=True)
class _HTTPInbound:
    queue: asyncio.Queue[tuple[int, bytes]]
    sending: SendWindow = field(default_factory=SendWindow)
    receiving: ReceiveWindow = field(default_factory=ReceiveWindow)
    deadline: float | None = None
    changed: asyncio.Event = field(default_factory=asyncio.Event)
    ended: bool = False
    size: int = 0
    task: asyncio.Task[None] | None = None


@dataclass(slots=True)
class _WSInbound:
    sending: SendWindow = field(default_factory=SendWindow)
    receiving: ReceiveWindow = field(default_factory=ReceiveWindow)
    queue: asyncio.Queue[dict[str, Any]] = field(default_factory=lambda: asyncio.Queue(maxsize=4))
    task: asyncio.Task[None] | None = None
    changed: asyncio.Event = field(default_factory=asyncio.Event)
    terminal: dict[str, Any] | None = None
    failed: bool = False
    cleanup: asyncio.Task[None] | None = None


class TunnelClient:
    """Connect outward to a gateway and forward only to one loopback origin."""

    def __init__(
        self,
        *,
        gateway_url: str,
        access_key: str,
        upstream_url: str,
        forwarder_token: str | None = None,
        client_version: str = "cc-haha-tunnel/0.1",
    ) -> None:
        self.gateway_url = _validate_gateway_url(gateway_url)
        self.access_key = access_key
        self.upstream_url = validate_upstream_url(upstream_url)
        self._forwarder_token = _validate_forwarder_token(forwarder_token)
        self.client_version = client_version
        self.limits = ProtocolLimits()
        self.connection_id: str | None = None

        self._session: ClientSession | None = None
        self._socket: ClientWebSocketResponse | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._streams: dict[str, _HTTPInbound | _WSInbound] = {}
        self._stream_tasks: set[asyncio.Task[None]] = set()
        self._http_controls: set[asyncio.Task[None]] = set()
        self._ws_controls: set[asyncio.Task[None]] = set()
        self._send_lock = asyncio.Lock()
        self._ready = asyncio.Event()
        self._stopped = asyncio.Event()
        self._stopped.set()
        self._failure: BaseException | None = None
        self._lifecycle_lock = asyncio.Lock()
        self._start_task: asyncio.Task[None] | None = None
        self._credit_pump: CreditPump | None = None
        self._credit_task: asyncio.Task[None] | None = None

    def __repr__(self) -> str:
        forwarder = "configured" if self._forwarder_token is not None else "disabled"
        return (
            f"{type(self).__name__}(gateway_url={self.gateway_url!r}, "
            f"upstream_url={self.upstream_url!r}, "
            f"client_version={self.client_version!r}, forwarder={forwarder!r})"
        )

    async def start(self) -> None:
        """Establish one transport; concurrent callers share one attempt."""

        async with self._lifecycle_lock:
            if self._socket is not None and not self._socket.closed:
                return
            task = self._start_task
            if task is None or task.done():
                task = asyncio.create_task(
                    self._start_once(), name="cc-haha-tunnel-connect"
                )
                self._start_task = task
        try:
            await asyncio.shield(task)
        finally:
            async with self._lifecycle_lock:
                if self._start_task is task and task.done():
                    self._start_task = None

    async def _start_once(self) -> None:
        self._failure = None
        self._ready.clear()
        self._stopped.clear()
        self.connection_id = None
        session = _NoRedirectClientSession(
            request_class=_TrackedClientRequest,
            timeout=ClientTimeout(
                total=None,
                connect=self.limits.upstream_connect_timeout,
            ),
            auto_decompress=False,
        )
        self._session = session
        try:
            async with asyncio.timeout(self.limits.upstream_connect_timeout):
                socket = await session.ws_connect(
                    _tunnel_endpoint(self.gateway_url),
                    headers={"Authorization": f"Bearer {self.access_key}"},
                    compress=0,
                    autoping=True,
                    autoclose=True,
                    heartbeat=max(1.0, self.limits.liveness_timeout / 3),
                    timeout=_websocket_timeout(
                        self.limits.upstream_connect_timeout
                    ),
                    max_msg_size=MAX_CONTROL_FRAME + 1,
                )
            self._socket = socket
            await self._send(
                {
                    "type": "hello",
                    "protocol_version": 1,
                    "client_version": self.client_version,
                    "capabilities": ["http", "websocket", CREDIT_WINDOW_CAPABILITY],
                }
            )
            raw = await asyncio.wait_for(socket.receive(), self.limits.upstream_connect_timeout)
            message = _decode_socket_message(raw)
            if message["type"] == "error":
                raise TunnelClientError(message["code"], message["message"])
            if message["type"] != "ready":
                raise TunnelClientError(ErrorCode.PROTOCOL_ERROR, "gateway did not send ready")
            capabilities = message["capabilities"]
            if not set(capabilities).issubset({"http", "websocket", CREDIT_WINDOW_CAPABILITY}):
                raise TunnelClientError(ErrorCode.PROTOCOL_ERROR, "unoffered gateway capability")
            self.connection_id = message["connection_id"]
            self.limits = _negotiated_limits(
                message["limits"], local_limits=self.limits
            )
            self._ready.set()
            self._credit_pump = CreditPump(
                self._send,
                max_streams=self.limits.max_inflight_http + self.limits.max_browser_websockets,
                send_timeout=self.limits.upstream_connect_timeout,
            )
            self._credit_task = asyncio.create_task(self._run_credit_pump(self._credit_pump))
            self._reader_task = asyncio.create_task(
                self._read_loop(), name=f"tunnel-client-{self.connection_id}"
            )
        except WSServerHandshakeError as exc:
            code = ErrorCode.KEY_INVALID if exc.status in {401, 403} else ErrorCode.UNAUTHENTICATED
            await self._close_transport()
            raise TunnelClientError(code, "gateway rejected tunnel authentication") from exc
        except BaseException:
            await self._close_transport()
            raise

    async def wait_until_ready(self, *, timeout: float = 5.0) -> None:
        if self._failure is not None:
            raise self._failure
        try:
            await asyncio.wait_for(self._ready.wait(), timeout)
        except TimeoutError as exc:
            if self._failure is not None:
                raise self._failure
            raise TunnelClientError(ErrorCode.UPSTREAM_TIMEOUT, "tunnel was not ready in time") from exc

    async def stop(self) -> None:
        """Stop connect/hello/online work exactly once and remain idempotent."""

        async with self._lifecycle_lock:
            starting = self._start_task
            reader = self._reader_task
            self._reader_task = None
            current = asyncio.current_task()
            if starting is not None and starting is not current and not starting.done():
                starting.cancel()
            if reader is not None and reader is not current and not reader.done():
                reader.cancel()

            if starting is not None and starting is not current:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await starting
            if self._start_task is starting:
                self._start_task = None

            await self._close_transport()
            if reader is not None and reader is not current:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await reader
            await self._cancel_streams()
            self._stopped.set()

    async def wait_closed(self) -> None:
        await self._stopped.wait()

    async def _read_loop(self) -> None:
        socket = self._socket
        assert socket is not None
        try:
            async for raw in socket:
                message = _decode_socket_message(raw)
                try:
                    await self._dispatch(message)
                except ProtocolError as exc:
                    stream_id = message.get("stream_id")
                    state = self._streams.get(stream_id)
                    if isinstance(state, _HTTPInbound):
                        self._fail_http(stream_id, state, exc.code)
                    elif isinstance(state, _WSInbound):
                        self._fail_ws(stream_id, state, exc.code)
                    else:
                        raise
        except asyncio.CancelledError:
            raise
        except BaseException as exc:
            self._failure = (
                TunnelClientError(exc.code, str(exc))
                if isinstance(exc, ProtocolError)
                else exc
            )
        finally:
            await self._cancel_streams()
            await self._close_transport()
            self._stopped.set()

    async def _dispatch(self, message: dict[str, Any]) -> None:
        message_type = message["type"]
        if message_type == "error":
            failure = TunnelClientError(message["code"], message["message"])
            self._failure = failure
            raise failure

        stream_id = message.get("stream_id")
        if not isinstance(stream_id, str):
            raise ProtocolError("unexpected connection-level frame after ready")

        if message_type == "http.request.start":
            if stream_id in self._streams:
                raise ProtocolError("duplicate stream_id")
            if (sum(isinstance(value, _HTTPInbound) for value in self._streams.values())
                    + len(self._http_controls) >= self.limits.max_inflight_http):
                self._spawn_rejection("http.error", stream_id, self._http_controls, self.limits.max_inflight_http)
                return
            state = _HTTPInbound(asyncio.Queue(maxsize=4))
            state.deadline = asyncio.get_running_loop().time() + self.limits.http_timeout
            self._register_flow(stream_id)
            self._streams[stream_id] = state
            state.task = self._spawn(self._forward_http(stream_id, state, message))
            return

        if message_type == "ws.open":
            if stream_id in self._streams:
                raise ProtocolError("duplicate stream_id")
            if (sum(isinstance(value, _WSInbound) for value in self._streams.values())
                    + len(self._ws_controls) >= self.limits.max_browser_websockets):
                self._spawn_rejection("ws.reject", stream_id, self._ws_controls, self.limits.max_browser_websockets)
                return
            state = _WSInbound()
            self._register_flow(stream_id)
            self._streams[stream_id] = state
            state.task = self._spawn(self._forward_websocket(stream_id, state, message))
            return

        state = self._streams.get(stream_id)
        if state is None:
            return
        if message_type == "cancel":
            self._release_flow(stream_id, state)
            if state.task is not None:
                state.task.cancel()
                controls = self._http_controls if isinstance(state, _HTTPInbound) else self._ws_controls
                controls.add(state.task)
                state.task.add_done_callback(controls.discard)
            return
        if message_type == "stream.credit":
            state.sending.apply_credit(message["consumed"])
            return
        if isinstance(state, _HTTPInbound):
            if message_type == "stream.data":
                chunk = decode_chunk(message)
                state.size += len(chunk)
                if (state.ended or len(chunk) > self.limits.max_chunk_bytes
                        or state.size > self.limits.max_request_body or state.queue.full()):
                    self._fail_http(stream_id, state, ErrorCode.LIMIT_EXCEEDED)
                else:
                    state.receiving.accept(message["seq"])
                    state.queue.put_nowait((message["seq"], chunk))
                    state.changed.set()
                return
            if message_type == "stream.end":
                state.receiving.end(message["last_seq"])
                state.ended = True
                state.changed.set()
                return
            raise ProtocolError("unexpected HTTP request stream frame")
        if message_type == "ws.message":
            if state.terminal is not None:
                return
            if message["kind"] == "text":
                size = len(message["text"].encode("utf-8"))
            else:
                size = len(decode_chunk(message))
            if size > self.limits.max_ws_message:
                raise ProtocolError(
                    "WebSocket message is too large",
                    ErrorCode.LIMIT_EXCEEDED,
                )
            try:
                state.receiving.accept(message["seq"])
                state.queue.put_nowait(message)
            except asyncio.QueueFull:
                self._fail_ws(stream_id, state, ErrorCode.LIMIT_EXCEEDED)
            state.changed.set()
            return
        if message_type == "ws.close":
            if state.terminal is None:
                state.terminal = message
                state.changed.set()
                if message.get("code", 1000) not in {1000, 1001}:
                    # Policy/error close must interrupt a stalled data consumer.
                    # Ordinary close keeps its ordered queue-drain semantics.
                    self._release_flow(stream_id, state)
                    if state.task is not None:
                        state.task.cancel()
                        self._ws_controls.add(state.task)
                        state.task.add_done_callback(self._ws_controls.discard)
            return
        raise ProtocolError("unexpected WebSocket stream frame")

    def _fail_ws(self, stream_id: str, state: _WSInbound, code: ErrorCode | str) -> None:
        if state.failed:
            return
        state.failed = True
        state.changed.set()
        self._release_flow(stream_id, state)
        if state.task is not None:
            state.task.cancel()
        async def cleanup() -> None:
            try:
                if state.task is not None:
                    await asyncio.gather(state.task, return_exceptions=True)
                async with asyncio.timeout(0.5):
                    await self._send_stream_error("ws.reject", stream_id, code, "WebSocket stream limit exceeded")
            except (TimeoutError, Exception):
                pass
        state.cleanup = self._spawn(cleanup())
        self._ws_controls.add(state.cleanup)
        state.cleanup.add_done_callback(self._ws_controls.discard)

    async def _forward_http(
        self,
        stream_id: str,
        state: _HTTPInbound,
        start: dict[str, Any],
    ) -> None:
        writers: list[asyncio.Task[Any]] = []
        writer_context = _HTTP_WRITERS.set(writers)
        try:
            method = validate_method(start["method"])
            target = validate_forward_target(start["target"])
            headers = self._upstream_request_headers(start["headers"])
            session = self._require_session()

            async def body_source() -> Any:
                while True:
                    if not state.queue.empty():
                        seq, data = state.queue.get_nowait()
                        yield data
                        self._delivered(stream_id, state, seq)
                        continue
                    if state.ended:
                        return
                    state.changed.clear()
                    await state.changed.wait()

            timeout = ClientTimeout(
                total=self.limits.http_timeout,
                connect=self.limits.upstream_connect_timeout,
            )
            async with session.request(
                method,
                self.upstream_url + target,
                headers=headers,
                data=body_source(),
                allow_redirects=False,
                timeout=timeout,
            ) as response:
                _reject_external_redirect(response, self.upstream_url)
                await self._send(
                    {
                        "type": "http.response.start",
                        "stream_id": stream_id,
                        "status": response.status,
                        "headers": filter_response_headers(response.raw_headers),
                    }
                )
                size = 0
                while True:
                    reservation = await state.sending.reserve(deadline=state.deadline)
                    try:
                        async with asyncio.timeout_at(state.deadline):
                            block = await response.content.read(self.limits.max_chunk_bytes)
                        if not block:
                            break
                        size += len(block)
                        if size > self.limits.max_response_body:
                            raise TunnelClientError(ErrorCode.LIMIT_EXCEEDED, "HTTP response body is too large")
                        async with asyncio.timeout_at(state.deadline):
                            await self._send(make_chunk(stream_id, block, seq=reservation.commit()))
                    finally:
                        reservation.release()
                await self._send({"type": "stream.end", "stream_id": stream_id, "last_seq": state.sending.sent_seq})
        except asyncio.CancelledError:
            raise
        except (asyncio.TimeoutError, TimeoutError) as exc:
            await self._send_stream_error("http.error", stream_id, ErrorCode.UPSTREAM_TIMEOUT, "upstream request timed out")
            self._failure = self._failure or None
        except TunnelClientError as exc:
            await self._send_stream_error("http.error", stream_id, exc.code, str(exc))
        except (ClientError, OSError, ValueError):
            await self._send_stream_error("http.error", stream_id, ErrorCode.UPSTREAM_REJECTED, "upstream request was rejected")
        except Exception:
            await self._send_stream_error("http.error", stream_id, ErrorCode.UPSTREAM_REJECTED, "upstream request failed")
        finally:
            _HTTP_WRITERS.reset(writer_context)
            # Own writers even when cancellation occurs before response headers.
            # aiohttp 3.9 otherwise drops failures produced while writing EOF.
            for writer in writers:
                if not writer.done():
                    writer.cancel()
            if writers:
                await asyncio.gather(*writers, return_exceptions=True)
            self._release_flow(stream_id, state)

    async def _forward_websocket(
        self,
        stream_id: str,
        state: _WSInbound,
        start: dict[str, Any],
    ) -> None:
        upstream: ClientWebSocketResponse | None = None
        accepted = False
        relay_tasks: set[asyncio.Task[None]] = set()
        try:
            target = validate_forward_target(start["target"])
            headers = dict(self._upstream_request_headers(start["headers"]))
            ws_url = _as_websocket_url(self.upstream_url + target)
            session = self._require_session()
            async with asyncio.timeout(self.limits.upstream_connect_timeout):
                upstream = await session.ws_connect(
                    ws_url,
                    headers=headers,
                    protocols=start.get("protocols", ()),
                    timeout=_websocket_timeout(
                        self.limits.upstream_connect_timeout
                    ),
                    autoclose=True,
                    autoping=True,
                    compress=0,
                    # aiohttp's threshold is exclusive; protocol validation is inclusive.
                    max_msg_size=self.limits.max_ws_message + 1,
                )
            selected_protocol = upstream.protocol
            requested_protocols = tuple(start.get("protocols", ()))
            if (
                selected_protocol is not None
                and selected_protocol not in requested_protocols
            ):
                raise TunnelClientError(
                    ErrorCode.UPSTREAM_REJECTED,
                    "upstream selected an unrequested WebSocket subprotocol",
                )
            await self._send(
                {
                    "type": "ws.accept",
                    "stream_id": stream_id,
                    "protocol": selected_protocol,
                    "headers": filter_response_headers(upstream._response.raw_headers),
                }
            )
            accepted = True
            gateway_to_upstream = asyncio.create_task(
                self._ws_gateway_to_upstream(state, upstream, stream_id=stream_id)
            )
            upstream_to_gateway = asyncio.create_task(
                self._ws_upstream_to_gateway(stream_id, upstream)
            )
            relay_tasks.update((gateway_to_upstream, upstream_to_gateway))
            done, _ = await asyncio.wait(
                relay_tasks,
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in done:
                task.result()
        except asyncio.CancelledError:
            raise
        except (asyncio.TimeoutError, TimeoutError):
            if not accepted:
                await self._send_stream_error("ws.reject", stream_id, ErrorCode.UPSTREAM_TIMEOUT, "upstream WebSocket timed out")
            else:
                await self._send_ws_close(stream_id, 1011, "upstream WebSocket timed out")
        except TunnelClientError as exc:
            if not accepted:
                await self._send_stream_error("ws.reject", stream_id, exc.code, str(exc))
            else:
                code = 1009 if exc.code == ErrorCode.LIMIT_EXCEEDED.value else 1011
                await self._send_ws_close(stream_id, code, "upstream WebSocket failed")
        except (ClientError, OSError, ValueError):
            if not accepted:
                await self._send_stream_error("ws.reject", stream_id, ErrorCode.UPSTREAM_REJECTED, "upstream WebSocket was rejected")
            else:
                await self._send_ws_close(stream_id, 1011, "upstream WebSocket disconnected")
        except Exception:
            if not accepted:
                await self._send_stream_error("ws.reject", stream_id, ErrorCode.UPSTREAM_REJECTED, "upstream WebSocket failed")
            else:
                await self._send_ws_close(stream_id, 1011, "upstream WebSocket failed")
        finally:
            try:
                for task in relay_tasks:
                    if not task.done():
                        task.cancel()
                if relay_tasks:
                    await asyncio.gather(*relay_tasks, return_exceptions=True)
                if upstream is not None and not upstream.closed:
                    with contextlib.suppress(Exception):
                        async with asyncio.timeout(0.5):
                            closing = state.terminal or {}
                            await upstream.close(
                                code=closing.get("code", 1013 if state.failed else 1000),
                                message=closing.get("reason", "").encode("utf-8"),
                            )
            finally:
                try:
                    if upstream is not None:
                        # aiohttp 3.9/3.12 close() can itself be cancelled while
                        # waiting for receive(). Always release its 101 response.
                        upstream._response.close()
                finally:
                    self._release_flow(stream_id, state)

    async def _ws_gateway_to_upstream(
        self, state: _WSInbound, upstream: ClientWebSocketResponse, *, stream_id: str | None = None
    ) -> None:
        while True:
            if not state.queue.empty():
                message = state.queue.get_nowait()
            elif state.terminal is not None:
                message = state.terminal
            else:
                state.changed.clear()
                await state.changed.wait()
                continue
            if message["type"] == "ws.close":
                await upstream.close(
                    code=message.get("code", 1000),
                    message=message.get("reason", "").encode("utf-8"),
                )
                return
            kind = message["kind"]
            if kind == "text":
                await upstream.send_str(message["text"])
            elif kind == "binary":
                await upstream.send_bytes(decode_chunk(message))
            elif kind == "ping":
                await upstream.ping(decode_chunk(message))
            elif kind == "pong":
                await upstream.pong(decode_chunk(message))
            if stream_id is not None:
                self._delivered(stream_id, state, message["seq"])

    async def _ws_upstream_to_gateway(
        self, stream_id: str, upstream: ClientWebSocketResponse
    ) -> None:
        state = self._streams[stream_id]
        while True:
            # No idle timeout: a full window is bounded and stop/transport
            # cleanup cancels this wait. Never pre-read an extra message.
            reservation = await state.sending.reserve(deadline=None)
            try:
                message = await upstream.receive()
                if message.type in {WSMsgType.TEXT, WSMsgType.BINARY}:
                    if message.type == WSMsgType.TEXT:
                        if len(message.data.encode("utf-8")) > self.limits.max_ws_message:
                            raise TunnelClientError(ErrorCode.LIMIT_EXCEEDED, "WebSocket message is too large")
                        frame = {"type": "ws.message", "stream_id": stream_id, "kind": "text", "text": message.data, "seq": reservation.commit()}
                    else:
                        if len(message.data) > self.limits.max_ws_message:
                            raise TunnelClientError(ErrorCode.LIMIT_EXCEEDED, "WebSocket message is too large")
                        frame = make_ws_data(stream_id, "binary", message.data, seq=reservation.commit())
                    async with asyncio.timeout(self.limits.http_timeout):
                        await self._send(frame)
                    continue
            finally:
                reservation.release()
            if message.type == WSMsgType.CLOSE:
                code = int(message.data or upstream.close_code or 1000)
                if code == 1006:
                    raise TunnelClientError(
                        ErrorCode.DEVICE_OFFLINE,
                        "upstream WebSocket transport disconnected",
                    )
                await self._send_ws_close(stream_id, code, str(message.extra or ""))
                return
            elif message.type == WSMsgType.ERROR:
                raise upstream.exception() or TunnelClientError(ErrorCode.UPSTREAM_REJECTED, "upstream WebSocket failed")
            elif message.type in {WSMsgType.CLOSING, WSMsgType.CLOSED}:
                code = upstream.close_code
                if code is not None and code != 1006:
                    await self._send_ws_close(stream_id, int(code), "")
                    return
                raise TunnelClientError(
                    ErrorCode.DEVICE_OFFLINE,
                    "upstream WebSocket transport disconnected",
                )

    async def _send_ws_close(self, stream_id: str, code: int, reason: str) -> None:
        with contextlib.suppress(Exception):
            await self._send(
                {
                    "type": "ws.close",
                    "stream_id": stream_id,
                    "code": code,
                    "reason": _truncate_close_reason(reason),
                }
            )

    async def _send_stream_error(
        self,
        message_type: str,
        stream_id: str,
        code: ErrorCode | str,
        message: str,
    ) -> None:
        stable = code.value if isinstance(code, ErrorCode) else code
        with contextlib.suppress(Exception):
            await self._send(
                {"type": message_type, "stream_id": stream_id, "code": stable, "message": message[:256]}
            )

    async def _send(self, message: dict[str, Any]) -> None:
        socket = self._socket
        if socket is None or socket.closed:
            raise TunnelClientError(ErrorCode.DEVICE_OFFLINE, "gateway tunnel is closed")
        payload = encode_message(message)
        async with self._send_lock:
            await socket.send_str(payload)

    def _spawn(self, coroutine: Any) -> asyncio.Task[None]:
        task = asyncio.create_task(coroutine)
        self._stream_tasks.add(task)
        task.add_done_callback(self._stream_tasks.discard)
        return task

    def _register_flow(self, stream_id: str) -> None:
        if self._credit_pump is None:
            raise ProtocolError("credit pump is not ready")
        self._credit_pump.register(stream_id)

    def _delivered(self, stream_id: str, state: _HTTPInbound | _WSInbound, seq: int) -> None:
        if self._streams.get(stream_id) is state and self._credit_pump is not None:
            self._credit_pump.mark(stream_id, state.receiving.delivered(seq))

    def _release_flow(self, stream_id: str, state: _HTTPInbound | _WSInbound) -> None:
        state.sending.close()
        state.receiving.close()
        state.changed.set()
        if self._streams.get(stream_id) is state:
            self._streams.pop(stream_id, None)
            if self._credit_pump is not None:
                self._credit_pump.discard(stream_id)

    async def _run_credit_pump(self, pump: CreditPump) -> None:
        try:
            await pump.run()
        except asyncio.CancelledError:
            raise
        except Exception:
            self._failure = TunnelClientError(ErrorCode.DEVICE_OFFLINE, "credit transport failed")
            if self._reader_task is not None:
                self._reader_task.cancel()
            await self._cancel_streams()
            await self._close_transport()
            self._stopped.set()

    def _spawn_rejection(self, kind: str, stream_id: str, controls: set[asyncio.Task[None]], maximum: int) -> None:
        if len(controls) >= maximum:
            raise ProtocolError("control admission exceeded")
        async def notify() -> None:
            with contextlib.suppress(Exception):
                async with asyncio.timeout(0.5):
                    await self._send_stream_error(kind, stream_id, ErrorCode.LIMIT_EXCEEDED, "stream admission exceeded")
        task = self._spawn(notify())
        controls.add(task)
        task.add_done_callback(controls.discard)

    def _fail_http(self, stream_id: str, state: _HTTPInbound, code: ErrorCode | str) -> None:
        self._release_flow(stream_id, state)
        if state.task is not None:
            state.task.cancel()
        async def cleanup() -> None:
            if state.task is not None:
                await asyncio.gather(state.task, return_exceptions=True)
            with contextlib.suppress(Exception):
                async with asyncio.timeout(0.5):
                    await self._send_stream_error("http.error", stream_id, code, "HTTP stream rejected")
        task = self._spawn(cleanup())
        self._http_controls.add(task)
        task.add_done_callback(self._http_controls.discard)

    async def _cancel_streams(self) -> None:
        for stream_id, state in tuple(self._streams.items()):
            self._release_flow(stream_id, state)
        tasks = tuple(self._stream_tasks)
        self._stream_tasks.clear()
        self._streams.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _close_transport(self) -> None:
        pump, self._credit_pump = self._credit_pump, None
        credit_task, self._credit_task = self._credit_task, None
        if pump is not None:
            await pump.close()
        if credit_task is not None and credit_task is not asyncio.current_task():
            credit_task.cancel()
            await asyncio.gather(credit_task, return_exceptions=True)
        self._ready.clear()
        self.connection_id = None
        socket = self._socket
        self._socket = None
        if socket is not None and not socket.closed:
            with contextlib.suppress(Exception):
                await socket.close()
        session = self._session
        self._session = None
        if session is not None and not session.closed:
            with contextlib.suppress(Exception):
                await session.close()

    def _require_session(self) -> ClientSession:
        if self._session is None or self._session.closed:
            raise TunnelClientError(ErrorCode.DEVICE_OFFLINE, "tunnel client is stopped")
        return self._session

    def _upstream_request_headers(
        self, headers: Iterable[Iterable[str]]
    ) -> list[tuple[str, str]]:
        """Build the local-H5 boundary headers for both HTTP and WebSocket.

        Browser-controlled credentials and browser-origin metadata are removed
        first.  Only then may the locally configured forwarder identity be
        added, so a remote browser cannot forge or override it.
        """

        result = filter_request_headers(headers)
        if self._forwarder_token is not None:
            result.append(
                (_FORWARDER_HEADER, f"Bearer {self._forwarder_token}")
            )
        return result


def validate_upstream_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("upstream_url must be an HTTP(S) loopback origin")
    try:
        address = ipaddress.ip_address(parsed.hostname)
    except ValueError as exc:
        raise ValueError("upstream_url host must be a literal loopback address") from exc
    if not address.is_loopback:
        raise ValueError("upstream_url host must be loopback")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("upstream_url must not contain credentials")
    if parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise ValueError("upstream_url must be an origin without path, query, or fragment")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("invalid upstream port") from exc
    host = f"[{address.compressed}]" if address.version == 6 else address.compressed
    authority = host if port is None else f"{host}:{port}"
    return urlunsplit((parsed.scheme, authority, "", "", ""))


def validate_method(method: str) -> str:
    if not isinstance(method, str) or not _TOKEN_RE.fullmatch(method):
        raise TunnelClientError(ErrorCode.UPSTREAM_REJECTED, "invalid HTTP method")
    normalized = method.upper()
    if normalized == "CONNECT":
        raise TunnelClientError(ErrorCode.UPSTREAM_REJECTED, "CONNECT is forbidden")
    return normalized


def validate_forward_target(target: str) -> str:
    if not isinstance(target, str) or not target.startswith("/") or target.startswith("//"):
        raise TunnelClientError(ErrorCode.UPSTREAM_REJECTED, "absolute or invalid request target")
    if "\\" in target or "\r" in target or "\n" in target or "\x00" in target:
        raise TunnelClientError(ErrorCode.UPSTREAM_REJECTED, "invalid request target")
    parsed = urlsplit(target)
    if parsed.scheme or parsed.netloc or parsed.fragment:
        raise TunnelClientError(ErrorCode.UPSTREAM_REJECTED, "absolute or invalid request target")
    decoded = parsed.path
    for _ in range(3):
        replacement = unquote(decoded)
        if replacement == decoded:
            break
        decoded = replacement
    normalized = posixpath.normpath(decoded)
    if not normalized.startswith("/"):
        normalized = "/" + normalized
    lowered = normalized.lower()
    if any(lowered == prefix or lowered.startswith(prefix + "/") for prefix in _BLOCKED_PATHS):
        raise TunnelClientError(ErrorCode.UPSTREAM_REJECTED, "gateway-reserved path is forbidden")
    return target


def filter_request_headers(headers: Iterable[Iterable[str]]) -> list[tuple[str, str]]:
    pairs = [(name, value) for name, value in headers]
    connection_tokens: set[str] = set()
    for name, value in pairs:
        if name.lower() == "connection":
            connection_tokens.update(token.strip().lower() for token in value.split(","))
    result: list[tuple[str, str]] = []
    for name, value in pairs:
        lowered = name.lower()
        if (
            lowered in _ALWAYS_DROPPED_HEADERS
            or lowered in connection_tokens
            or lowered.startswith("x-forwarded-")
            or lowered.startswith("proxy-")
            or lowered.startswith("sec-fetch-")
            or lowered.startswith("sec-websocket-")
        ):
            continue
        result.append((name, value))
    return result


def _validate_forwarder_token(value: str | None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("forwarder_token must be a string or None")
    if not value or len(value) > 512 or any(
        ord(character) < 0x21 or ord(character) > 0x7E for character in value
    ):
        # Deliberately do not include the submitted credential in this error.
        raise ValueError("forwarder_token must contain 1-512 visible ASCII characters")
    return value


def filter_response_headers(raw_headers: Iterable[tuple[bytes, bytes]]) -> list[list[str]]:
    result: list[list[str]] = []
    for raw_name, raw_value in raw_headers:
        name = raw_name.decode("latin-1")
        lowered = name.lower()
        if lowered in _ALWAYS_DROPPED_HEADERS or lowered.startswith("proxy-") or lowered.startswith("sec-websocket-"):
            continue
        result.append([name, raw_value.decode("latin-1")])
    return result


def _reject_external_redirect(response: ClientResponse, upstream_url: str) -> None:
    if response.status < 300 or response.status >= 400:
        return
    location = response.headers.get("Location")
    if not location:
        return
    parsed = urlsplit(location)
    if not parsed.scheme and not parsed.netloc:
        return
    try:
        redirected = validate_upstream_url(urlunsplit((parsed.scheme, parsed.netloc, "", "", "")))
    except ValueError as exc:
        raise TunnelClientError(ErrorCode.UPSTREAM_REJECTED, "non-loopback redirect is forbidden") from exc
    if redirected != upstream_url:
        raise TunnelClientError(ErrorCode.UPSTREAM_REJECTED, "redirect to another origin is forbidden")


def _validate_gateway_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("gateway_url must be an HTTP(S) origin")
    if parsed.query or parsed.fragment:
        raise ValueError("gateway_url must not contain query or fragment")
    return value.rstrip("/")


def _tunnel_endpoint(gateway_url: str) -> str:
    parsed = urlsplit(gateway_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    path = parsed.path.rstrip("/") + "/_gateway/v1/tunnels/connect"
    return urlunsplit((scheme, parsed.netloc, path, "", ""))


def _as_websocket_url(value: str) -> str:
    parsed = urlsplit(value)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    return urlunsplit((scheme, parsed.netloc, parsed.path, parsed.query, ""))


def _decode_socket_message(raw: Any) -> dict[str, Any]:
    if raw.type != WSMsgType.TEXT:
        raise TunnelClientError(ErrorCode.PROTOCOL_ERROR, "tunnel transport accepts text frames only")
    return decode_message(raw.data)


def _negotiated_limits(
    value: dict[str, Any],
    *,
    local_limits: ProtocolLimits | None = None,
) -> ProtocolLimits:
    try:
        return validate_protocol_limits(value, local_limits=local_limits)
    except ProtocolError as exc:
        raise TunnelClientError(ErrorCode.PROTOCOL_ERROR, "invalid negotiated limits") from exc


def _websocket_timeout(seconds: float) -> Any:
    """Return the native timeout shape for aiohttp 3.9 through 3.12+."""

    if ClientWSTimeout is None:
        return seconds
    return ClientWSTimeout(ws_receive=None, ws_close=seconds)


def _truncate_close_reason(reason: str) -> str:
    encoded = reason.encode("utf-8")
    if len(encoded) <= 123:
        return reason
    return encoded[:123].decode("utf-8", errors="ignore")


def _retrieve_writer_result(task: asyncio.Task[Any]) -> None:
    if not task.cancelled():
        task.exception()
