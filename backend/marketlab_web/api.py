"""marketlab_web.api — FastAPI phuc vu dashboard."""
from __future__ import annotations

from contextlib import asynccontextmanager
from decimal import Decimal
from typing import Any

import ccxt
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from marketlab_web import db, ingest, live, metrics, portfolio
from marketlab_web.config import get_settings

ROLLUP_VIEWS = {"4h": "candle_4h", "1d": "candle_1d"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.pool = await db.create_pool(settings.database_url)
    app.state.settings = settings
    await portfolio.ensure_schema(app.state.pool)
    app.state.live = live.LiveHub(app.state.pool, settings.venue, settings.base_timeframe)
    if settings.live_enabled:
        await app.state.live.start()
    else:
        app.state.live.state = "off"
    try:
        yield
    finally:
        await app.state.live.stop()
        await app.state.pool.close()


app = FastAPI(title="marketlab-web", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, Any]:
    async with app.state.pool.acquire() as conn:
        version = await conn.fetchval(
            "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'")
        candles = await conn.fetchval("SELECT count(*) FROM candle")
    return {"status": "ok", "timescaledb": version, "candles": candles}


@app.get("/api/watchlist")
async def watchlist() -> list[dict[str, Any]]:
    return await db.fetch_watchlist(app.state.pool)


@app.get("/api/live")
async def live_stream(request: Request) -> StreamingResponse:
    """SSE nến đang chạy. Kho nến vẫn chỉ đọc qua /api/candles (nến đã đóng)."""
    generator = await live.event_stream(app.state.live, request)
    return StreamingResponse(generator, media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    })


class WatchlistIn(BaseModel):
    symbol: str
    label: str | None = None
    venue: str | None = None


@app.post("/api/watchlist")
async def add_symbol(body: WatchlistIn) -> dict[str, Any]:
    """Them symbol va nap luon lich su: watchlist chi chua symbol co that tren san."""
    settings: Any = app.state.settings
    venue = body.venue or settings.venue
    try:
        symbol = db.normalize_symbol(body.symbol)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    exchange = await ingest.open_exchange(venue)
    try:
        written = await ingest.ingest_symbol(
            app.state.pool, exchange, venue, symbol,
            settings.base_timeframe, settings.history_days)
    except ccxt.BaseError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"{venue} khong giao dich {symbol}: {exc}") from exc
    finally:
        await exchange.close()

    if written == 0:
        raise HTTPException(status_code=422, detail=f"{venue} khong tra nen nao cho {symbol}")

    entry = await db.add_watchlist(app.state.pool, venue, symbol,
                                   settings.base_timeframe, body.label)
    await db.refresh_rollups(app.state.pool)
    return {"entry": entry, "written": written}


@app.delete("/api/watchlist")
async def remove_symbol(symbol: str = Query(...), venue: str | None = Query(None)) -> dict[str, str]:
    settings: Any = app.state.settings
    try:
        normalized = db.normalize_symbol(symbol)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    removed = await db.remove_watchlist(
        app.state.pool, venue or settings.venue, normalized, settings.base_timeframe)
    if not removed:
        raise HTTPException(status_code=404, detail=f"{normalized} khong co trong watchlist")
    return {"removed": normalized}


@app.get("/api/candles")
async def candles(
    symbol: str = Query(...),
    timeframe: str = Query("1h"),
    limit: int = Query(500, ge=2, le=5000),
) -> dict[str, Any]:
    settings: Any = app.state.settings
    view = ROLLUP_VIEWS.get(timeframe)
    if view:
        rows = await db.fetch_rollup(app.state.pool, view, settings.venue, symbol, limit)
    else:
        rows = await db.fetch_candles(app.state.pool, settings.venue, symbol, timeframe, limit)
    if len(rows) < 2:
        raise HTTPException(
            status_code=404,
            detail=f"thieu du lieu cho {symbol} {timeframe} — chay worker ingest truoc",
        )
    return {"symbol": symbol, "timeframe": timeframe, "candles": rows}


@app.get("/api/summary")
async def summary(
    symbol: str = Query(...),
    timeframe: str = Query("1h"),
    limit: int = Query(500, ge=2, le=5000),
) -> dict[str, Any]:
    payload = await candles(symbol=symbol, timeframe=timeframe, limit=limit)
    result = metrics.summary(payload["candles"], timeframe)
    result["symbol"] = symbol
    result["timeframe"] = timeframe
    return result


