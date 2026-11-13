"""marketlab_web.db — asyncpg pool + truy van candle."""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Iterable, Sequence

import asyncpg

SYMBOL_RE = re.compile(r"^[A-Z0-9]{2,20}/[A-Z0-9]{2,10}\Z")


def normalize_symbol(raw: str, quote: str = "USDT") -> str:
    """'sol' -> 'SOL/USDT'. Tu choi moi thu khong phai cap giao ngay hop le."""
    symbol = raw.strip().upper().replace(" ", "")
    if "/" not in symbol:
        symbol = f"{symbol}/{quote}"
    if not SYMBOL_RE.match(symbol):
        raise ValueError(
            f"symbol {raw!r} không hợp lệ (cần dạng BASE/QUOTE, ví dụ BTC/USDT)")
    return symbol

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
ROLLUP_VIEWS = {"4h": "candle_4h", "1d": "candle_1d"}


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


# ---------- agent runs (migration 002_agent.sql) ----------

async def create_agent_run(pool: asyncpg.Pool, symbol: str, timeframe: str,
                           model_tool: str, model_answer: str) -> int:
    async with pool.acquire() as conn:
        return int(await conn.fetchval("""
            INSERT INTO agent_run (symbol, timeframe, status, model_tool, model_answer)
            VALUES ($1, $2, 'running', $3, $4)
            RETURNING id
        """, symbol, timeframe, model_tool, model_answer))


async def finish_agent_run(pool: asyncpg.Pool, run_id: int, status: str,
                           model_answer: str, tokens_in: int, tokens_out: int,
                           error: str | None) -> None:
    async with pool.acquire() as conn:
        await conn.execute("""
            UPDATE agent_run
               SET status = $2, model_answer = $3, tokens_in = $4, tokens_out = $5,
                   error = $6, finished_at = now()
             WHERE id = $1
        """, run_id, status, model_answer, tokens_in, tokens_out, error)


async def insert_agent_step(pool: asyncpg.Pool, run_id: int, step_idx: int, kind: str,
                            tool_name: str | None, args_json: str, result_json: str,
                            tokens: int, latency_ms: int) -> None:
    async with pool.acquire() as conn:
        await conn.execute("""
            INSERT INTO agent_step (run_id, step_idx, kind, tool_name, args_json,
                                    result_json, tokens, latency_ms)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
        """, run_id, step_idx, kind, tool_name, args_json, result_json, tokens, latency_ms)


async def fetch_agent_run(pool: asyncpg.Pool, run_id: int) -> dict[str, Any] | None:
    """Trang thai + ket qua cho reconnect: run row + cac buoc da ghi."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow("""
            SELECT id, symbol, timeframe, status, model_tool, model_answer,
                   tokens_in, tokens_out, error, created_at, finished_at
              FROM agent_run WHERE id = $1
        """, run_id)
        if row is None:
            return None
        steps = await conn.fetch("""
            SELECT step_idx, kind, tool_name, args_json, result_json, tokens,
                   latency_ms, created_at
              FROM agent_step WHERE run_id = $1 ORDER BY step_idx, id
        """, run_id)
    out = dict(row)
    out["run_id"] = out.pop("id")
    out["steps_detail"] = [dict(step) for step in steps]
    # snapshot() cua run dang song cung dung ten "steps" la so buoc, khong phai danh sach.
    out["steps"] = sum(1 for step in out["steps_detail"] if step["kind"] == "tool")
    out["answer"] = None
    for step in out["steps_detail"]:
        if step["kind"] == "answer":
            payload = step.get("result_json")
            if isinstance(payload, str):
                try:
                    payload = json.loads(payload)
                except ValueError:
                    payload = None
            out["answer"] = (payload or {}).get("text") if isinstance(payload, dict) else None
    return out


def utc_ms_to_dt(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, timezone.utc)
