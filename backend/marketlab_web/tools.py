"""marketlab_web.tools — 4 tool doc-only cho agent buoc 2.

Moi tool chi doc du lieu da co trong kho; khong dat lenh, khong goi mang. Ket qua
tra JSON gon (nen rut gon, so lam tron) de giu context cua model nho. Tinh nang
(pandas) chay trong threadpool; connection DB chi giu trong luc truy van.
"""
from __future__ import annotations

import json
import logging
from typing import Any

import anyio

from marketlab_web import db, metrics

log = logging.getLogger("marketlab.tools")

TIMEFRAMES = ("1h", "4h", "1d")
MAX_CANDLES_PER_CALL = 120
MAX_WATCHLIST = 30
MAX_INDICATOR_POINTS = 60
SUMMARY_WINDOW = 500

TOOL_SPECS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "get_watchlist",
            "description": "Danh sách symbol đang theo dõi kèm giá đóng gần nhất và delta.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_summary",
            "description": "Chỉ số tổng hợp (total return, max drawdown, volatility, Sharpe, "
                           "Sortino, Calmar) trên tối đa 500 nến đã đóng.",
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {"type": "string", "description": "Dạng BTC/USDT"},
                    "timeframe": {"type": "string", "enum": list(TIMEFRAMES)},
                },
                "required": ["symbol", "timeframe"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_candles",
            "description": "Nến đã đóng gần nhất, mỗi dòng [thời_gian, open, high, low, close, "
                           "volume], mới nhất ở cuối.",
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {"type": "string", "description": "Dạng BTC/USDT"},
                    "timeframe": {"type": "string", "enum": list(TIMEFRAMES)},
                    "limit": {"type": "integer", "minimum": 2,
                              "maximum": MAX_CANDLES_PER_CALL, "default": 60},
                },
                "required": ["symbol", "timeframe"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_indicator_series",
            "description": "Chuỗi chỉ báo trên close: sma, ema, volatility (annual hoá), "
                           "drawdown; trả tối đa 60 điểm gần nhất.",
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {"type": "string", "description": "Dạng BTC/USDT"},
                    "timeframe": {"type": "string", "enum": list(TIMEFRAMES)},
                    "indicator": {"type": "string", "enum": list(metrics.INDICATORS)},
                    "period": {"type": "integer", "minimum": 2, "maximum": 200,
                               "default": 14},
                },
                "required": ["symbol", "timeframe", "indicator"],
            },
        },
    },
]

TOOL_NAMES = tuple(spec["function"]["name"] for spec in TOOL_SPECS)


def _num(value: Any, digits: int = 6) -> float | None:
    if value is None:
        return None
    return float(f"{float(value):.{digits}g}")


def _stamp(ts: Any) -> str:
    return str(ts)[:16].replace("T", " ")


def _timeframe(raw: Any) -> str:
    timeframe = str(raw or "").strip()
    if timeframe not in TIMEFRAMES:
        raise ValueError(f"khung {timeframe!r} không được hỗ trợ ({', '.join(TIMEFRAMES)})")
    return timeframe


def _limit(raw: Any, default: int, maximum: int) -> int:
    try:
        value = default if raw is None else int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("limit phải là số nguyên") from exc
    if value < 2:
        raise ValueError("limit phải >= 2")
    return min(value, maximum)


async def _load(pool: Any, settings: Any, symbol: str, timeframe: str,
                limit: int) -> list[dict[str, Any]]:
    view = db.ROLLUP_VIEWS.get(timeframe)
    if view:
        return await db.fetch_rollup(pool, view, settings.venue, symbol, limit)
    return await db.fetch_candles(pool, settings.venue, symbol, timeframe, limit)


def compact_candles(rows: list[dict[str, Any]]) -> list[list[Any]]:
    return [
        [_stamp(r["ts"]), _num(r["open"], 8), _num(r["high"], 8), _num(r["low"], 8),
         _num(r["close"], 8), _num(r["volume"], 6)]
        for r in rows
    ]


