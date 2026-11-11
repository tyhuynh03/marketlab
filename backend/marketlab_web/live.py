"""marketlab_web.live — nến đang chạy: Binance kline WS -> bộ nhớ -> SSE.

Kho TimescaleDB vẫn chỉ chứa nến ĐÃ ĐÔNG. Nến đang chạy nằm trong bộ nhớ của hub
và được đẩy xuống client qua SSE; chỉ khi sàn báo đóng (k.x) mới upsert vào kho,
nên mọi chỉ số tính lại từ kho vẫn tái lập được.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime
from typing import Any

import websockets

from marketlab_web import db

log = logging.getLogger("marketlab.live")

LIVE_TIMEFRAMES = ("1h", "4h", "1d")
WS_URL = "wss://stream.binance.com:9443/stream"
HEARTBEAT_SECONDS = 15
WATCHLIST_POLL_SECONDS = 30
RECONNECT_MAX_SECONDS = 30
ROLLUP_BOUNDARY_MS = {"4h": 14_400_000, "1d": 86_400_000}


def stream_name(symbol: str, timeframe: str) -> str:
    return f"{symbol.replace('/', '').lower()}@kline_{timeframe}"


def kline_to_bar(k: dict[str, Any], symbol: str, timeframe: str) -> dict[str, Any] | None:
    """Binance kline -> bar đúng hình dạng /api/candles. None nếu bản tin thiếu."""
    try:
        ts_ms = int(k["t"])
        bar = {
            "type": "bar",
            "symbol": symbol,
            "timeframe": timeframe,
            "ts": db.utc_ms_to_dt(ts_ms).isoformat(),
            "open": float(k["o"]),
            "high": float(k["h"]),
            "low": float(k["l"]),
            "close": float(k["c"]),
            "volume": float(k["v"]),
            "closed": bool(k["x"]),
        }
    except (KeyError, TypeError, ValueError):
        return None
    return bar


def closes_rollup(ts_ms: int, timeframe_ms: int) -> bool:
    """Nến 1h vừa đóng có trùng mép bucket 4h/1d không — chỉ khi đó mới refresh aggregate."""
    end = ts_ms + timeframe_ms
    return any(end % boundary == 0 for boundary in ROLLUP_BOUNDARY_MS.values())


class LiveHub:
    def __init__(self, pool: Any, venue: str, base_timeframe: str) -> None:
        self.pool = pool
        self.venue = venue
        self.base_timeframe = base_timeframe
        self.bars: dict[str, dict[str, Any]] = {}
        self.state = "connecting"
        self._subs: set[asyncio.Queue] = set()
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    @staticmethod
    def key(symbol: str, timeframe: str) -> str:
        return f"{symbol}|{timeframe}"

    async def start(self) -> None:
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="marketlab-live")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    def subscribe(self) -> asyncio.Queue:
        # Hàng đợi có chặn: client chậm thì bỏ bản tin cũ chứ không phình bộ nhớ.
        queue: asyncio.Queue = asyncio.Queue(maxsize=256)
        self._subs.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._subs.discard(queue)

    def _publish(self, event: dict[str, Any]) -> None:
        for queue in list(self._subs):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass

    def _set_state(self, state: str) -> None:
        if self.state == state:
            return
        self.state = state
        self._publish({"type": "state", "state": state})

    async def _load_symbols(self) -> list[str]:
        entries = await db.fetch_watchlist(self.pool)
        return sorted({e["symbol"] for e in entries if e["venue"] == self.venue})

    async def _run(self) -> None:
        backoff = 1
        while not self._stop.is_set():
            try:
                symbols = await self._load_symbols()
                if not symbols:
                    self._set_state("off")
                    await asyncio.sleep(WATCHLIST_POLL_SECONDS)
                    continue
                streams = [stream_name(s, tf) for s in symbols for tf in LIVE_TIMEFRAMES]
                lookup = {stream_name(s, tf): (s, tf) for s in symbols for tf in LIVE_TIMEFRAMES}
                url = f"{WS_URL}?streams={'/'.join(streams)}"
                async with websockets.connect(url, compression=None, proxy=None,
                                              ping_interval=20, ping_timeout=20) as socket:
                    self._set_state("on")
                    backoff = 1
                    await self._pump(socket, lookup, set(symbols))
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — mất mạng/sàn đóng đều phải nối lại
                log.warning("live stream lỗi: %s", exc)
                self._set_state("error")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, RECONNECT_MAX_SECONDS)
        self._set_state("off")

    async def _pump(self, socket: Any, lookup: dict[str, tuple[str, str]],
                    symbols: set[str]) -> None:
        checked = time.monotonic()
        while not self._stop.is_set():
            try:
                raw = await asyncio.wait_for(socket.recv(), timeout=WATCHLIST_POLL_SECONDS)
            except asyncio.TimeoutError:
                if set(await self._load_symbols()) != symbols:
                    return
                checked = time.monotonic()
                continue
            # Stream đông bản tin thì nhánh timeout không bao giờ chạy,
            # nên phải ngó watchlist theo deadline ngay cả khi đang nhận đều.
            if time.monotonic() - checked >= WATCHLIST_POLL_SECONDS:
                checked = time.monotonic()
                if set(await self._load_symbols()) != symbols:
                    return
            message = json.loads(raw)
            target = lookup.get(message.get("stream", ""))
            if target is None:
                continue
            symbol, timeframe = target
            bar = kline_to_bar(message.get("data", {}).get("k", {}), symbol, timeframe)
            if bar is None:
                continue
            self.bars[self.key(symbol, timeframe)] = bar
            self._publish(bar)
            await self._persist(bar)

    async def _persist(self, bar: dict[str, Any]) -> None:
        """Chỉ nến gốc ĐÃ ĐÔNG mới ghi kho; 4h/1d là continuous aggregate của nến gốc."""
        if not bar["closed"] or bar["timeframe"] != self.base_timeframe:
            return
        try:
            ts_ms = int(datetime.fromisoformat(bar["ts"]).timestamp() * 1000)
            await db.upsert_candles(self.pool, self.venue, bar["symbol"], bar["timeframe"], [(
                db.utc_ms_to_dt(ts_ms), bar["open"], bar["high"],
                bar["low"], bar["close"], bar["volume"],
            )])
            if closes_rollup(ts_ms, 3_600_000):
                await db.refresh_rollups(self.pool)
        except Exception as exc:  # noqa: BLE001 — kho lỗi không được làm đứt luồng giá
            log.warning("không ghi được nến đóng %s: %s", bar["symbol"], exc)
        self._publish({"type": "closed", "symbol": bar["symbol"], "timeframe": bar["timeframe"]})


async def event_stream(hub: LiveHub, request: Any) -> Any:
    """SSE: state hiện tại + snapshot nến đang chạy, rồi tới đâu đẩy đó."""
    queue = hub.subscribe()

    async def generate():
        try:
            yield f"data: {json.dumps({'type': 'state', 'state': hub.state})}\n\n"
            for bar in list(hub.bars.values()):
                yield f"data: {json.dumps(bar)}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
                    continue
                yield f"data: {json.dumps(event)}\n\n"
        finally:
            hub.unsubscribe(queue)

    return generate()