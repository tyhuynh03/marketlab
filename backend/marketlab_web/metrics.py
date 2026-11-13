"""marketlab_web.metrics — do dac do lieu (risk/performance) dung pandas.

Quy uoc dinh nghia (phai khop voi test oracle):
  log return     r_t = ln(P_t / P_{t-1})
  total return   P_end / P_start - 1
  volatility     std(r, ddof=1) * sqrt(periods_per_year)          -> annual hoa
  max drawdown   min over t of (P_t / running_max(P)_t - 1)        -> am
  sharpe         mean(r) / std(r, ddof=1) * sqrt(periods_per_year)
  sortino        mean(r) / downside_dev(r) * sqrt(periods_per_year)
  calmar         annualized_return / abs(max_drawdown)
"""
from __future__ import annotations

import math
from typing import Any, Sequence

import pandas as pd

PERIODS_PER_YEAR = {"1m": 525_600, "5m": 105_120, "15m": 35_040,
                    "1h": 8_760, "4h": 2_190, "1d": 365, "1w": 52}


def closes(candles: Sequence[dict[str, Any]]) -> pd.Series:
    if not candles:
        return pd.Series([], dtype="float64")
    return pd.Series([c["close"] for c in candles], dtype="float64")


def log_returns(series: pd.Series) -> pd.Series:
    if len(series) < 2:
        return pd.Series([], dtype="float64")
    return series.pct_change().dropna().apply(math.log1p)


def total_return(series: pd.Series) -> float:
    if len(series) < 2 or series.iloc[0] == 0:
        return 0.0
    return float(series.iloc[-1] / series.iloc[0] - 1.0)


def annualized_return(series: pd.Series, periods_per_year: float) -> float:
    n = len(series)
    if n < 2 or series.iloc[0] <= 0:
        return 0.0
    growth = series.iloc[-1] / series.iloc[0]
    if growth <= 0:
        return -1.0
    return float(growth ** (periods_per_year / (n - 1)) - 1.0)


def volatility(series: pd.Series, periods_per_year: float) -> float:
    r = log_returns(series)
    if len(r) < 2:
        return 0.0
    return float(r.std(ddof=1) * math.sqrt(periods_per_year))


def max_drawdown(series: pd.Series) -> float:
    if series.empty:
        return 0.0
    peak = series.cummax()
    return float((series / peak - 1.0).min())


def sharpe(series: pd.Series, periods_per_year: float, risk_free: float = 0.0) -> float:
    r = log_returns(series)
    if len(r) < 2:
        return 0.0
    excess = r - risk_free / periods_per_year
    sd = excess.std(ddof=1)
    if sd == 0:
        return 0.0
    return float(excess.mean() / sd * math.sqrt(periods_per_year))


def downside_deviation(r: pd.Series) -> float:
    neg = r.clip(upper=0.0)
    if neg.empty:
        return 0.0
    return float(math.sqrt((neg ** 2).mean()))


def sortino(series: pd.Series, periods_per_year: float, risk_free: float = 0.0) -> float:
    r = log_returns(series)
    if len(r) < 2:
        return 0.0
    dd = downside_deviation(r - risk_free / periods_per_year)
    if dd == 0:
        return 0.0
    return float(r.mean() / dd * math.sqrt(periods_per_year))


def calmar(series: pd.Series, periods_per_year: float) -> float:
    mdd = max_drawdown(series)
    if mdd == 0:
        return 0.0
    return float(annualized_return(series, periods_per_year) / abs(mdd))


def summary(candles: Sequence[dict[str, Any]], timeframe: str) -> dict[str, Any]:
    series = closes(candles)
    ppy = PERIODS_PER_YEAR.get(timeframe)
    if ppy is None:
        raise ValueError(f"khong ro periods_per_year cho timeframe {timeframe!r}")
    if len(series) < 2:
        return {"observations": int(len(series)), "error": "can it nhat 2 nen"}
    return {
        "observations": int(len(series)),
        "first_close": float(series.iloc[0]),
        "last_close": float(series.iloc[-1]),
        "total_return": total_return(series),
        "annualized_return": annualized_return(series, ppy),
        "max_drawdown": max_drawdown(series),
        "volatility": volatility(series, ppy),
        "sharpe": sharpe(series, ppy),
        "sortino": sortino(series, ppy),
        "calmar": calmar(series, ppy),
    }


# Chi bao dang chuoi cho tool get_indicator_series. Moi cai dung lai dinh nghia
# trong module nay tren cua so truot, khong them dinh nghia moi.
INDICATORS = ("sma", "ema", "volatility", "drawdown")


def series(candles: Sequence[dict[str, Any]], timeframe: str, indicator: str,
           period: int) -> list[dict[str, Any]]:
    """Chuoi chi bao tren close; tra [{'ts', 'value'}] bo cac diem chua du cua so."""
    if indicator not in INDICATORS:
        raise ValueError(f"indicator {indicator!r} khong ho tro ({', '.join(INDICATORS)})")
    if not 2 <= int(period) <= 200:
        raise ValueError("period phai trong khoang 2..200")
    ppy = PERIODS_PER_YEAR.get(timeframe)
    if ppy is None:
        raise ValueError(f"khong ro periods_per_year cho timeframe {timeframe!r}")
    close = closes(candles)
    if indicator == "sma":
        values = close.rolling(int(period)).mean()
    elif indicator == "ema":
        values = close.ewm(span=int(period), adjust=False).mean()
    elif indicator == "volatility":
        values = log_returns(close).rolling(int(period)).std(ddof=1) * math.sqrt(ppy)
    else:  # drawdown
        values = close / close.rolling(int(period)).max() - 1.0
    out: list[dict[str, Any]] = []
    for idx, value in values.items():
        if value is None or value != value:  # NaN
            continue
        out.append({"ts": candles[int(idx)]["ts"], "value": float(value)})
    return out
