"""marketlab_web.yahoo — nen co phieu My qua chart API cua Yahoo, khong can key.

Nguon unofficial nen chi doc: loc phien chinh New York va bo nen dang chay,
giu dung hop dong "kho chi chua nen DA DONG" nhu voi crypto.
"""
from __future__ import annotations

import time
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import httpx

CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) marketlab-study"
# interval Yahoo, buoc ms, so ngay toi da nguon cho phep o interval do
INTERVALS = {"1h": ("1h", 3_600_000, 730), "1d": ("1d", 86_400_000, 3650)}
NY = ZoneInfo("America/New_York")
SESSION_OPEN_MIN = 9 * 60 + 30
SESSION_CLOSE_MIN = 16 * 60


def in_session(ts_ms: int, timeframe: str) -> bool:
    local = datetime.fromtimestamp(ts_ms / 1000, NY)
    if local.weekday() >= 5:
        return False
    if timeframe == "1d":
        return True
    minutes = local.hour * 60 + local.minute
    return SESSION_OPEN_MIN <= minutes < SESSION_CLOSE_MIN


def _result(payload: dict[str, Any]) -> dict[str, Any]:
    chart = payload.get("chart") or {}
    result = chart.get("result")
    if not result:
        err = chart.get("error") or {}
        raise ValueError(
            f"yahoo khong tra du lieu: {err.get('description') or err.get('code') or 'payload rong'}")
    return result[0]


def _columns(result: dict[str, Any]) -> tuple[list[int], dict[str, list]]:
    quote = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    return result.get("timestamp") or [], {k: (quote.get(k) or []) for k in
                                          ("open", "high", "low", "close", "volume")}


def parse_chart(payload: dict[str, Any], timeframe: str, now_ms: int) -> list[list]:
    """-> [ts_ms, o, h, l, c, v] chi gom nen da dong trong phien chinh."""
    if timeframe not in INTERVALS:
        raise ValueError(f"yahoo khong co timeframe {timeframe!r}")
    step = INTERVALS[timeframe][1]
    ts, cols = _columns(_result(payload))
    out = []
    for i, t in enumerate(ts):
        vals = [cols[k][i] if i < len(cols[k]) else None
                for k in ("open", "high", "low", "close", "volume")]
        if any(v is None for v in vals[:4]):
            continue
        ts_ms = int(t) * 1000
        if not in_session(ts_ms, timeframe):
            continue
        if timeframe == "1d":
            # Yahoo moc nen ngay o luc mo phien (14:30 UTC). Dua ve 00:00 UTC de
            # trung bucket voi crypto, va de nen ngay chi vao kho khi ngay UTC do da ket thuc.
            ts_ms -= ts_ms % 86_400_000
        if ts_ms + step > now_ms:
            continue
        out.append([ts_ms, float(vals[0]), float(vals[1]), float(vals[2]),
                    float(vals[3]), float(vals[4] or 0)])
    out.sort(key=lambda c: c[0])
    return out


def forming_bar(result: dict[str, Any], timeframe: str, now_ms: int) -> list | None:
    """Nen chua dong cua phien hien tai, None neu ngoai phien hoac thieu du lieu."""
    step = INTERVALS[timeframe][1]
    ts, cols = _columns(result)
    if not ts:
        return None
    i = len(ts) - 1
    ts_ms = int(ts[i]) * 1000
    if ts_ms + step <= now_ms or not in_session(ts_ms, timeframe):
        return None
    vals = [cols[k][i] if i < len(cols[k]) else None
            for k in ("open", "high", "low", "close", "volume")]
    if any(v is None for v in vals[:4]):
        return None
    return [ts_ms, float(vals[0]), float(vals[1]), float(vals[2]),
            float(vals[3]), float(vals[4] or 0)]


class YahooExchange:
    """Duck-type dung phan ingest can: milliseconds / fetch_ohlcv / close."""

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(timeout=20, headers={"User-Agent": USER_AGENT})

    def milliseconds(self) -> int:
        return int(time.time() * 1000)

    async def fetch_ohlcv(self, symbol: str, timeframe: str,
                          since: int | None = None, limit: int | None = None) -> list[list]:
        if timeframe not in INTERVALS:
            raise ValueError(f"yahoo khong co timeframe {timeframe!r}")
        iv, _step, max_days = INTERVALS[timeframe]
        now = self.milliseconds()
        since_ms = since if since is not None else now - max_days * 86_400_000
        days = min(max_days, max(1, int((now - since_ms) / 86_400_000) + 1))
        response = await self._client.get(
            CHART_URL.format(symbol=symbol), params={"interval": iv, "range": f"{days}d"})
        response.raise_for_status()
        bars = parse_chart(response.json(), timeframe, now)
        return [b for b in bars if b[0] >= since_ms]

    async def fetch_snapshot(self, symbol: str) -> dict[str, Any]:
        response = await self._client.get(
            CHART_URL.format(symbol=symbol), params={"interval": "1h", "range": "5d"})
        response.raise_for_status()
        return _result(response.json())

    async def close(self) -> None:
        await self._client.aclose()