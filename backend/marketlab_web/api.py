"""marketlab_web.api — FastAPI phuc vu dashboard."""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import ccxt
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from marketlab_web import agent, db, ingest, live, metrics, runs
from marketlab_web.config import get_settings

ROLLUP_VIEWS = db.ROLLUP_VIEWS
# Khop danh sach khung cua UI (web/src/api.ts) va du lieu da nap trong kho.
AGENT_TIMEFRAMES = ("1h", "4h", "1d")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.pool = await db.create_pool(settings.database_url)
    app.state.settings = settings
    app.state.live = live.LiveHub(app.state.pool, settings.venue, settings.base_timeframe)
    app.state.runs = runs.RunManager(app.state.pool, settings)
    if settings.live_enabled:
        await app.state.live.start()
    else:
        app.state.live.state = "off"
    try:
        yield
    finally:
        await app.state.runs.stop()
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
            detail=f"thiếu dữ liệu cho {symbol} {timeframe} — chạy worker ingest trước",
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


class AnalyzeIn(BaseModel):
    symbol: str
    timeframe: str = "1h"


@app.post("/api/agent/analyze")
async def agent_analyze(body: AnalyzeIn) -> dict[str, Any]:
    """Mot phat phan tich: metrics.summary + 40 nen gan nhat -> LLM, chua co tool."""
    try:
        symbol = db.normalize_symbol(body.symbol)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if body.timeframe not in AGENT_TIMEFRAMES:
        raise HTTPException(
            status_code=422,
            detail=f"khung {body.timeframe!r} không được hỗ trợ (1h, 4h, 1d)")

    settings: Any = app.state.settings
    if not (settings.llm_api_key or "").strip():
        # Chan truoc khi cham pool: thieu khoa thi khong co gi de phan tich.
        raise HTTPException(
            status_code=503,
            detail="agent chưa sẵn sàng: thiếu LLM_API_KEY trong .env")

    try:
        return await agent.analyze(app.state.pool, settings, symbol, body.timeframe)
    except agent.NoData as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except agent.ProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except agent.NotConfigured as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


async def _probe_agent_data(pool: Any, settings: Any, symbol: str, timeframe: str) -> int:
    """Dem nhanh vai nen dau de tra 404 truoc khi tao run (khong tinh summary)."""
    view = ROLLUP_VIEWS.get(timeframe)
    if view:
        rows = await db.fetch_rollup(pool, view, settings.venue, symbol, 2)
    else:
        rows = await db.fetch_candles(pool, settings.venue, symbol, timeframe, 2)
    return len(rows)


@app.post("/api/agent/runs", status_code=202)
async def create_agent_run(body: AnalyzeIn) -> dict[str, Any]:
    """Tao run agent doc-only (buoc 2). Run chay nen; client theo doi qua SSE."""
    try:
        symbol = db.normalize_symbol(body.symbol)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if body.timeframe not in AGENT_TIMEFRAMES:
        raise HTTPException(
            status_code=422,
            detail=f"khung {body.timeframe!r} không được hỗ trợ (1h, 4h, 1d)")

    settings: Any = app.state.settings
    if not (settings.llm_api_key or "").strip():
        # Chan truoc khi cham pool: thieu khoa thi khong tao duoc run.
        raise HTTPException(
            status_code=503,
            detail="agent chưa sẵn sàng: thiếu LLM_API_KEY trong .env")
    if await _probe_agent_data(app.state.pool, settings, symbol, body.timeframe) < 2:
        raise HTTPException(
            status_code=404,
            detail=f"thiếu dữ liệu cho {symbol} {body.timeframe} — chạy worker ingest trước")

    handle = await app.state.runs.create(symbol, body.timeframe)
    return {"run_id": handle.run_id, "symbol": symbol, "timeframe": body.timeframe}


@app.get("/api/agent/runs/{run_id}")
async def get_agent_run(run_id: int) -> dict[str, Any]:
    """Trang thai + buoc + cau tra loi cuoi cho client reconnect."""
    row = await db.fetch_agent_run(app.state.pool, run_id)
    manager = getattr(app.state, "runs", None)
    handle = manager.get(run_id) if manager is not None else None
    if row is None and handle is None:
        raise HTTPException(status_code=404, detail="không tìm thấy run")
    if row is None:
        return handle.snapshot()
    if handle is not None:
        snapshot = handle.snapshot()
        for key in ("status", "model_answer", "tokens_in", "tokens_out", "steps",
                    "answer", "error", "elapsed_ms"):
            if snapshot.get(key) is not None:
                row[key] = snapshot[key]
    return row


@app.get("/api/agent/runs/{run_id}/stream")
async def stream_agent_run(run_id: int, request: Request) -> StreamingResponse:
    """SSE cua mot run: replay su kien da co, roi day tiep; heartbeat 15s."""
    manager = getattr(app.state, "runs", None)
    if manager is None:
        raise HTTPException(
            status_code=503, detail="agent chưa sẵn sàng: thiếu LLM_API_KEY trong .env")
    known = manager.get(run_id) is not None
    if not known and await db.fetch_agent_run(app.state.pool, run_id) is None:
        raise HTTPException(status_code=404, detail="không tìm thấy run")
    generator = await runs.event_stream(manager, run_id, request)
    return StreamingResponse(generator, media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    })


@app.post("/api/agent/runs/{run_id}/cancel")
async def cancel_agent_run(run_id: int) -> dict[str, Any]:
    manager = getattr(app.state, "runs", None)
    status = await manager.cancel(run_id) if manager is not None else None
    if status is None:
        row = await db.fetch_agent_run(app.state.pool, run_id)
        if row is None:
            raise HTTPException(status_code=404, detail="không tìm thấy run")
        return {"run_id": run_id, "status": row["status"], "cancelled": False}
    return {"run_id": run_id, "status": status, "cancelled": status == "cancelled"}


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