async def get_watchlist(pool: Any, settings: Any, _args: dict[str, Any]) -> dict[str, Any]:
    entries = await db.fetch_watchlist(pool)
    return {
        "count": len(entries),
        "entries": [
            {
                "symbol": e["symbol"], "timeframe": e["timeframe"],
                "last_close": _num(e["last_close"], 8), "delta": _num(e["delta"], 4),
                "candles": e["candles"],
            }
            for e in entries[:MAX_WATCHLIST]
        ],
    }


async def get_summary(pool: Any, settings: Any, args: dict[str, Any]) -> dict[str, Any]:
    symbol = db.normalize_symbol(str(args.get("symbol") or ""))
    timeframe = _timeframe(args.get("timeframe"))
    rows = await _load(pool, settings, symbol, timeframe, SUMMARY_WINDOW)
    if len(rows) < 2:
        raise ValueError(f"thiếu dữ liệu cho {symbol} {timeframe}")
    summary = await anyio.to_thread.run_sync(metrics.summary, rows, timeframe)
    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "summary": {key: (_num(value) if isinstance(value, float) else value)
                    for key, value in summary.items()},
    }


async def get_candles(pool: Any, settings: Any, args: dict[str, Any]) -> dict[str, Any]:
    symbol = db.normalize_symbol(str(args.get("symbol") or ""))
    timeframe = _timeframe(args.get("timeframe"))
    limit = _limit(args.get("limit"), 60, MAX_CANDLES_PER_CALL)
    rows = await _load(pool, settings, symbol, timeframe, limit)
    if len(rows) < 2:
        raise ValueError(f"thiếu dữ liệu cho {symbol} {timeframe}")
    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "count": len(rows),
        "rows": compact_candles(rows),
    }


async def get_indicator_series(pool: Any, settings: Any,
                               args: dict[str, Any]) -> dict[str, Any]:
    symbol = db.normalize_symbol(str(args.get("symbol") or ""))
    timeframe = _timeframe(args.get("timeframe"))
    indicator = str(args.get("indicator") or "").strip()
    if indicator not in metrics.INDICATORS:
        raise ValueError(
            f"indicator {indicator!r} không hỗ trợ ({', '.join(metrics.INDICATORS)})")
    period = _limit(args.get("period"), 14, 200)
    if period < 2:
        raise ValueError("period phải >= 2")
    window = min(SUMMARY_WINDOW, max(int(period) * 2, int(period) + MAX_INDICATOR_POINTS))
    rows = await _load(pool, settings, symbol, timeframe, window)
    if len(rows) < period + 1:
        raise ValueError(f"thiếu dữ liệu cho {symbol} {timeframe} (cần > {period} nến)")
    points = await anyio.to_thread.run_sync(
        metrics.series, rows, timeframe, indicator, period)
    points = points[-MAX_INDICATOR_POINTS:]
    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "indicator": indicator,
        "period": period,
        "points": [[_stamp(p["ts"]), _num(p["value"])] for p in points],
    }


HANDLERS = {
    "get_watchlist": get_watchlist,
    "get_summary": get_summary,
    "get_candles": get_candles,
    "get_indicator_series": get_indicator_series,
}


async def execute(pool: Any, settings: Any, name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Chay mot tool. Loi tham so/truy van tra ve cho model thay vi lam sap run."""
    handler = HANDLERS.get(name)
    if handler is None:
        return {"error": f"tool {name!r} không tồn tại"}
    try:
        return await handler(pool, settings, args)
    except ValueError as exc:
        return {"error": str(exc)}
    except Exception as exc:  # noqa: BLE001 — kho loi khong duoc lam mat run
        log.warning("tool %s loi: %s", name, type(exc).__name__)
        return {"error": f"tool {name} lỗi tạm thời"}


def parse_args(raw: Any) -> dict[str, Any]:
    """arguments la chuoi JSON do model sinh; hong thi coi nhu khong co tham so."""
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}
