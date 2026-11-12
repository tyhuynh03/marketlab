"""marketlab_web.backtest — engine backtest lat cat 1, thuan theo hop dong.

Tuan thu docs/strategy-contract.md (C1-C4, R1-R10):
  * C1: engine goi strategy.on_bar(history=candles[:i+1], weight) — chi nen DA DONG,
    khong look-ahead. Prefix cat nen i+1 nen strategy khong the doc tuong lai.
  * C2: strategy tra trong so muc tieu [0,1] hoac None = giu nguyen vi the.
  * C3: engine giu so cash/qty/cost/equity; strategy chi giu state rieng (SMA).
  * C4: ham thuan — khong DB, khong mang, khong dong ho tuong.
  * R2: khop tai open nen i+1; cuoi kho khong co i+1 -> bo tin hieu + ghi log.
  * R3: ho phien My that (nen i+1 la nen dau phien ke tiep), khong noi suy.
  * R4: truot 0.05% + phi 0.1% moi chieu — dung hang so so paper.
  * R6: notional muc tieu = trong so × equity mark tai close nen i; q8; le cent o lai cash.
  * R7: khong ban khong/don bay — trong so kep [0,1], sell khong qua vi the.
  * R8: nhat ky khop tung fill de oracle doi chieu.
  * R9: buy-and-hold la strategy trong so hang 1.0, khop cung luat.

`weight` truyen vao on_bar = trong so vi the hien tai (qty*close/equity) tai close nen i.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal, ROUND_DOWN
from typing import Any, Protocol, Sequence, TypedDict

import pandas as pd

from marketlab_web import metrics
from marketlab_web.portfolio import FEE_RATE, INITIAL_CAPITAL, Q8, SLIPPAGE, q8

DUST_NOTIONAL = Decimal("1")  # duoi 1 USDT notional: bo qua nhu so paper


class Bar(TypedDict):
    ts: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float


class Strategy(Protocol):
    def on_bar(self, history: Sequence[Bar], weight: float) -> float | None:
        """Tra trong so muc tieu [0, 1] hoac None = giu nguyen vi the."""
        ...


class BuyHold:
    """Benchmark R9: trong so hang 1.0, khop cung R2-R6."""

    name = "buy_hold"

    def on_bar(self, history: Sequence[Bar], weight: float) -> float | None:
        return 1.0


class SmaCross:
    """SMA fast cat SMA slow: fast > slow -> long (1.0), nguoc lai flat (0.0).

    Stateless theo history (C4): chi doc closes cua prefix, khong dung dong ho/DB.
    """

    name = "sma_cross"

    def __init__(self, fast: int = 10, slow: int = 30) -> None:
        if fast >= slow:
            raise ValueError("fast phai < slow")
        self.fast = fast
        self.slow = slow

    def on_bar(self, history: Sequence[Bar], weight: float) -> float | None:
        if len(history) < self.slow:
            return None  # warmup: chua du nen slow, giu nguyen (flat luc dau)
        closes = [b["close"] for b in history]
        fast = sum(closes[-self.fast:]) / self.fast
        slow = sum(closes[-self.slow:]) / self.slow
        return 1.0 if fast > slow else 0.0


def _exec_price(raw_open: float, side: str) -> Decimal:
    o = Decimal(str(raw_open))
    return q8(o * (1 + SLIPPAGE) if side == "buy" else o * (1 - SLIPPAGE))


def _buy_qty(delta: Decimal, exec_price: Decimal, cash: Decimal) -> Decimal:
    """q8 nhu so paper (HALF_UP), chan tren boi luong vua tien mat (floor q8)."""
    desired = q8(delta / exec_price)
    affordable = (cash / (exec_price * (1 + FEE_RATE))).quantize(Q8, ROUND_DOWN)
    q = min(desired, affordable)
    # Bien rounding cho asset gia rat nho: ha tung q8 de notional+fee khong vuot cash.
    while q > 0 and q8(q * exec_price) + q8(q * exec_price * FEE_RATE) > cash:
        q -= Q8
    return q


def _json_fill(f: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in f.items():
        if isinstance(v, datetime):
            out[k] = v.isoformat()
        elif isinstance(v, Decimal):
            out[k] = float(v)
        else:
            out[k] = v
    return out


def run(candles: Sequence[Bar], strategy: Strategy, *,
        initial_capital: Decimal = INITIAL_CAPITAL,
        venue: str = "binance", timeframe: str = "1h") -> dict[str, Any]:
    """Backtest thuan: nhan chuoi nen da dong + strategy, tra equity/fills/metrics.

    Khong cham DB/mang (C4). Dung chuoi nay cho ca strategy lan benchmark (R9).
    """
    n = len(candles)
    if n < 2:
        raise ValueError("can it nhat 2 nen da dong de backtest")
    ppy = metrics.periods_for(timeframe, venue)

    cash = Decimal(initial_capital)
    qty = Decimal(0)
    cost = Decimal(0)
    equity_pts: list[dict[str, Any]] = []
    fills: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    clamped: list[dict[str, Any]] = []

    for i in range(n):
        bar = candles[i]
        close_i = Decimal(str(bar["close"]))
        equity_i = cash + qty * close_i
        cur_w = float(qty * close_i / equity_i) if equity_i > 0 else 0.0
        equity_pts.append({"ts": bar["ts"], "equity": equity_i, "weight": cur_w})

        target = strategy.on_bar(candles[:i + 1], cur_w)
        if target is None:
            continue
        raw_w = float(target)
        w = min(1.0, max(0.0, raw_w))
        if w != raw_w:
            clamped.append({"ts": bar["ts"], "raw_weight": raw_w, "weight": w})

        if i + 1 >= n:  # R2: cuoi kho, khong co nen i+1 de khop
            dropped.append({"ts": bar["ts"], "weight": w,
                            "reason": "cuoi kho — khong co nen i+1 de khop"})
            continue

        nxt = candles[i + 1]
        target_notional = Decimal(str(w)) * equity_i
        delta = target_notional - qty * close_i
        if delta == 0:
            continue
        side = "buy" if delta > 0 else "sell"
        exec_price = _exec_price(nxt["open"], side)
        if side == "buy":
            q = _buy_qty(delta, exec_price, cash)
        else:
            q = min(q8(-delta / exec_price), qty)  # R7: khong ban qua vi the
        if q <= 0:
            continue
        notional = q8(q * exec_price)
        if notional < DUST_NOTIONAL:
            continue
        fee = q8(q * exec_price * FEE_RATE)

        if side == "buy":
            cash -= notional + fee
            qty += q
            cost += notional
        else:
            avg = cost / qty if qty > 0 else Decimal(0)
            cash += notional - fee
            cost -= q8(q * avg)
            qty -= q
        fills.append({"signal_ts": bar["ts"], "fill_ts": nxt["ts"], "side": side,
                      "raw_open": nxt["open"], "exec_price": exec_price,
                      "qty": q, "fee": fee, "notional": notional})

    eq_series = pd.Series([float(p["equity"]) for p in equity_pts], dtype="float64")
    dd = eq_series / eq_series.cummax() - 1.0
    points = [{"ts": p["ts"].isoformat(), "equity": float(p["equity"]),
               "weight": p["weight"], "dd": float(d)}
              for p, d in zip(equity_pts, dd)]
    last_close = Decimal(str(candles[-1]["close"]))
    final_equity = cash + qty * last_close
    return {
        "strategy": getattr(strategy, "name", type(strategy).__name__),
        "venue": venue, "timeframe": timeframe, "ppy": ppy,
        "initial_capital": float(initial_capital),
        "observations": n,
        "equity": points,
        "metrics": {
            "total_return": metrics.total_return(eq_series),
            "annualized_return": metrics.annualized_return(eq_series, ppy),
            "max_drawdown": metrics.max_drawdown(eq_series),
            "volatility": metrics.volatility(eq_series, ppy),
            "sharpe": metrics.sharpe(eq_series, ppy),
            "sortino": metrics.sortino(eq_series, ppy),
            "calmar": metrics.calmar(eq_series, ppy),
        },
        "fills": [_json_fill(f) for f in fills],
        "dropped_signals": [{"ts": d["ts"].isoformat(), "weight": d["weight"],
                             "reason": d["reason"]} for d in dropped],
        "clamped_weights": [{"ts": c["ts"].isoformat(), "raw_weight": c["raw_weight"],
                             "weight": c["weight"]} for c in clamped],
        "final": {"cash": float(cash), "qty": float(qty), "equity": float(final_equity),
                  "position_weight": float(qty * last_close / final_equity) if final_equity > 0 else 0.0},
    }


def _window_metrics(points: Sequence[dict[str, Any]], ppy: float) -> dict[str, float]:
    """Do chi so tren mot cua so con cua equity curve (dung cung oracle metrics)."""
    eq = pd.Series([p["equity"] for p in points], dtype="float64")
    return {
        "total_return": metrics.total_return(eq),
        "annualized_return": metrics.annualized_return(eq, ppy),
        "max_drawdown": metrics.max_drawdown(eq),
        "volatility": metrics.volatility(eq, ppy),
        "sharpe": metrics.sharpe(eq, ppy),
        "sortino": metrics.sortino(eq, ppy),
        "calmar": metrics.calmar(eq, ppy),
    }


def run_oos(candles: Sequence[Bar], strategy: Strategy, *, oos: float = 0.3,
            initial_capital: Decimal = INITIAL_CAPITAL,
            venue: str = "binance", timeframe: str = "1h") -> dict[str, Any]:
    """Holdout chong overfit (Phase 2): chia chuoi theo THOI GIAN, khong tron.

    Chay strategy + benchmark BuyHold MOT LAN tren toan chuoi (vi the lien tuc,
    khong reset o ranh gioi), roi do chi so tren hai cua so con:
      * in-sample     = (1-oos) nen dau,
      * out-of-sample = oos nen cuoi, neo von tai equity close nen train cuoi.

    Vi sao lien tuc thay vi chay lai tung doan: strategy khong phai warmup lai
    trong cua so test. Khi test ngan hon `slow` (kho nen it), chay lai tung doan
    se nam phang suot -> OOS 0% gia tao. Lien tuc cho so lieu that ngay ca khi
    kho nen ngan. Tham so co dinh tu train; OOS do tren du lieu chua tung tune.

    Khong cham DB/mang (C4). n_fills dem lenh co signal trong moi cua so de
    phan biet "phang do tin hieu" voi "khong giao dich".
    """
    n = len(candles)
    if n < 4:
        raise ValueError("can it nhat 4 nen de chia train/test")
    if not (0.0 < oos < 1.0):
        raise ValueError("oos phai trong khoang (0, 1)")
    n_test = max(2, min(n - 2, int(round(n * oos))))
    n_train = n - n_test
    ppy = metrics.periods_for(timeframe, venue)
    s = run(candles, strategy, initial_capital=initial_capital, venue=venue, timeframe=timeframe)
    b = run(candles, BuyHold(), initial_capital=initial_capital, venue=venue, timeframe=timeframe)
    boundary_ts = candles[n_train]["ts"].isoformat()

    def split(full: dict[str, Any]) -> dict[str, Any]:
        eq = full["equity"]
        fills = full["fills"]
        return {
            "in_sample": {"metrics": _window_metrics(eq[:n_train], ppy),
                          "n_fills": sum(1 for f in fills if f["signal_ts"] < boundary_ts)},
            # neo tai close nen train cuoi (n_train-1) de total_return cua test co goc
            "out_of_sample": {"metrics": _window_metrics(eq[n_train - 1:], ppy),
                              "n_fills": sum(1 for f in fills if f["signal_ts"] >= boundary_ts)},
        }

    sw, bw = split(s), split(b)
    return {
        "oos_fraction": oos,
        "train_bars": n_train,
        "test_bars": n_test,
        "boundary_ts": boundary_ts,
        "train_start_ts": candles[0]["ts"].isoformat(),
        "test_end_ts": candles[-1]["ts"].isoformat(),
        "in_sample": {"observations": n_train, "metrics": sw["in_sample"]["metrics"],
                      "benchmark_metrics": bw["in_sample"]["metrics"],
                      "n_fills": sw["in_sample"]["n_fills"]},
        "out_of_sample": {"observations": n_test, "metrics": sw["out_of_sample"]["metrics"],
                          "benchmark_metrics": bw["out_of_sample"]["metrics"],
                          "n_fills": sw["out_of_sample"]["n_fills"]},
    }