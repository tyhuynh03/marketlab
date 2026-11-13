"""Chuan hoa symbol va bien gioi cua POST/DELETE /api/watchlist (khong cham DB/mang)."""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from marketlab_web import api, db


@pytest.mark.parametrize("raw,expected", [
    ("BTC/USDT", "BTC/USDT"),
    ("btc/usdt", "BTC/USDT"),
    ("  sol  ", "SOL/USDT"),
    ("eth", "ETH/USDT"),
    ("BTC/USDC", "BTC/USDC"),
    ("1000PEPE/USDT", "1000PEPE/USDT"),
])
def test_normalize_symbol_accepts_real_pairs(raw, expected):
    assert db.normalize_symbol(raw) == expected


@pytest.mark.parametrize("raw", [
    "", "/", "BTC/", "/USDT", "BTC-USD", "BTCUSDT:USDT", "../etc/passwd",
    "BTC/USDT; DROP TABLE candle", "BTC//USDT", "B", "BTC/USDT永续",
])
def test_normalize_symbol_rejects_junk(raw):
    with pytest.raises(ValueError):
        db.normalize_symbol(raw)


def test_normalize_symbol_error_is_readable_vietnamese():
    with pytest.raises(ValueError) as info:
        db.normalize_symbol("BTC-USD")
    message = str(info.value)
    assert "không hợp lệ" in message and "ví dụ BTC/USDT" in message


@pytest.fixture
def settings_only(monkeypatch):
    """Route phai tu choi symbol rac truoc khi mo exchange hay cham pool."""
    monkeypatch.setattr(api.app.state, "settings",
                        SimpleNamespace(venue="binance", base_timeframe="1h", history_days=120),
                        raising=False)

    async def boom(*_args, **_kwargs):
        raise AssertionError("khong duoc cham mang/DB khi symbol khong hop le")

    monkeypatch.setattr(api.ingest, "open_exchange", boom)


@pytest.mark.asyncio
async def test_add_symbol_rejects_bad_symbol_before_network(settings_only):
    with pytest.raises(HTTPException) as exc:
        await api.add_symbol(api.WatchlistIn(symbol="BTC-USD"))
    assert exc.value.status_code == 422


@pytest.mark.asyncio
async def test_remove_symbol_rejects_bad_symbol_before_db(settings_only):
    with pytest.raises(HTTPException) as exc:
        await api.remove_symbol(symbol="../etc/passwd")
    assert exc.value.status_code == 422