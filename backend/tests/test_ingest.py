"""Test phan trang ccxt ma khong goi mang that."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from marketlab_web import ingest

HOUR = 3_600_000
T0 = 1_704_067_200_000


def make_candles(count: int, start: int = T0) -> list[list]:
    return [
        [start + i * HOUR, 100.0 + i, 101.0 + i, 99.0 + i, 100.5 + i, 10.0 + i]
        for i in range(count)
    ]


class FakeExchange:
    """Gia lap ccxt: chi tra cac nen co ts >= since, gioi han `limit`."""

    def __init__(self, candles: list[list]):
        self.candles = candles
        self.since_calls: list[int] = []

    def milliseconds(self) -> int:
        return self.candles[-1][0] + HOUR

    async def fetch_ohlcv(self, symbol, timeframe, since=None, limit=1000):
        self.since_calls.append(since)
        return [c for c in self.candles if c[0] >= since][:limit]


@pytest.mark.asyncio
async def test_fetch_history_paginates_without_gaps_or_duplicates():
    exchange = FakeExchange(make_candles(2500))
    got = await ingest.fetch_history(exchange, "BTC/USDT", "1h", T0)
    assert len(got) == 2500
    assert [c[0] for c in got] == [T0 + i * HOUR for i in range(2500)]
    assert len(exchange.since_calls) == 3  # 1000 + 1000 + 500


@pytest.mark.asyncio
async def test_fetch_history_survives_single_candle_page():
    exchange = FakeExchange(make_candles(3))
    got = await ingest.fetch_history(exchange, "BTC/USDT", "1h", T0, page=1)
    assert len(got) == 3


@pytest.mark.asyncio
async def test_fetch_history_drops_overlapping_pages():
    class Overlap(FakeExchange):
        async def fetch_ohlcv(self, symbol, timeframe, since=None, limit=1000):
            self.since_calls.append(since)
            return [c for c in self.candles if c[0] >= since][:limit] + self.candles[:1]

    got = await ingest.fetch_history(Overlap(make_candles(5)), "BTC/USDT", "1h", T0)
    assert len(got) == 5


@pytest.mark.asyncio
async def test_fetch_history_rejects_unknown_timeframe():
    with pytest.raises(ValueError):
        await ingest.fetch_history(FakeExchange([]), "BTC/USDT", "7m", T0)


@pytest.mark.asyncio
async def test_fetch_history_drops_candle_that_has_not_closed():
    """until nam giua nến cuoi -> san van tra ve no, nhung khong duoc luu."""
    exchange = FakeExchange(make_candles(5))
    exchange.milliseconds = lambda: exchange.candles[-1][0] + 1_000  # 1s sau khi mo nen thu 5
    got = await ingest.fetch_history(exchange, "BTC/USDT", "1h", T0)
    assert [c[0] for c in got] == [T0 + i * HOUR for i in range(4)]


@pytest.mark.asyncio
async def test_fetch_history_keeps_last_candle_once_it_closes():
    exchange = FakeExchange(make_candles(5))
    exchange.milliseconds = lambda: exchange.candles[-1][0] + HOUR  # dung luc no dong
    got = await ingest.fetch_history(exchange, "BTC/USDT", "1h", T0)
    assert len(got) == 5


def test_to_rows_converts_milliseconds_to_utc_and_keeps_ohlcv():
    rows = ingest.to_rows([[T0, 1.0, 2.0, 0.5, 1.5, 10.0]])
    ts, open_, high, low, close, volume = rows[0]
    assert ts == datetime(2024, 1, 1, 0, 0, tzinfo=timezone.utc)
    assert (open_, high, low, close, volume) == (1.0, 2.0, 0.5, 1.5, 10.0)


def test_to_rows_ignores_extra_fields_ccxt_may_append():
    """fetch_ohlcv chuan hoa chi 6 cot; san pham phu khong duoc lech sang dong khac."""
    rows = ingest.to_rows([[T0, 1.0, 2.0, 0.5, 1.5, 10.0, 999.0, 1234.0]])
    assert rows[0] == (datetime(2024, 1, 1, 0, 0, tzinfo=timezone.utc), 1.0, 2.0, 0.5, 1.5, 10.0)
