"""Oracle test: moi ham trong metrics.py phai khop mot cach doc lap.

Cach doi chieu (khong tin ham duoc do, cung khong tin test cua chinh no):
  1. Tinh lai bang `statistics` thuan (duong loi khac hoan toan voi pandas).
  2. Doi chieu max_drawdown voi quantstats — thu vien chuan cua nganh.
"""
from __future__ import annotations

import math
import statistics

import pandas as pd
import pytest

from marketlab_web import metrics

SERIES = [100.0, 110.0, 90.0, 95.0, 120.0]
PPY_DAILY = 365.0


@pytest.fixture
def s() -> pd.Series:
    return pd.Series(SERIES, dtype="float64")


def _oracle_log_returns() -> list[float]:
    return [math.log(SERIES[i] / SERIES[i - 1]) for i in range(1, len(SERIES))]


def test_total_return_matches_oracle(s):
    assert metrics.total_return(s) == pytest.approx(0.20, abs=1e-12)


def test_max_drawdown_matches_oracle(s):
    peak, worst = SERIES[0], 0.0
    for price in SERIES:
        peak = max(peak, price)
        worst = min(worst, price / peak - 1.0)
    assert metrics.max_drawdown(s) == pytest.approx(worst, abs=1e-12)
    assert worst == pytest.approx(90.0 / 110.0 - 1.0, abs=1e-12)


def test_volatility_uses_sample_std_and_annualises(s):
    r = _oracle_log_returns()
    expected = statistics.stdev(r) * math.sqrt(PPY_DAILY)
    assert metrics.volatility(s, PPY_DAILY) == pytest.approx(expected, rel=1e-9)


def test_sharpe_matches_oracle(s):
    r = _oracle_log_returns()
    expected = statistics.mean(r) / statistics.stdev(r) * math.sqrt(PPY_DAILY)
    assert metrics.sharpe(s, PPY_DAILY) == pytest.approx(expected, rel=1e-9)


def test_sortino_only_pens_downside(s):
    r = _oracle_log_returns()
    downside = math.sqrt(sum(min(x, 0.0) ** 2 for x in r) / len(r))
    expected = statistics.mean(r) / downside * math.sqrt(PPY_DAILY)
    assert metrics.sortino(s, PPY_DAILY) == pytest.approx(expected, rel=1e-9)
    # Sortino > Sharpe khi phan thuong am it hon toan bo rui ro.
    assert metrics.sortino(s, PPY_DAILY) > metrics.sharpe(s, PPY_DAILY)


def test_calmar_matches_oracle(s):
    annualised = (SERIES[-1] / SERIES[0]) ** (PPY_DAILY / (len(SERIES) - 1)) - 1.0
    peak, worst = SERIES[0], 0.0
    for price in SERIES:
        peak = max(peak, price)
        worst = min(worst, price / peak - 1.0)
    assert metrics.calmar(s, PPY_DAILY) == pytest.approx(annualised / abs(worst), rel=1e-9)


def test_metrics_agree_with_quantstats_max_drawdown(s):
    quantstats = pytest.importorskip("quantstats")
    returns = s.pct_change().dropna()
    assert metrics.max_drawdown(s) == pytest.approx(
        quantstats.stats.max_drawdown(returns), abs=1e-9)


def test_log_returns_reject_short_series():
    assert metrics.log_returns(pd.Series([100.0])).empty
    assert metrics.volatility(pd.Series([100.0]), 365.0) == 0.0
    assert metrics.summary([{"close": 100.0}], "1d")["error"] == "can it nhat 2 nen"


def test_summary_reports_the_documented_conventions():
    candles = [{"close": c} for c in SERIES]
    out = metrics.summary(candles, "1d")
    assert out["observations"] == 5
    assert out["first_close"] == 100.0
    assert out["last_close"] == 120.0
    assert out["total_return"] == pytest.approx(0.20, abs=1e-12)
    assert out["max_drawdown"] == pytest.approx(90 / 110 - 1, abs=1e-12)


def test_summary_rejects_unknown_timeframe():
    with pytest.raises(ValueError):
        metrics.summary([{"close": 1.0}, {"close": 2.0}], "13m")
