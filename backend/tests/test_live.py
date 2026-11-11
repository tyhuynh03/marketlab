"""Đường realtime: parse kline, ranh giới đóng nến, và hub chỉ ghi nến ĐÃ ĐÔNG."""
from __future__ import annotations

import asyncio

import pytest

from marketlab_web import live


def kline(**over):
    base = {"t": 1_762_840_800_000, "o": "75000.1", "h": "75200", "l": "74900",
            "c": "75100.5", "v": "12.5", "x": False}
    base.update(over)
    return base


def test_stream_name_matches_binance_format():
    assert live.stream_name("BTC/USDT", "1h") == "btcusdt@kline_1h"
    assert live.stream_name("1000PEPE/USDT", "4h") == "1000pepeusdt@kline_4h"


def test_kline_to_bar_shape_matches_candles_api():
    bar = live.kline_to_bar(kline(), "BTC/USDT", "1h")
    assert bar is not None
    assert bar["symbol"] == "BTC/USDT"
    assert bar["timeframe"] == "1h"
    assert bar["ts"] == "2025-11-11T06:00:00+00:00"
    assert bar["open"] == 75000.1 and bar["close"] == 75100.5
    assert bar["volume"] == 12.5
    assert bar["closed"] is False


def test_kline_to_bar_rejects_incomplete_payload():
    assert live.kline_to_bar({}, "BTC/USDT", "1h") is None
    assert live.kline_to_bar(kline(c="không phải số"), "BTC/USDT", "1h") is None
    assert live.kline_to_bar(kline(t=None), "BTC/USDT", "1h") is None


@pytest.mark.parametrize("open_ms,expected", [
    (1_762_840_800_000, False),  # 06:00 -> đóng 07:00, không trùng mép bucket
    (1_762_837_200_000, False),  # 05:00 -> đóng 06:00
    (1_762_844_400_000, True),   # 07:00 -> đóng 08:00, mép 4h
    (1_762_815_600_000, True),   # 23:00 -> đóng 00:00, mép 1d
])
def test_closes_rollup_only_on_bucket_edges(open_ms, expected):
    assert live.closes_rollup(open_ms, 3_600_000) is expected


def test_closes_rollup_true_at_midnight_and_four_hour_marks():
    midnight = 1_762_819_200_000  # 2025-11-11 00:00 UTC
    assert live.closes_rollup(midnight - 3_600_000, 3_600_000) is True
    assert live.closes_rollup(midnight + 3 * 3_600_000, 3_600_000) is True
    assert live.closes_rollup(midnight + 3_600_000, 3_600_000) is False


class FakePool:
    def __init__(self):
        self.upserts = []
        self.refreshes = 0


@pytest.fixture
def hub(monkeypatch):
    pool = FakePool()

    async def upsert(_pool, venue, symbol, timeframe, rows):
        pool.upserts.append((venue, symbol, timeframe, list(rows)))
        return len(pool.upserts[-1][3])

    async def refresh(_pool):
        pool.refreshes += 1

    monkeypatch.setattr(live.db, "upsert_candles", upsert)
    monkeypatch.setattr(live.db, "refresh_rollups", refresh)
    return live.LiveHub(pool, "binance", "1h"), pool


@pytest.mark.asyncio
async def test_forming_bar_never_touches_warehouse(hub):
    h, pool = hub
    await h._persist(live.kline_to_bar(kline(x=False), "BTC/USDT", "1h"))
    assert pool.upserts == []
    assert pool.refreshes == 0


@pytest.mark.asyncio
async def test_closed_base_bar_is_upserted_once(hub):
    h, pool = hub
    bar = live.kline_to_bar(kline(x=True), "BTC/USDT", "1h")
    await h._persist(bar)
    assert len(pool.upserts) == 1
    venue, symbol, timeframe, rows = pool.upserts[0]
    assert (venue, symbol, timeframe) == ("binance", "BTC/USDT", "1h")
    assert rows[0][1:] == (75000.1, 75200.0, 74900.0, 75100.5, 12.5)


@pytest.mark.asyncio
async def test_closed_rollup_bar_is_not_written_as_base_candle(hub):
    h, pool = hub
    await h._persist(live.kline_to_bar(kline(x=True), "BTC/USDT", "4h"))
    assert pool.upserts == []


@pytest.mark.asyncio
async def test_subscribers_get_bars_and_slow_client_does_not_block(hub):
    h, _ = hub
    fast = h.subscribe()
    slow = h.subscribe()
    for _ in range(300):
        h._publish({"type": "bar", "close": 1.0})
    assert fast.qsize() == 256
    assert slow.qsize() == 256
    h.unsubscribe(slow)
    h._publish({"type": "bar", "close": 2.0})
    assert slow.qsize() == 256
    assert fast.get_nowait()["close"] == 1.0


@pytest.mark.asyncio
async def test_state_change_is_broadcast_once(hub):
    h, _ = hub
    queue = h.subscribe()
    h._set_state("on")
    h._set_state("on")
    assert queue.qsize() == 1
    assert queue.get_nowait() == {"type": "state", "state": "on"}


@pytest.mark.asyncio
async def test_stop_cancels_run_loop(hub):
    h, _ = hub

    async def idle():
        await asyncio.sleep(3600)

    h._task = asyncio.create_task(idle())
    await h.stop()
    assert h._task is None