@app.post("/api/ingest")
async def trigger_ingest(
    symbol: str | None = Query(None),
    days: int | None = Query(None, ge=1, le=365),
) -> dict[str, int]:
    settings: Any = app.state.settings
    exchange = await ingest.open_exchange(settings.venue)
    pool = app.state.pool
    try:
        if symbol:
            written = await ingest.ingest_symbol(
                pool, exchange, settings.venue, symbol, settings.base_timeframe,
                days or settings.history_days)
            await db.refresh_rollups(pool)
            return {symbol: written}
        result = {}
        for entry in await db.fetch_watchlist(pool):
            written = await ingest.ingest_symbol(
                pool, exchange, entry["venue"], entry["symbol"], entry["timeframe"],
                days or settings.history_days)
            result[entry["symbol"]] = written
        await db.refresh_rollups(pool)
        return result
    finally:
        await exchange.close()


class OrderIn(BaseModel):
    symbol: str
    side: str
    qty: float
    idem_key: str | None = None


class RebalanceIn(BaseModel):
    execute: bool = False
    idem_key: str | None = None


class TargetsIn(BaseModel):
    weights: dict[str, float]


class SeedIn(BaseModel):
    days: int = 60


@app.get("/api/portfolio")
async def portfolio_snapshot() -> dict[str, Any]:
    settings: Any = app.state.settings
    snap = await portfolio.snapshot(app.state.pool, app.state.live, settings.venue)
    rc = await portfolio.risk_contributions(app.state.pool, settings.venue, snap)
    labels = {e["symbol"]: e["label"] for e in await db.fetch_watchlist(app.state.pool)}
    for p in snap["positions"]:
        p["label"] = labels.get(p["symbol"])
        p["risk_contrib"] = rc.get(p["symbol"])
    return snap


@app.get("/api/portfolio/equity")
async def portfolio_equity(benchmark: str = Query("btc", pattern="^(btc|8020)$")) -> dict[str, Any]:
    settings: Any = app.state.settings
    return await portfolio.equity(app.state.pool, settings.venue, benchmark)


@app.get("/api/portfolio/ledger")
async def portfolio_ledger(
    tab: str = Query("fills", pattern="^(fills|cash)$"),
    limit: int = Query(200, ge=1, le=1000),
) -> list[dict[str, Any]]:
    return await portfolio.ledger(app.state.pool, tab, limit)


@app.post("/api/portfolio/order")
async def portfolio_order(body: OrderIn) -> dict[str, Any]:
    settings: Any = app.state.settings
    try:
        symbol = db.normalize_symbol(body.symbol)
        mark, source = await portfolio.mark_price(
            app.state.pool, app.state.live, settings.venue, symbol)
        return await portfolio.place_order(
            app.state.pool, symbol=symbol, side=body.side,
            qty=Decimal(str(body.qty)), mark=mark, idem_key=body.idem_key) | {"mark_source": source}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.post("/api/portfolio/rebalance")
async def portfolio_rebalance(body: RebalanceIn) -> dict[str, Any]:
    settings: Any = app.state.settings
    try:
        if body.execute:
            fills = await portfolio.rebalance_execute(
                app.state.pool, app.state.live, settings.venue, body.idem_key)
            return {"executed": fills}
        return {"plan": await portfolio.rebalance_plan(app.state.pool, app.state.live, settings.venue)}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.put("/api/portfolio/targets")
async def portfolio_targets(body: TargetsIn) -> dict[str, Any]:
    weights: dict[str, float] = {}
    for raw, w in body.weights.items():
        sym = "CASH" if raw.upper() == "CASH" else db.normalize_symbol(raw)
        if not 0 <= w <= 1:
            raise HTTPException(status_code=422, detail=f"weight {raw} phai trong [0,1]")
        weights[sym] = w
    if abs(sum(weights.values()) - 1) > 1e-6:
        raise HTTPException(status_code=422, detail="tong weight phai = 1")
    async with app.state.pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("DELETE FROM paper_target")
            await conn.executemany(
                "INSERT INTO paper_target (symbol, weight) VALUES ($1,$2)",
                list(weights.items()))
    return {"weights": weights}


@app.post("/api/portfolio/reset")
async def portfolio_reset() -> dict[str, str]:
    await portfolio.reset(app.state.pool)
    return {"reset": "ok"}


@app.post("/api/portfolio/seed")
async def portfolio_seed(body: SeedIn) -> dict[str, int]:
    settings: Any = app.state.settings
    try:
        n = await portfolio.seed(app.state.pool, settings.venue, body.days)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"seeded_orders": n}
