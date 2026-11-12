"""marketlab_web.db — asyncpg pool + truy van candle."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Iterable, Sequence

import asyncpg

SYMBOL_RE = re.compile(r"^[A-Z0-9]{2,20}/[A-Z0-9]{2,10}\Z")
TICKER_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}\Z")


def normalize_symbol(raw: str, quote: str = "USDT") -> str:
    """'sol' -> 'SOL/USDT'. Tu choi moi thu khong phai cap giao ngay hop le."""
    symbol = raw.strip().upper().replace(" ", "")
    if "/" not in symbol:
        symbol = f"{symbol}/{quote}"
    if not SYMBOL_RE.match(symbol):
        raise ValueError(f"symbol {raw!r} khong hop le (can dang BASE/QUOTE, vi du BTC/USDT)")
    return symbol


def normalize_ticker(raw: str) -> str:
    """Co phieu My khong co cap quote: 'aapl' -> 'AAPL', cho phep dau cham/gach (BRK.B).

    Khong noi khoang trang nhu normalize_symbol: 'BRK B' ma thanh 'BRKB' la doi
    sang mot ma khac co that, nen phai tu choi thay vi doan.
    """
    ticker = raw.strip().upper()
    if not TICKER_RE.match(ticker):
        raise ValueError(f"ticker {raw!r} khong hop le (vi du AAPL, MSFT, BRK.B)")
    return ticker

UPSERT_SQL = """
INSERT INTO candle (venue, symbol, timeframe, ts, open, high, low, close, volume)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (venue, symbol, timeframe, ts) DO UPDATE SET
    open = EXCLUDED.open,
    high = EXCLUDED.high,
    low = EXCLUDED.low,
    close = EXCLUDED.close,
    volume = EXCLUDED.volume
"""

SELECT_SQL = """
SELECT ts, open, high, low, close, volume
FROM candle
WHERE venue = $1 AND symbol = $2 AND timeframe = $3
  AND ($4::timestamptz IS NULL OR ts >= $4)
ORDER BY ts ASC
"""

ROLLUP_MVIEWS = ("candle_4h", "candle_1d")


async def create_pool(dsn: str) -> asyncpg.Pool:
    return await asyncpg.create_pool(dsn, min_size=1, max_size=8)


async def refresh_rollups(pool: asyncpg.Pool) -> None:
    """continuous aggregate chi chay theo chinh sach 1 gio; goi sau khi ingest de
    /api/candles?timeframe=4h|1d khong tra ve bucket thieu nen."""
    async with pool.acquire() as conn:
        for view in ROLLUP_MVIEWS:
            await conn.execute(f"CALL refresh_continuous_aggregate('{view}', NULL, NULL)")


async def upsert_candles(pool: asyncpg.Pool, venue: str, symbol: str,
                        timeframe: str, rows: Iterable[Sequence[Any]]) -> int:
    """rows: (ts, open, high, low, close, volume). Tra so dong gui di."""
    records = [
        (venue, symbol, timeframe, r[0], r[1], r[2], r[3], r[4], r[5])
        for r in rows
    ]
    if not records:
        return 0
    async with pool.acquire() as conn:
        await conn.executemany(UPSERT_SQL, records)
    return len(records)


async def fetch_candles(pool: asyncpg.Pool, venue: str, symbol: str, timeframe: str,
                        limit: int, since: datetime | None = None) -> list[dict[str, Any]]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(SELECT_SQL, venue, symbol, timeframe, since)
    rows = rows[-limit:]
    return [
        {
            "ts": r["ts"],
            "open": _f(r["open"]),
            "high": _f(r["high"]),
            "low": _f(r["low"]),
            "close": _f(r["close"]),
            "volume": _f(r["volume"]),
        }
        for r in rows
    ]


async def fetch_rollup(pool: asyncpg.Pool, view: str, venue: str, symbol: str,
                       limit: int) -> list[dict[str, Any]]:
    """Doc continuous aggregate (candle_4h / candle_1d) thay vi nen nen goc."""
    if view not in ROLLUP_MVIEWS:
        raise ValueError(f"view {view!r} khong phai continuous aggregate da biet")
    sql = f"SELECT bucket AS ts, open, high, low, close, volume FROM {view} " \
          f"WHERE venue = $1 AND symbol = $2 ORDER BY bucket ASC"
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, venue, symbol)
    rows = rows[-limit:]
    return [{"ts": r["ts"], "open": _f(r["open"]), "high": _f(r["high"]),
             "low": _f(r["low"]), "close": _f(r["close"]), "volume": _f(r["volume"])}
            for r in rows]


async def fetch_watchlist(pool: asyncpg.Pool) -> list[dict[str, Any]]:
    sql = """
    SELECT w.venue, w.symbol, w.timeframe, w.label,
           count(c.ts) AS candles,
           max(c.ts)   AS last_ts,
           (array_agg(c.close ORDER BY c.ts DESC))[1] AS last_close,
           (array_agg(c.close ORDER BY c.ts DESC))[2] AS prev_close
    FROM watchlist w
    LEFT JOIN candle c ON c.venue = w.venue AND c.symbol = w.symbol
                      AND c.timeframe = w.timeframe
    GROUP BY w.venue, w.symbol, w.timeframe, w.label
    ORDER BY w.symbol
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql)
    out = []
    for r in rows:
        last, prev = _f(r["last_close"]), _f(r["prev_close"])
        out.append({
            "venue": r["venue"], "symbol": r["symbol"], "timeframe": r["timeframe"],
            "label": r["label"], "candles": r["candles"],
            "last_ts": r["last_ts"], "last_close": last, "prev_close": prev,
            "delta": (last / prev - 1.0) if last and prev else None,
        })
    return out


async def add_watchlist(pool: asyncpg.Pool, venue: str, symbol: str, timeframe: str,
                        label: str | None = None) -> dict[str, Any]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("""
            INSERT INTO watchlist (venue, symbol, timeframe, label)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (venue, symbol, timeframe)
            DO UPDATE SET label = COALESCE(EXCLUDED.label, watchlist.label)
            RETURNING venue, symbol, timeframe, label
        """, venue, symbol, timeframe, label)
    return dict(row)


async def remove_watchlist(pool: asyncpg.Pool, venue: str, symbol: str,
                           timeframe: str) -> bool:
    """Bo khoi danh sach theo doi; nen da nap van giu lai trong hypertable."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow("""
            DELETE FROM watchlist WHERE venue = $1 AND symbol = $2 AND timeframe = $3
            RETURNING symbol
        """, venue, symbol, timeframe)
    return row is not None


def _f(value: Any) -> float | None:
    return None if value is None else float(value)


def utc_ms_to_dt(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, timezone.utc)
