"""Oracle + 6 test enforce hop dong backtest (docs/strategy-contract.md).

Engine thuan (C4) nen test khong cham DB/mang: truyen thang chuoi nen tong hop.
Moi fill doi chieu bang Decimal tinh tay lai tu nhat ky (R8), khong tin engine.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP

import pytest

from marketlab_web import backtest, metrics
from marketlab_web.portfolio import FEE_RATE, INITIAL_CAPITAL, Q8, SLIPPAGE

T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
HOUR = timedelta(hours=1)
CAP = Decimal(INITIAL_CAPITAL)


def mkbar(i: int, open_: float, close: float, ts: datetime | None = None) -> backtest.Bar:
    return {"ts": ts or (T0 + i * HOUR), "open": float(open_),
            "high": float(max(open_, close)), "low": float(min(open_, close)),
            "close": float(close), "volume": 1000.0}


def q8h(x: Decimal) -> Decimal:
    return x.quantize(Q8, rounding=ROUND_HALF_UP)


class FixedWeight:
    name = "fixed"

    def __init__(self, w: float, once: bool = True) -> None:
        self.w = w
        self.once = once
        self.fired = False

    def on_bar(self, history, weight):
        if self.once and self.fired:
            return None
        self.fired = True
        return self.w


class SeqStrategy:
    name = "seq"

    def __init__(self, weights: list) -> None:
        self.weights = weights
        self.i = 0

    def on_bar(self, history, weight):
        w = self.weights[self.i] if self.i < len(self.weights) else None
        self.i += 1
        return w


class Spy:
    name = "spy"

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def on_bar(self, history, weight):
        self.calls.append({"n": len(history), "last_ts": history[-1]["ts"], "weight": weight})
        return None


# --- Test 1 (C1): engine chi truyen prefix candles[:i+1], khong look-ahead ---

def test_engine_passes_only_closed_prefix_no_lookahead():
    candles = [mkbar(i, 100, 100 + i) for i in range(5)]
    spy = Spy()
    backtest.run(candles, spy)
    assert [c["n"] for c in spy.calls] == [1, 2, 3, 4, 5]
    assert [c["last_ts"] for c in spy.calls] == [c["ts"] for c in candles]
    assert spy.calls[0]["weight"] == 0.0  # luc dau flat


# --- Test 2 (R2/R4/R6/R8): oracle khop gia 3 nen, tinh tay tung fill ---

def test_fill_oracle_matches_hand_computed_decimal():
    candles = [mkbar(0, 100, 100), mkbar(1, 101, 102), mkbar(2, 103, 104)]
    res = backtest.run(candles, FixedWeight(0.5, once=True))
    assert len(res["fills"]) == 1
    f = res["fills"][0]

    open1 = Decimal("101")
    exec_price = q8h(open1 * (1 + SLIPPAGE))
    assert exec_price == Decimal("101.0505")  # neo gia tri tinh tay
    delta = Decimal("0.5") * CAP            # equity0 = CAP, qty0 = 0
    desired = q8h(delta / exec_price)
    affordable = (CAP / (exec_price * (1 + FEE_RATE))).quantize(Q8, ROUND_DOWN)
    qty = min(desired, affordable)
    notional = q8h(qty * exec_price)
    fee = q8h(qty * exec_price * FEE_RATE)

    assert f["side"] == "buy"
    assert f["raw_open"] == 101.0
    assert f["exec_price"] == float(exec_price)
    assert f["qty"] == float(qty)
    assert f["fee"] == float(fee)
    assert f["notional"] == float(notional)
    assert f["signal_ts"] == candles[0]["ts"].isoformat()
    assert f["fill_ts"] == candles[1]["ts"].isoformat()  # R2: open nen i+1

    cash = CAP - notional - fee
    assert res["final"]["cash"] == float(cash)
    assert res["final"]["qty"] == float(qty)
    assert res["equity"][0]["equity"] == float(CAP)
    assert res["equity"][1]["equity"] == float(cash + qty * Decimal("102"))
    assert res["equity"][2]["equity"] == float(cash + qty * Decimal("104"))


# --- Test 3 (R3): ho phien My — tin hieu cuoi phien khop open phien ke tiep ---

def test_us_overnight_weekend_gap_fills_next_session_open():
    fri_close = datetime(2026, 1, 2, 20, 0, tzinfo=timezone.utc)   # 15:00 ET
    mon_open = datetime(2026, 1, 5, 14, 30, tzinfo=timezone.utc)   # 09:30 ET
    candles = [mkbar(0, 100, 100, ts=fri_close), mkbar(1, 105, 106, ts=mon_open)]
    res = backtest.run(candles, FixedWeight(0.5, once=True), venue="yahoo", timeframe="1h")
    f = res["fills"][0]
    assert f["signal_ts"] == fri_close.isoformat()
    assert f["fill_ts"] == mon_open.isoformat()
    assert f["raw_open"] == 105.0                      # gap 100 -> 105 la that
    assert f["exec_price"] == float(q8h(Decimal("105") * (1 + SLIPPAGE)))
    assert mon_open - fri_close > timedelta(days=2)    # khong noi suy cuoi tuan


# --- Test 4 (R2): cuoi kho — tin hieu nen cuoi bi bo + ghi log, equity khong doi ---

def test_last_bar_signal_dropped_and_logged():
    candles = [mkbar(i, 100 + i, 101 + i) for i in range(4)]
    res = backtest.run(candles, backtest.BuyHold())
    assert res["dropped_signals"][-1]["ts"] == candles[-1]["ts"].isoformat()
    assert all(f["signal_ts"] != candles[-1]["ts"].isoformat() for f in res["fills"])
    assert all(f["fill_ts"] != candles[-1]["ts"].isoformat() for f in res["fills"])
    assert res["equity"][-1]["equity"] == res["final"]["equity"]


# --- Test 5 (R7): kep trong so ngoai [0,1] + ghi log, khong ban khong ---

def test_weights_clamped_to_bounds_and_logged():
    candles = [mkbar(0, 100, 100), mkbar(1, 101, 102), mkbar(2, 103, 104)]
    res = backtest.run(candles, SeqStrategy([1.5, -0.2, None]))
    clamped = res["clamped_weights"]
    assert [(c["raw_weight"], c["weight"]) for c in clamped] == [(1.5, 1.0), (-0.2, 0.0)]
    assert any(f["side"] == "sell" for f in res["fills"])  # -0.2 -> 0.0 phai ban ra
    assert res["final"]["qty"] >= 0.0                      # khong ban khong
    assert res["final"]["cash"] >= 0.0
    assert all(p["equity"] > 0 for p in res["equity"])


# --- Test 6 (R9): benchmark = trong so hang 1.0, khong huong luat rieng ---

def test_benchmark_is_constant_weight_one_under_same_rules():
    candles = [mkbar(i, 100 + i, 101 + i) for i in range(6)]

    class ConstantOne:
        name = "const1"

        def on_bar(self, history, weight):
            return 1.0

    bh = backtest.run(candles, backtest.BuyHold())
    co = backtest.run(candles, ConstantOne())
    assert bh["equity"] == co["equity"]
    assert bh["fills"] == co["fills"]
    assert bh["metrics"] == co["metrics"]
    # fill dau khop open nen 1 dung R2/R4
    f0 = bh["fills"][0]
    assert f0["fill_ts"] == candles[1]["ts"].isoformat()
    assert f0["exec_price"] == float(q8h(Decimal(str(candles[1]["open"])) * (1 + SLIPPAGE)))
    assert bh["equity"][0]["equity"] == float(CAP)        # xuat phat flat
    assert bh["final"]["position_weight"] == pytest.approx(1.0, abs=1e-3)


# --- Oracle metrics: doi chieu doc lap tren equity curve ---

def test_equity_metrics_match_independent_oracle():
    candles = [mkbar(i, 100 + (i % 7) * 3, 101 + (i % 5) * 2) for i in range(40)]
    res = backtest.run(candles, backtest.SmaCross(3, 8))
    eq = [p["equity"] for p in res["equity"]]
    assert res["metrics"]["total_return"] == pytest.approx(eq[-1] / eq[0] - 1, abs=1e-9)
    peak, worst = eq[0], 0.0
    for v in eq:
        peak = max(peak, v)
        worst = min(worst, v / peak - 1)
    assert res["metrics"]["max_drawdown"] == pytest.approx(worst, abs=1e-9)
    ppy = metrics.periods_for("1h", "binance")
    assert res["ppy"] == ppy
    growth = eq[-1] / eq[0]
    assert res["metrics"]["annualized_return"] == pytest.approx(
        growth ** (ppy / (len(eq) - 1)) - 1, rel=1e-9)


# --- Oracle so cai: cash suy ra tu nhat ky fill phai khop va khong am (R8) ---

def test_cash_reconstructed_from_fill_journal_never_negative():
    candles = [mkbar(i, 100 + (i % 11) * 2, 101 + (i % 9) * 3) for i in range(60)]
    for strat in (backtest.BuyHold(), backtest.SmaCross(4, 10)):
        res = backtest.run(candles, strat)
        cash = CAP
        qty = Decimal(0)
        for f in res["fills"]:
            n, fee = Decimal(str(f["notional"])), Decimal(str(f["fee"]))
            q = Decimal(str(f["qty"]))
            if f["side"] == "buy":
                cash -= n + fee
                qty += q
            else:
                cash += n - fee
                qty -= q
            assert cash >= 0, "overspend: cash am"
            assert qty >= 0, "ban khong: qty am"
        assert float(cash) == pytest.approx(res["final"]["cash"], abs=1e-6)
        assert float(qty) == pytest.approx(res["final"]["qty"], abs=1e-8)


# --- C4: ham thuan — cung input ra cung output ---

def test_run_is_deterministic_and_pure():
    candles = [mkbar(i, 100 + (i % 6), 101 + (i % 4)) for i in range(30)]
    r1 = backtest.run(candles, backtest.SmaCross(3, 7))
    r2 = backtest.run(candles, backtest.SmaCross(3, 7))
    assert r1 == r2


# --- SmaCross: warmup + huong tin hieu ---

def test_sma_cross_warmup_and_direction():
    s = backtest.SmaCross(2, 3)
    assert s.on_bar([mkbar(0, 1, 1), mkbar(1, 1, 2)], 0.0) is None  # len < slow
    up = [mkbar(i, 1, 10 + i) for i in range(5)]
    down = [mkbar(i, 1, 10 - i) for i in range(5)]
    assert s.on_bar(up, 0.0) == 1.0
    assert s.on_bar(down, 0.0) == 0.0
    with pytest.raises(ValueError):
        backtest.SmaCross(5, 5)


def test_run_rejects_short_series():
    with pytest.raises(ValueError):
        backtest.run([mkbar(0, 1, 1)], backtest.BuyHold())