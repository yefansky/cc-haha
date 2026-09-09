"""Local WS seam fixtures only: no encryption, pairing or authentication claim.

Channel tests are stdlib-only. Dispatch tests additionally use the already
installed aiohttp runtime, never install dependencies or contact real services.
"""
from __future__ import annotations

import asyncio
from dataclasses import replace
import importlib
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import AsyncMock

ROOT = Path(__file__).resolve().parents[1]
STREAM = "fixture-stream-0001"
PACKAGE = "_local_ws_fixture_tunnel"
package = types.ModuleType(PACKAGE)
package.__path__ = [str(ROOT / "src/cc_haha_tunnel")]
sys.modules[PACKAGE] = package
local = importlib.import_module(PACKAGE + ".local_ws_channel")
flow = importlib.import_module(PACKAGE + ".flow_control")
protocol = importlib.import_module(PACKAGE + ".protocol")


def state_fixture():
    return types.SimpleNamespace(queue=asyncio.Queue(maxsize=4), sending=flow.SendWindow(),
                                 receiving=flow.ReceiveWindow(), changed=asyncio.Event(),
                                 terminal=None, failed=False)


class ChannelTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.state = state_fixture()
        self.frames = []

        async def send(frame):
            self.frames.append(frame)

        self.channel = local.LocalWSChannel(stream_id=STREAM, state=self.state, send_frame=send,
            delivered=lambda seq: self.state.receiving.delivered(seq), max_message=32, send_timeout=1)

    async def asyncTearDown(self):
        await self.channel.close()

    async def test_receive_binary_returns_credit_in_order(self):
        for seq in range(1, 5):
            self.state.receiving.accept(seq)
            self.state.queue.put_nowait(protocol.make_ws_data(STREAM, "binary", bytes([seq]), seq=seq))
        for seq in range(1, 5):
            self.assertEqual(await self.channel.receive(), bytes([seq]))
            self.assertEqual(self.state.receiving.local_consumed, seq)
        self.assertTrue(self.state.queue.empty())

    async def test_send_fifth_record_waits_for_credit_and_preserves_bytes(self):
        for seq in range(1, 5):
            await self.channel.send(bytes([seq]))
        fifth = asyncio.create_task(self.channel.send(b"\x00\xff"))
        try:
            await asyncio.sleep(0)
            self.assertFalse(fifth.done())
            self.assertEqual(len(self.frames), 4)
            self.state.sending.apply_credit(1)
            await asyncio.wait_for(fifth, 1)
            self.assertEqual([frame["seq"] for frame in self.frames], [1, 2, 3, 4, 5])
            self.assertEqual(protocol.decode_chunk(self.frames[-1]), b"\x00\xff")
        finally:
            fifth.cancel()
            await asyncio.gather(fifth, return_exceptions=True)

    async def test_invalid_type_and_size_fail_without_sending(self):
        for payload in ("text", b"x" * 33):
            with self.assertRaises(local.LocalChannelProtocolError):
                await self.channel.send(payload)
        self.assertEqual(self.frames, [])
        self.state.receiving.accept(1)
        self.state.queue.put_nowait({"kind": "text", "text": "fixture", "seq": 1})
        with self.assertRaises(local.LocalChannelProtocolError):
            await self.channel.receive()
        self.assertEqual(self.state.receiving.local_consumed, 0)

    async def test_no_credit_deadline_aborts_run_without_remaining_tasks(self):
        self.channel._send_timeout = 0.03
        cleaned = asyncio.Event()

        async def handler(channel):
            try:
                for _ in range(5):
                    await channel.send(b"fixture")
            finally:
                cleaned.set()

        before = asyncio.all_tasks()
        with self.assertRaises(TimeoutError):
            await asyncio.wait_for(self.channel.run(handler), 1)
        self.assertTrue(cleaned.is_set())
        self.assertTrue(self.channel.closed)
        self.assertEqual(len(self.frames), 4)
        self.assertEqual(self.state.sending.reserved, 0)
        self.assertFalse(asyncio.all_tasks() - before)

    async def test_peer_close_is_abort_not_delivery_of_queued_records(self):
        self.state.receiving.accept(1)
        self.state.queue.put_nowait(protocol.make_ws_data(STREAM, "binary", b"undelivered", seq=1))
        self.state.terminal = {"type": "ws.close", "code": 1000}
        self.assertIsNone(await self.channel.receive())
        self.assertEqual(self.state.receiving.local_consumed, 0)
        await self.channel.close()
        self.assertTrue(self.state.queue.empty())

    async def test_peer_close_cancels_stalled_handler_and_releases_waiters(self):
        entered, stopped = asyncio.Event(), asyncio.Event()

        async def handler(channel):
            try:
                entered.set()
                await asyncio.Future()
            finally:
                stopped.set()

        run = asyncio.create_task(self.channel.run(handler))
        try:
            await asyncio.wait_for(entered.wait(), 1)
            self.state.terminal = {"type": "ws.close", "code": 1000}
            self.state.changed.set()
            await asyncio.wait_for(run, 1)
            self.assertTrue(stopped.is_set())
            self.assertTrue(self.channel.closed)
            self.assertIsNone(await self.channel.receive())
            with self.assertRaises(local.LocalChannelClosed):
                await self.channel.send(b"later")
        finally:
            run.cancel()
            await asyncio.gather(run, return_exceptions=True)

    async def test_handler_context_is_scoped_and_failure_closes(self):
        async def handler(channel):
            self.assertTrue(local.local_handler_active())
            raise RuntimeError("fixture-only")

        with self.assertRaises(RuntimeError):
            await self.channel.run(handler)
        self.assertFalse(local.local_handler_active())
        self.assertTrue(self.channel.closed)


class DispatchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        try:
            self.module = importlib.import_module(PACKAGE + ".client")
        except ModuleNotFoundError as error:
            if error.name == "aiohttp":
                self.skipTest("dispatch tests require installed locked aiohttp runtime")
            raise
        self.client = self.module.TunnelClient(gateway_url="http://127.0.0.1:1",
            access_key="fixture-only", upstream_url="http://127.0.0.1:2")
        self.frames = []

        async def send(frame):
            self.frames.append(frame)

        self.client._send = send
        self.client._credit_pump = flow.CreditPump(send)
        self.client._session = types.SimpleNamespace(closed=False, ws_connect=AsyncMock(side_effect=AssertionError("must not contact upstream")),
                                                     request=AsyncMock(side_effect=AssertionError("must not contact upstream")))

    async def asyncTearDown(self):
        if hasattr(self, "client"):
            await self.client._cancel_streams()
            await self.client._credit_pump.close()

    async def open(self, target="/_privacy/channel", stream=STREAM):
        await self.client._dispatch({"type": "ws.open", "stream_id": stream,
                                    "target": target, "headers": [], "protocols": []})
        state = self.client._streams[stream]
        return state

    async def test_default_handler_rejects_without_upstream(self):
        state = await self.open()
        await asyncio.wait_for(state.task, 1)
        self.assertEqual([f["type"] for f in self.frames], ["ws.reject"])
        self.assertNotIn(STREAM, self.client._streams)
        self.client._session.ws_connect.assert_not_called()

    async def test_http_cannot_forward_reserved_local_endpoint(self):
        await self.client._dispatch({"type": "http.request.start", "stream_id": STREAM,
            "method": "GET", "target": "/_privacy/channel", "headers": []})
        state = self.client._streams[STREAM]
        await asyncio.wait_for(state.task, 1)
        self.assertEqual(self.frames[-1]["type"], "http.error")
        self.assertNotIn(STREAM, self.client._streams)
        self.client._session.request.assert_not_called()

    async def test_no_credit_timeout_closes_stream_and_cleans_handler(self):
        self.client.limits = replace(self.client.limits, http_timeout=0.03)
        cleaned = asyncio.Event()

        async def handler(channel):
            try:
                for _ in range(5):
                    await channel.send(b"fixture")
            finally:
                cleaned.set()

        self.client._local_ws_handler = handler
        before = asyncio.all_tasks()
        state = await self.open()
        await asyncio.wait_for(state.task, 1)
        await asyncio.sleep(0)
        self.assertTrue(cleaned.is_set())
        self.assertEqual(sum(frame["type"] == "ws.message" for frame in self.frames), 4)
        self.assertEqual(self.frames[-1]["type"], "ws.close")
        self.assertEqual(self.frames[-1]["reason"], "local channel failed")
        self.assertNotIn(STREAM, self.client._streams)
        self.assertFalse(asyncio.all_tasks() - before)

    async def test_variants_query_and_inner_target_reject_even_when_registered(self):
        handler = AsyncMock()
        self.client._local_ws_handler = handler
        variants = ["/_privacy", "/_privacy/channel/", "/_privacy/channel?x=1", "/_privacy/channel?",
                    "/_PRIVACY/channel", "/%5fprivacy/channel", "/_privacy%252fchannel",
                    "/x/../_privacy/channel", "/_privacy/../ws/ordinary", "/_privacy/other"]
        for index, target in enumerate(variants):
            with self.subTest(target=target):
                state = await self.open(target, str(index))
                await asyncio.wait_for(state.task, 1)
                self.assertEqual(self.frames[-1]["type"], "ws.reject")
        for target in ["/_privacy/channel", *variants]:
            with self.subTest(inner=target), self.assertRaises(self.module.TunnelClientError):
                self.module.validate_forward_target(target)
        handler.assert_not_called()
        self.client._session.ws_connect.assert_not_called()

    async def test_accept_before_fixture_handler_and_binary_echo_with_credit(self):
        entered = asyncio.Event()

        async def handler(channel):
            self.assertEqual(self.frames[0]["type"], "ws.accept")
            entered.set()
            await channel.send(await channel.receive())

        self.client._local_ws_handler = handler
        state = await self.open()
        await asyncio.wait_for(entered.wait(), 1)
        await self.client._dispatch(protocol.make_ws_data(STREAM, "binary", b"\x00fixture\xff", seq=1))
        await asyncio.wait_for(state.task, 1)
        self.assertEqual([f["type"] for f in self.frames], ["ws.accept", "ws.message", "ws.close"])
        self.assertEqual(protocol.decode_chunk(self.frames[1]), b"\x00fixture\xff")
        self.assertEqual(state.receiving.local_consumed, 1)
        self.assertNotIn(STREAM, self.client._streams)
        self.client._session.ws_connect.assert_not_called()

    async def test_recursive_open_is_rejected(self):
        async def handler(channel):
            nested = await self.open(stream="nested")
            await nested.task

        self.client._local_ws_handler = handler
        state = await self.open()
        await asyncio.wait_for(state.task, 1)
        nested = [frame for frame in self.frames if frame["stream_id"] == "nested"]
        self.assertEqual([frame["type"] for frame in nested], ["ws.reject"])
        self.client._session.ws_connect.assert_not_called()

    async def test_close_cancel_and_transport_shutdown_cleanup_handler(self):
        for action in ("normal_close", "policy_close", "cancel", "transport"):
            with self.subTest(action=action):
                entered, cleaned = asyncio.Event(), asyncio.Event()

                async def handler(channel):
                    try:
                        entered.set()
                        await asyncio.Future()
                    finally:
                        cleaned.set()

                self.client._local_ws_handler = handler
                state = await self.open(stream=action)
                await asyncio.wait_for(entered.wait(), 1)
                if action == "transport":
                    await self.client._cancel_streams()
                elif action == "cancel":
                    await self.client._dispatch({"type": "cancel", "stream_id": action})
                else:
                    await self.client._dispatch({"type": "ws.close", "stream_id": action,
                                                 "code": 1000 if action == "normal_close" else 1008})
                await asyncio.wait_for(asyncio.gather(state.task, return_exceptions=True), 1)
                self.assertTrue(cleaned.is_set())
                self.assertNotIn(action, self.client._streams)
                self.assertEqual(state.sending.reserved, 0)

    async def test_fixture_exception_is_not_exposed_in_close_reason(self):
        async def handler(channel):
            raise ValueError("fixture-private-business-content")

        self.client._local_ws_handler = handler
        state = await self.open()
        await asyncio.wait_for(state.task, 1)
        self.assertEqual(self.frames[-1]["type"], "ws.close")
        self.assertEqual(self.frames[-1]["code"], 1011)
        self.assertNotIn("fixture-private-business-content", str(self.frames))

    async def test_ordinary_target_still_uses_original_upstream_branch(self):
        state = await self.open("/ws/ordinary")
        await asyncio.wait_for(state.task, 1)
        self.client._session.ws_connect.assert_called_once()


if __name__ == "__main__":
    unittest.main()
