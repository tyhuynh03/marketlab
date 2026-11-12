"""Adapter Yahoo: loc phien New York, bo nen dang chay, va poller day vao hub.

Tat ca dung payload gia — khong cham mang that.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from marketlab_web import api, db, ingest, live, metrics, yahoo

HOUR = 3_600_000
DAY_MS = 86_400_000
# 2025-11-11 00:00 UTC, thu Ba. New York dang EST (UTC-5) nen phien chinh
# 09:30–16:00 ET = 14:30–21:00 UTC, va nen 1h cua Yahoo moc o :30.
DAY = 1_762_819_200_000
OPEN = DAY + 14 * HOUR + 1_800_000
NOW = OPEN + 6 * HOUR + 60_000  # 20:31 UTC — nen 20:30 van dang chay


def session_bars(count: int = 7, start: int = OPEN) -> list[list]:
    return [[start + i * HOUR, 100.0 + i, 105.0 + i, 95.0 + i, 102.0 + i, 1_000.0 + i]
            for i in range(count)]


def result_of(bars: list[list]) -> dict:
    return {
        "meta": {"symbol": "AAPL", "currency": "USD", "exchangeName": "NMS"},
        "timestamp": [int(b[0] // 1000) for b in bars],
        "indicators": {"quote": [{
            "open": [b[1] for b in bars],
            "high": [b[2] for b in bars],
            "low": [b[3] for b in bars],
            "close": [b[4] for b in bars],
            "volume": [b[5] for b in bars],
        }]},
    }


def payload_of(bars: list[list]) -> dict:
    return {"chart": {"result": [result_of(bars)], "error": None}}


@pytest.mark.parametrize("ts_ms,expected", [
    (OPEN, True),                       # 09:30 ET — dung luc mo phien
    (OPEN - 60_000, False),             # 09:29 ET — truoc phien
    (OPEN + 6 * HOUR, True),            # 15:30 ET — nen cuoi cung van trong phien
    (OPEN + 6 * HOUR + 1_800_000, False),  # 16:00 ET — sau phien
    (OPEN - 2 * DAY_MS, False),         # Chu Nhat
    (OPEN - 3 * DAY_MS, False),         # Thu Bay
])
def test_in_session_uses_new_york_clock_not_utc(ts_ms, expected):
    assert yahoo.in_session(ts_ms, "1h") is expected


def test_in_session_daily_bar_ignores_intraday_clock():
    assert yahoo.in_session(OPEN, "1d") is True
    assert yahoo.in_session(OPEN - 2 * DAY_MS, "1d") is False


def test_parse_chart_keeps_only_closed_session_bars():
    prev = OPEN - DAY_MS
    bars = (
        session_bars(7)
        + [[prev - HOUR, 1.0, 2.0, 0.5, 1.5, 10.0]]        # 08:30 ET hom truoc
        + [[prev + 7 * HOUR, 1.0, 2.0, 0.5, 1.5, 10.0]]    # 16:30 ET hom truoc
    )
    got = yahoo.parse_chart(payload_of(bars), "1h", NOW)
    assert [b[0] for b in got] == [OPEN + i * HOUR for i in range(6)]


def test_parse_chart_sorts_unsorted_source():
    bars = session_bars(6)
    got = yahoo.parse_chart(payload_of(list(reversed(bars))), "1h", NOW)
    assert [b[0] for b in got] == sorted(b[0] for b in got)


def test_parse_chart_skips_null_ohlc_and_defaults_null_volume():
    bars = session_bars(6)
    bars[2][4] = None       # close thieu -> bo ca nen
    bars[3][5] = None       # volume thieu -> van giu nen, volume 0
    got = yahoo.parse_chart(payload_of(bars), "1h", NOW)
    assert [b[0] for b in got] == [bars[i][0] for i in (0, 1, 3, 4, 5)]
    assert got[2][5] == 0.0


def test_parse_chart_daily_bars_land_on_utc_midnight():
    """Nen ngay cua Yahoo moc o 14:30 UTC; phai ve 00:00 de trung bucket crypto."""
    # DAY la thu Ba 11/11/2025: k=2 Chu Nhat, k=3 Thu Bay, k=0 hom nay.
    daily = [[OPEN - k * DAY_MS, 300.0 + k, 310.0, 290.0, 305.0, 50_000_000.0]
             for k in (6, 5, 4, 3, 2, 1, 0)]
    got = yahoo.parse_chart(payload_of(daily), "1d", NOW)
    assert [b[0] for b in got] == [DAY - k * DAY_MS for k in (6, 5, 4, 1)]
    assert all(b[0] % DAY_MS == 0 for b in got)


def test_parse_chart_daily_bar_of_current_utc_day_is_not_closed():
    got = yahoo.parse_chart(payload_of([[OPEN, 1.0, 2.0, 0.5, 1.5, 10.0]]), "1d", NOW)
    assert got == []
    after_midnight = DAY + DAY_MS + HOUR
    got = yahoo.parse_chart(payload_of([[OPEN, 1.0, 2.0, 0.5, 1.5, 10.0]]), "1d", after_midnight)
    assert [b[0] for b in got] == [DAY]


def test_parse_chart_raises_with_source_description():
    payload = {"chart": {"result": None,
                         "error": {"code": "Not Found", "description": "No data found for symbol"}}}
    with pytest.raises(ValueError, match="No data found for symbol"):
        yahoo.parse_chart(payload, "1h", NOW)


def test_parse_chart_raises_on_empty_payload():
    with pytest.raises(ValueError):
        yahoo.parse_chart({"chart": {"result": [], "error": None}}, "1h", NOW)


def test_parse_chart_rejects_timeframe_yahoo_does_not_serve():
    with pytest.raises(ValueError, match="4h"):
        yahoo.parse_chart(payload_of(session_bars()), "4h", NOW)


def test_forming_bar_is_the_last_open_bar():
    bars = session_bars(7)
    got = yahoo.forming_bar(result_of(bars), "1h", NOW)
    assert got == bars[-1]


def test_forming_bar_none_once_it_closes():
    assert yahoo.forming_bar(result_of(session_bars(7)), "1h", OPEN + 7 * HOUR) is None


def test_forming_bar_none_outside_session():
    bars = session_bars(7)
    bars[-1][0] = OPEN + 7 * HOUR  # 16:30 ET — chua dong nhung ngoai phien
    assert yahoo.forming_bar(result_of(bars), "1h", OPEN + 7 * HOUR + 60_000) is None


def test_forming_bar_none_when_values_missing():
    bars = session_bars(7)
    bars[-1][3] = None
    assert yahoo.forming_bar(result_of(bars), "1h", NOW) is None


def test_forming_bar_none_on_empty_result():
    assert yahoo.forming_bar(result_of([]), "1h", NOW) is None


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class FakeClient:
    def __init__(self, payload):
        self.payload = payload
        self.calls: list[tuple[str, dict]] = []
        self.closed = False

    async def get(self, url, params=None):
        self.calls.append((url, params))
        return FakeResponse(self.payload)

    async def aclose(self):
        self.closed = True


def make_exchange(monkeypatch, payload, now_ms=NOW):
    client = FakeClient(payload)
    monkeypatch.setattr(yahoo.httpx, "AsyncClient", lambda *a, **k: client)
    exchange = yahoo.YahooExchange()
    exchange.milliseconds = lambda: now_ms
    return exchange, client


@pytest.mark.asyncio
async def test_fetch_ohlcv_asks_one_day_range_and_filters_since(monkeypatch):
    exchange, client = make_exchange(monkeypatch, payload_of(session_bars(7)))
    got = await exchange.fetch_ohlcv("AAPL", "1h", since=OPEN, limit=1000)
    url, params = client.calls[0]
    assert url.endswith("/AAPL")
    assert params == {"interval": "1h", "range": "1d"}
    assert [b[0] for b in got] == [OPEN + i * HOUR for i in range(6)]
    await exchange.close()
    assert client.closed is True


@pytest.mark.asyncio
async def test_fetch_ohlcv_caps_range_at_source_limit(monkeypatch):
    exchange, client = make_exchange(monkeypatch, payload_of(session_bars(7)))
    await exchange.fetch_ohlcv("AAPL", "1h", since=NOW - 900 * DAY_MS)
    assert client.calls[0][1]["range"] == "730d"
    await exchange.close()


@pytest.mark.asyncio
async def test_fetch_ohlcv_rejects_timeframe_yahoo_does_not_serve(monkeypatch):
    exchange, client = make_exchange(monkeypatch, payload_of([]))
    with pytest.raises(ValueError):
        await exchange.fetch_ohlcv("AAPL", "4h", since=OPEN)
    assert client.calls == []
    await exchange.close()


@pytest.mark.asyncio
async def test_fetch_history_paginates_yahoo_without_looping(monkeypatch):
    """Duck-type ccxt: trang 2 tra rong nen vong luot phai dung, khong lap vo tan."""
    exchange, client = make_exchange(monkeypatch, payload_of(session_bars(7)))
    got = await ingest.fetch_history(exchange, "AAPL", "1h", OPEN)
    assert [b[0] for b in got] == [OPEN + i * HOUR for i in range(6)]
    assert len(client.calls) == 2
    assert all(b[0] + HOUR <= NOW for b in got)
    await exchange.close()


class DualExchange:
    """Tra nen 1h va nen ngay rieng biet, dung nhu nguon Yahoo that."""

    def __init__(self):
        self.calls: list[str] = []

    def milliseconds(self):
        return NOW

    async def fetch_ohlcv(self, symbol, timeframe, since=None, limit=None):
        self.calls.append(timeframe)
        if timeframe == "1h":
            return session_bars(6)
        return [[DAY - DAY_MS, 300.0, 310.0, 290.0, 305.0, 50_000_000.0]]


@pytest.mark.asyncio
async def test_ingest_symbol_yahoo_also_stores_official_daily_bars(monkeypatch):
    written: list[tuple] = []

    async def upsert(_pool, venue, symbol, timeframe, rows):
        written.append((venue, symbol, timeframe, len(rows)))
        return len(rows)

    monkeypatch.setattr(ingest.db, "upsert_candles", upsert)
    exchange = DualExchange()
    count = await ingest.ingest_symbol(FakePool(), exchange, "yahoo", "AAPL", "1h", 120)
    assert count == 6
    assert written == [("yahoo", "AAPL", "1h", 6), ("yahoo", "AAPL", "1d", 1)]
    assert exchange.calls.count("1d") >= 1


@pytest.mark.asyncio
async def test_ingest_symbol_crypto_does_not_fetch_extra_timeframe(monkeypatch):
    written: list[tuple] = []

    async def upsert(_pool, venue, symbol, timeframe, rows):
        written.append((venue, symbol, timeframe))
        return len(rows)

    monkeypatch.setattr(ingest.db, "upsert_candles", upsert)
    exchange = DualExchange()
    await ingest.ingest_symbol(FakePool(), exchange, "binance", "BTC/USDT", "1h", 120)
    assert written == [("binance", "BTC/USDT", "1h")]
    assert "1d" not in exchange.calls


@pytest.mark.asyncio
async def test_open_exchange_routes_by_venue():
    us = await ingest.open_exchange("yahoo")
    assert isinstance(us, yahoo.YahooExchange)
    await us.close()
    crypto = await ingest.open_exchange("binance")
    assert not isinstance(crypto, yahoo.YahooExchange)
    await crypto.close()


def test_us_annualization_is_not_crypto_annualization():
    assert metrics.periods_for("1h", "yahoo") == 1_638
    assert metrics.periods_for("1d", "yahoo") == 252
    assert metrics.periods_for("1h", "binance") == 8_760
    assert metrics.periods_for("1d", "binance") == 365


def test_us_summary_sharpe_is_lower_than_crypto_sharpe_on_same_series():
    candles = [{"ts": db.utc_ms_to_dt(OPEN + i * HOUR).isoformat(),
                "open": 100.0, "high": 105.0, "low": 95.0,
                "close": 100.0 + i, "volume": 1_000.0} for i in range(60)]
    us = metrics.summary(candles, "1h", metrics.periods_for("1h", "yahoo"))
    crypto = metrics.summary(candles, "1h", metrics.periods_for("1h", "binance"))
    assert us["sharpe"] < crypto["sharpe"]
    assert us["volatility"] < crypto["volatility"]


@pytest.mark.parametrize("raw,expected", [
    ("AAPL", "AAPL"),
    (" aapl ", "AAPL"),
    ("BRK.B", "BRK.B"),
    ("BF-B", "BF-B"),
    ("GOOGL", "GOOGL"),
])
def test_normalize_ticker_accepts_real_us_symbols(raw, expected):
    assert db.normalize_ticker(raw) == expected


@pytest.mark.parametrize("raw", [
    "", "BTC/USDT", "AAPL USDT", "BRK B", "1APL", "../etc/passwd", "AAPL; DROP TABLE candle",
    "A" * 12, "AAPL永续",
])
def test_normalize_ticker_rejects_junk(raw):
    with pytest.raises(ValueError):
        db.normalize_ticker(raw)


class FakePool:
    def __init__(self):
        self.upserts: list[tuple] = []
        self.refreshes = 0


class SnapshotExchange:
    """fetch_snapshot tra lần lượt từng result; het thi lap lai result cuoi."""

    def __init__(self, results: list[dict], now_ms: int = NOW):
        self.results = list(results)
        self.now_ms = now_ms
        self.calls: list[str] = []
        self.closed = False
        self.fail_first = False

    def milliseconds(self):
        return self.now_ms

    async def fetch_snapshot(self, symbol):
        self.calls.append(symbol)
        if self.fail_first:
            self.fail_first = False
            raise RuntimeError("yahoo sập tạm thời")
        return self.results.pop(0) if len(self.results) > 1 else self.results[0]

    async def close(self):
        self.closed = True


@pytest.fixture
def poller(monkeypatch):
    pool = FakePool()

    async def upsert(_pool, venue, symbol, timeframe, rows):
        pool.upserts.append((venue, symbol, timeframe, list(rows)))
        return len(rows)

    async def refresh(_pool):
        pool.refreshes += 1

    entries = [{"venue": "yahoo", "symbol": "AAPL", "timeframe": "1h"}]

    async def watchlist(_pool):
        return entries

    monkeypatch.setattr(live.db, "upsert_candles", upsert)
    monkeypatch.setattr(live.db, "refresh_rollups", refresh)
    monkeypatch.setattr(live.db, "fetch_watchlist", watchlist)
    monkeypatch.setattr(yahoo.httpx, "AsyncClient", lambda *a, **k: FakeClient(payload_of([])))

    hub = live.LiveHub(pool, "binance", "1h")
    poller = live.YahooPoller(hub)
    return poller, pool, entries


def set_snapshot(poller, results, now_ms=NOW):
    exchange = SnapshotExchange(results, now_ms)
    poller.exchange = exchange
    return exchange


@pytest.mark.asyncio
async def test_poller_publishes_forming_bar_without_touching_warehouse(poller):
    p, pool, _ = poller
    bars = session_bars(7)
    set_snapshot(p, [result_of(bars)])
    queue = p.hub.subscribe()
    await p._tick()
    bar = p.hub.bars["AAPL|1h"]
    assert bar["closed"] is False
    assert bar["venue"] == "yahoo"
    assert bar["timeframe"] == "1h"
    assert bar["close"] == bars[-1][4]
    assert bar["ts"] == db.utc_ms_to_dt(bars[-1][0]).isoformat()
    assert pool.upserts == []
    assert queue.get_nowait()["close"] == bars[-1][4]


@pytest.mark.asyncio
async def test_poller_keeps_updating_same_forming_bar(poller):
    p, pool, _ = poller
    bars = session_bars(7)
    exchange = set_snapshot(p, [result_of(bars)])
    await p._tick()
    bars[-1][4] = 999.0
    exchange.results = [result_of(bars)]
    exchange.now_ms = NOW + 60_000
    await p._tick()
    assert p.hub.bars["AAPL|1h"]["close"] == 999.0
    assert pool.upserts == []


@pytest.mark.asyncio
async def test_poller_persists_previous_bar_once_it_closes(poller):
    p, pool, _ = poller
    bars = session_bars(7)
    exchange = set_snapshot(p, [result_of(bars)])
    queue = p.hub.subscribe()
    await p._tick()
    exchange.now_ms = OPEN + 7 * HOUR  # 21:30 UTC — nen 20:30 da dong
    await p._tick()
    assert len(pool.upserts) == 1
    venue, symbol, timeframe, rows = pool.upserts[0]
    assert (venue, symbol, timeframe) == ("yahoo", "AAPL", "1h")
    assert rows[0][0] == db.utc_ms_to_dt(bars[-1][0])
    assert rows[0][1:] == tuple(bars[-1][1:])
    assert "AAPL|1h" not in p.hub.bars
    events = [queue.get_nowait() for _ in range(queue.qsize())]
    assert {"type": "closed", "symbol": "AAPL", "timeframe": "1h"} in events


@pytest.mark.asyncio
async def test_poller_rolls_into_next_forming_bar(poller):
    """Qua dem: nen 15:30 ET hom truoc dong, nen 09:30 ET hom sau dang chay."""
    p, pool, _ = poller
    bars = session_bars(7)
    exchange = set_snapshot(p, [result_of(bars)])
    await p._tick()
    nxt = OPEN + DAY_MS
    exchange.results = [result_of(bars + [[nxt, 200.0, 210.0, 190.0, 205.0, 500.0]])]
    exchange.now_ms = nxt + 60_000
    await p._tick()
    assert len(pool.upserts) == 1
    assert pool.upserts[0][3][0][0] == db.utc_ms_to_dt(bars[-1][0])
    assert p.hub.bars["AAPL|1h"]["close"] == 205.0
    assert p.hub.bars["AAPL|1h"]["closed"] is False


@pytest.mark.asyncio
async def test_poller_does_not_persist_when_market_is_closed(poller):
    p, pool, _ = poller
    exchange = set_snapshot(p, [result_of(session_bars(7))], now_ms=OPEN + 8 * HOUR)
    await p._tick()
    assert exchange.calls == ["AAPL"]
    assert pool.upserts == []
    assert p.hub.bars == {}


@pytest.mark.asyncio
async def test_poller_skips_crypto_entries(poller):
    p, pool, entries = poller
    entries.append({"venue": "binance", "symbol": "BTC/USDT", "timeframe": "1h"})
    exchange = set_snapshot(p, [result_of(session_bars(7))])
    await p._tick()
    assert exchange.calls == ["AAPL"]
    assert "BTC/USDT|1h" not in p.hub.bars


@pytest.mark.asyncio
async def test_poller_stops_polling_removed_symbol(poller):
    p, pool, entries = poller
    exchange = set_snapshot(p, [result_of(session_bars(7))])
    await p._tick()
    entries.clear()
    p._checked = 0.0
    await p._tick()
    assert exchange.calls == ["AAPL"]
    assert p._forming == {}


@pytest.mark.asyncio
async def test_poller_no_watchlist_means_no_request(poller):
    p, _, entries = poller
    entries.clear()
    exchange = set_snapshot(p, [result_of(session_bars(7))])
    await p._tick()
    assert exchange.calls == []


@pytest.mark.asyncio
async def test_poller_run_survives_source_error_and_closes_client(poller, monkeypatch):
    p, _, _ = poller
    monkeypatch.setattr(live, "YAHOO_POLL_SECONDS", 0)
    exchange = set_snapshot(p, [result_of(session_bars(7))])
    exchange.fail_first = True
    task = asyncio.create_task(p.run())
    try:
        for _ in range(200):
            await asyncio.sleep(0)
            if "AAPL|1h" in p.hub.bars:
                break
        assert "AAPL|1h" in p.hub.bars
        assert len(exchange.calls) >= 2
    finally:
        p.hub._stop.set()
        await asyncio.wait_for(task, timeout=2)
    assert exchange.closed is True


@pytest.mark.asyncio
async def test_hub_stop_cancels_both_loops(monkeypatch):
    async def idle(self):
        await asyncio.sleep(3600)

    monkeypatch.setattr(live.LiveHub, "_run", idle)
    monkeypatch.setattr(live.YahooPoller, "run", idle)
    hub = live.LiveHub(FakePool(), "binance", "1h")
    await hub.start()
    assert hub._task is not None and hub._yahoo_task is not None
    await hub.stop()
    assert hub._task is None and hub._yahoo_task is None


@pytest.fixture
def routes(monkeypatch):
    monkeypatch.setattr(api.app.state, "settings",
                        SimpleNamespace(venue="binance", base_timeframe="1h", history_days=120),
                        raising=False)
    monkeypatch.setattr(api.app.state, "pool", FakePool(), raising=False)


@pytest.mark.asyncio
async def test_candles_route_reads_requested_venue(routes, monkeypatch):
    seen = {}
    rows = [{"ts": db.utc_ms_to_dt(OPEN + i * HOUR).isoformat(), "open": 1.0, "high": 2.0,
             "low": 0.5, "close": 1.5, "volume": 10.0} for i in range(3)]

    async def fetch(_pool, venue, symbol, timeframe, limit):
        seen.update(venue=venue, symbol=symbol, timeframe=timeframe, limit=limit)
        return rows

    monkeypatch.setattr(api.db, "fetch_candles", fetch)
    out = await api.candles(symbol="AAPL", timeframe="1h", limit=90, venue="yahoo")
    assert seen == {"venue": "yahoo", "symbol": "AAPL", "timeframe": "1h", "limit": 90}
    assert out["venue"] == "yahoo"


@pytest.mark.asyncio
async def test_candles_route_defaults_to_crypto_venue(routes, monkeypatch):
    seen = {}

    async def fetch(_pool, venue, symbol, timeframe, limit):
        seen["venue"] = venue
        return [{"ts": db.utc_ms_to_dt(OPEN).isoformat(), "open": 1.0, "high": 2.0,
                 "low": 0.5, "close": 1.5, "volume": 10.0}] * 2

    monkeypatch.setattr(api.db, "fetch_candles", fetch)
    await api.candles(symbol="BTC/USDT", timeframe="1h", limit=90, venue=None)
    assert seen["venue"] == "binance"


@pytest.mark.asyncio
async def test_yahoo_daily_reads_stored_bars_not_rollup(routes, monkeypatch):
    seen = {}
    rows = [{"ts": db.utc_ms_to_dt(DAY - i * DAY_MS).isoformat(), "open": 1.0, "high": 2.0,
             "low": 0.5, "close": 1.5, "volume": 10.0} for i in range(3)]

    async def fetch(_pool, venue, symbol, timeframe, limit):
        seen.update(venue=venue, timeframe=timeframe)
        return rows

    async def rollup(*_args):
        raise AssertionError("yahoo 1d khong duoc doc candle_1d")

    monkeypatch.setattr(api.db, "fetch_candles", fetch)
    monkeypatch.setattr(api.db, "fetch_rollup", rollup)
    out = await api.candles(symbol="AAPL", timeframe="1d", limit=90, venue="yahoo")
    assert seen == {"venue": "yahoo", "timeframe": "1d"}
    assert len(out["candles"]) == 3


@pytest.mark.asyncio
async def test_crypto_daily_still_reads_rollup(routes, monkeypatch):
    seen = {}

    async def rollup(_pool, view, venue, symbol, limit):
        seen.update(view=view, venue=venue)
        return [{"ts": db.utc_ms_to_dt(DAY).isoformat(), "open": 1.0, "high": 2.0,
                 "low": 0.5, "close": 1.5, "volume": 10.0}] * 2

    async def fetch(*_args):
        raise AssertionError("crypto 1d phai doc continuous aggregate")

    monkeypatch.setattr(api.db, "fetch_rollup", rollup)
    monkeypatch.setattr(api.db, "fetch_candles", fetch)
    await api.candles(symbol="BTC/USDT", timeframe="1d", limit=90, venue=None)
    assert seen == {"view": "candle_1d", "venue": "binance"}


@pytest.mark.asyncio
async def test_summary_route_annualizes_us_bars_with_us_periods(routes, monkeypatch):
    captured = {}

    async def fake_candles(**kwargs):
        return {"symbol": kwargs["symbol"], "timeframe": kwargs["timeframe"],
                "venue": kwargs["venue"], "candles": []}

    def fake_summary(candles, timeframe, ppy=None):
        captured.update(timeframe=timeframe, ppy=ppy)
        return {"observations": 0}

    monkeypatch.setattr(api, "candles", fake_candles)
    monkeypatch.setattr(api.metrics, "summary", fake_summary)
    await api.summary(symbol="AAPL", timeframe="1h", limit=90, venue="yahoo")
    assert captured == {"timeframe": "1h", "ppy": 1_638}
    await api.summary(symbol="BTC/USDT", timeframe="1h", limit=90, venue=None)
    assert captured == {"timeframe": "1h", "ppy": 8_760}