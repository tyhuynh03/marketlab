"""marketlab_web.ingest — lay OHLCV qua ccxt, ghi len TimescaleDB.

ccxt `fetch_ohlcv` tra toi da ~1000 nen/lan nen phai luot trang theo `since`.
"""
from __future__ import annotations

import asyncio
from typing import Any, Iterable, Sequence

import ccxt.async_support as ccxt

from marketlab_web import db, yahoo

TIMEFRAME_MS = {"1m": 60_000, "5m": 300_000, "15m": 900_000,
                "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}


async def open_exchange(venue: str) -> Any:
    if venue == "yahoo":
        return yahoo.YahooExchange()
    exchange_class = getattr(ccxt, venue)
    return exchange_class({"enableRateLimit": True})


async def fetch_history(exchange: Any, symbol: str, timeframe: str, since_ms: int,
                        until_ms: int | None = None, page: int = 1000) -> list[list]:
    if timeframe not in TIMEFRAME_MS:
        raise ValueError(f"timeframe {timeframe!r} khong co trong TIMEFRAME_MS")
    step = TIMEFRAME_MS[timeframe]
    until = until_ms if until_ms is not None else exchange.milliseconds()

    collected: list[list] = []
    seen: set[int] = set()
    cursor = since_ms - (since_ms % step)
    while cursor < until:
        batch = await exchange.fetch_ohlcv(symbol, timeframe, since=cursor, limit=page)
        if not batch:
            break
        for candle in batch:
            ts = int(candle[0])
            if ts not in seen:
                seen.add(ts)
                collected.append(candle)
        nxt = int(batch[-1][0]) + step
        if nxt <= cursor:
            break
        cursor = nxt
    collected.sort(key=lambda c: c[0])
    # San tra ve ca nến CHUA DON (o dung nay se doi o dung ke tiep). Luu no thi
    # gia tri bi viet lap lai va moi chi so tinh tren no khong tai lap duoc.
    return [c for c in collected if int(c[0]) + step <= until]


def to_rows(ohlcv: Iterable[Sequence]) -> list[tuple]:
    """ccxt chuan hoa: [ts_ms, open, high, low, close, volume] -> dong cua bang candle."""
    return [
        (db.utc_ms_to_dt(int(c[0])), float(c[1]), float(c[2]), float(c[3]), float(c[4]), float(c[5]))
        for c in ohlcv
    ]


async def ingest_symbol(pool, exchange: Any, venue: str, symbol: str,
                        timeframe: str, days: int) -> int:
    since_ms = exchange.milliseconds() - days * 86_400_000
    ohlcv = await fetch_history(exchange, symbol, timeframe, since_ms)
    written = await db.upsert_candles(pool, venue, symbol, timeframe, to_rows(ohlcv))
    # Nen ngay chinh thuc cua Yahoo khac rollup tu nen 1h: nen 1h thieu khoi luong
    # khop lenh dinh ky, nen phai nap rieng thay vi doc candle_1d.
    if venue == "yahoo" and timeframe != "1d":
        daily = await fetch_history(exchange, symbol, "1d", since_ms)
        await db.upsert_candles(pool, venue, symbol, "1d", to_rows(daily))
    return written


async def run_once(settings) -> dict[str, int]:
    pool = await db.create_pool(settings.database_url)
    watchlist = await db.fetch_watchlist(pool)
    exchanges: dict[str, Any] = {}
    try:
        for venue in sorted({entry["venue"] for entry in watchlist}):
            exchanges[venue] = await open_exchange(venue)
        result = {}
        for entry in watchlist:
            written = await ingest_symbol(
                pool, exchanges[entry["venue"]], entry["venue"], entry["symbol"],
                entry["timeframe"], settings.history_days,
            )
            result[entry["symbol"]] = written
        await db.refresh_rollups(pool)
        return result
    finally:
        for exchange in exchanges.values():
            await exchange.close()
        await pool.close()


def main() -> None:
    """Worker chay lien tuc theo chu ky (python -m marketlab_web.ingest)."""
    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    from marketlab_web.config import get_settings

    settings = get_settings()

    async def job() -> None:
        written = await run_once(settings)
        print(f"[ingest] {written}", flush=True)

    async def start() -> None:
        await job()
        scheduler = AsyncIOScheduler()
        scheduler.add_job(job, "interval", seconds=settings.ingest_interval_seconds)
        scheduler.start()
        while True:
            await asyncio.sleep(3600)

    asyncio.run(start())


if __name__ == "__main__":
    main()
