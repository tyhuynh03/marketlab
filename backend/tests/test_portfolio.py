"""Hoi quy loi so cai: khoa ghi, mark khoi diem cua equity, seed vuot kho, thu tu so tien mat.

Dung connection gia de khong cham DB/mang, theo cung convention voi test_ingest.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

import pytest

from marketlab_web import portfolio

HOUR = timedelta(hours=1)
T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


class _Tx:
    def __init__(self, conn: "FakeConn") -> None:
        self.conn = conn

    async def __aenter__(self) -> "_Tx":
        self.conn.log.append("BEGIN")
        return self

    async def __aexit__(self, *_exc: Any) -> bool:
        self.conn.log.append("COMMIT")
        return False


class _Acquire:
    def __init__(self, conn: "FakeConn") -> None:
        self.conn = conn

    async def __aenter__(self) -> "FakeConn":
        return self.conn

    async def __aexit__(self, *_exc: Any) -> bool:
        return False


class FakeConn:
    """Ghi lai moi cau SQL theo thu tu; handler tra ket qua theo tung cau."""

    def __init__(self, handler) -> None:
        self.handler = handler
        self.calls: list[tuple[str, str, tuple]] = []
        self.log: list[str] = []
        self.inserts: list[dict[str, Any]] = []

    def _record(self, method: str, sql: str, args: tuple) -> Any:
        self.calls.append((method, sql, args))
        self.log.append(sql.split()[0] + " " + sql.split()[1] if len(sql.split()) > 1 else sql)
        return self.handler(method, sql, args)

    async def fetch(self, sql, *args):
        return self._record("fetch", sql, args)

    async def fetchrow(self, sql, *args):
        return self._record("fetchrow", sql, args)

    async def fetchval(self, sql, *args):
        return self._record("fetchval", sql, args)

    async def execute(self, sql, *args):
        return self._record("execute", sql, args)

    async def executemany(self, sql, args):
        return self._record("executemany", sql, args)

    def transaction(self) -> _Tx:
        return _Tx(self)

    def sqls(self) -> list[str]:
        return [c[1] for c in self.calls]

    def index(self, fragment: str) -> int:
        return next(i for i, s in enumerate(self.sqls()) if fragment in s)


class FakePool:
    def __init__(self, conn: FakeConn) -> None:
        self.conn = conn

    def acquire(self) -> _Acquire:
        return _Acquire(self.conn)


def fill_row(args: tuple) -> dict[str, Any]:
    keys = ("ts", "kind", "symbol", "qty", "price", "fee", "realized", "source", "idem_key", "note")
    return dict(zip(keys, args)) | {"id": "00000000-0000-0000-0000-000000000001"}


def cash_rows(cash: str = "100000", positions: dict[str, tuple[str, str]] | None = None):
    rows = [{"account": "CASH", "unit": "USDT", "amount": Decimal(cash)}]
    for sym, (qty, cost) in (positions or {}).items():
        rows.append({"account": f"POS:{sym}", "unit": sym, "amount": Decimal(qty)})
        rows.append({"account": f"COST:{sym}", "unit": "USDT", "amount": Decimal(cost)})
    return rows


# --- Loi 1: doc state roi ghi trong READ COMMITTED khong khoa -> tieu qua tien ---

@pytest.mark.asyncio
async def test_place_order_locks_before_reading_state_and_idem():
    def handler(method, sql, args):
        if "pg_advisory_xact_lock" in sql:
            return None
        if "GROUP BY account, unit" in sql:
            return cash_rows("0")
        if "idem_key = $1" in sql:
            return None
        raise AssertionError(f"SQL ngoai du kien: {sql}")

    conn = FakeConn(handler)
    with pytest.raises(ValueError, match="khong du tien mat"):
        await portfolio.place_order(FakePool(conn), symbol="BTC/USDT", side="buy",
                                    qty=Decimal("1"), mark=Decimal("100"), idem_key="k1")
    assert conn.index("pg_advisory_xact_lock") < conn.index("GROUP BY account, unit")
    assert conn.index("pg_advisory_xact_lock") < conn.index("idem_key = $1")


@pytest.mark.asyncio
async def test_duplicate_idem_key_returns_without_writing():
    def handler(method, sql, args):
        if "pg_advisory_xact_lock" in sql:
            return None
        if "idem_key = $1" in sql:
            return {"id": "abc"}
        raise AssertionError(f"khong duoc ghi them: {sql}")

    conn = FakeConn(handler)
    got = await portfolio.place_order(FakePool(conn), symbol="BTC/USDT", side="buy",
                                      qty=Decimal("1"), mark=Decimal("100"), idem_key="k1")
    assert got == {"duplicate": True, "id": "abc"}
    assert not any("INSERT INTO paper_journal" in s for s in conn.sqls())


@pytest.mark.asyncio
async def test_rebalance_locks_and_takes_marks_outside_transaction(monkeypatch):
    plan = [{"symbol": "BTC/USDT", "side": "buy", "qty": 0.01}]

    async def fake_plan(*_a, **_k):
        return plan

    async def fake_mark(*_a, **_k):
        conn.log.append("MARK")
        return Decimal("100"), "closed"

    monkeypatch.setattr(portfolio, "rebalance_plan", fake_plan)
    monkeypatch.setattr(portfolio, "mark_price", fake_mark)

    def handler(method, sql, args):
        if "pg_advisory_xact_lock" in sql:
            return None
        if "GROUP BY account, unit" in sql:
            return cash_rows()
        if "INSERT INTO paper_journal" in sql:
            return fill_row(args)
        if "INSERT INTO paper_posting" in sql:
            return None
        raise AssertionError(f"SQL ngoai du kien: {sql}")

    conn = FakeConn(handler)
    await portfolio.rebalance_execute(FakePool(conn), None, "binance")
    assert conn.index("pg_advisory_xact_lock") < conn.index("GROUP BY account, unit")
    # mark_price mo connection rieng -> phai goi truoc khi giu transaction.
    assert conn.log.index("MARK") < conn.log.index("BEGIN")


@pytest.mark.asyncio
async def test_rebalance_sell_without_position_raises_value_error(monkeypatch):
    async def fake_plan(*_a, **_k):
        return [{"symbol": "BTC/USDT", "side": "sell", "qty": 1.0}]

    async def fake_mark(*_a, **_k):
        return Decimal("100"), "closed"

    monkeypatch.setattr(portfolio, "rebalance_plan", fake_plan)
    monkeypatch.setattr(portfolio, "mark_price", fake_mark)

    def handler(method, sql, args):
        if "pg_advisory_xact_lock" in sql:
            return None
        if "GROUP BY account, unit" in sql:
            return cash_rows()
        raise AssertionError(f"SQL ngoai du kien: {sql}")

    with pytest.raises(ValueError, match="khong du vi the"):
        await portfolio.rebalance_execute(FakePool(FakeConn(handler)), None, "binance")


# --- Loi 2: equity khong co mark cho gio hien tai -> vi the dinh gia 0, bench phang ---

def equity_handler(events, candles, marks_at, capital="-100000"):
    def handler(method, sql, args):
        if "SELECT * FROM paper_journal" in sql:
            assert "ORDER BY ts, seq" in sql, "replay phai theo thu tu chen, khong theo uuid"
            return events
        if "DISTINCT ON (symbol)" in sql:
            return [{"symbol": s, "close": c} for s, c in marks_at.items()]
        if "FROM candle" in sql:
            return candles
        if "account='CAPITAL'" in sql:
            return [{"amount": Decimal(capital)}]
        raise AssertionError(f"SQL ngoai du kien: {sql}")
    return handler


def journal_events():
    return [
        {"ts": T0, "kind": "deposit", "symbol": None, "qty": Decimal("100000"),
         "price": Decimal("1"), "fee": Decimal("0")},
        {"ts": T0, "kind": "buy", "symbol": "BTC/USDT", "qty": Decimal("1"),
         "price": Decimal("100"), "fee": Decimal("0.1")},
    ]


@pytest.mark.asyncio
async def test_equity_values_position_at_last_closed_candle():
    """Inception la gio chua dong -> kho khong co nen tai do, phai dung nen dong truoc."""
    conn = FakeConn(equity_handler(journal_events(), [], {"BTC/USDT": 100.0}))
    got = await portfolio.equity(FakePool(conn), "binance")
    assert len(got["points"]) == 1
    p = got["points"][0]
    assert p["nav"] == pytest.approx(99999.9)  # cash 99899.9 + 1 BTC * 100
    assert p["nav"] > 99899.9                  # truoc khi sua: nav = cash, vi the = 0
    assert 0 < p["bench"] < 100000             # truoc khi sua: bench = von goc, phang mai


@pytest.mark.asyncio
async def test_equity_initialises_benchmark_at_first_point_with_marks():
    candles = [{"symbol": "BTC/USDT", "ts": T0 + 2 * HOUR, "close": 100.0}]
    conn = FakeConn(equity_handler(journal_events(), candles, {}))
    got = await portfolio.equity(FakePool(conn), "binance")
    points = got["points"]
    assert len(points) == 3
    assert points[0]["bench"] == 100000        # chua co mark -> chua mua benchmark
    assert points[2]["bench"] < 100000         # co mark la phai khoi tao, khong cho h == 0


# --- Loi 3: seed vuot kho -> max() arg is an empty sequence lo ra API ---

def seed_handler(first, last, symbols=("BTC/USDT", "ETH/USDT", "SOL/USDT"), cash="100000"):
    def handler(method, sql, args):
        if "pg_advisory_xact_lock" in sql:
            return None
        if "count(*) FROM paper_journal" in sql:
            return 0
        if "min(ts) AS first_ts" in sql:
            return {"first_ts": first, "last_ts": last}
        if "FROM candle" in sql:
            sym = args[1]
            if sym not in symbols or first is None:
                return []
            out, ts = [], first
            while ts <= last:
                out.append({"ts": ts, "close": Decimal("100")})
                ts += HOUR
            return out
        if "GROUP BY account, unit" in sql:
            return cash_rows(cash, {"BTC/USDT": ("1", "100"), "ETH/USDT": ("1", "100")})
        if "DELETE FROM paper_journal" in sql:
            return None
        if "INSERT INTO paper_journal" in sql:
            row = fill_row(args)
            conn.inserts.append(row)
            return row
        if "INSERT INTO paper_posting" in sql:
            return None
        raise AssertionError(f"SQL ngoai du kien: {sql}")

    conn = FakeConn(handler)
    return conn


@pytest.mark.asyncio
async def test_seed_clamps_to_warehouse_and_never_writes_future_events():
    first, last = T0, T0 + 240 * HOUR  # kho 10 ngay, xin 300 ngay
    conn = seed_handler(first, last)
    n = await portfolio.seed(FakePool(conn), "binance", days=300)
    assert n == 4                        # 3 vi the core + 1 DCA tuan 1, phan con lai vuot kho
    assert conn.inserts[0]["ts"] == first
    assert max(r["ts"] for r in conn.inserts) <= last


@pytest.mark.asyncio
async def test_seed_on_empty_warehouse_reports_actionable_error():
    conn = seed_handler(None, None)
    with pytest.raises(ValueError, match="ingest"):
        await portfolio.seed(FakePool(conn), "binance", days=60)


@pytest.mark.asyncio
async def test_seed_missing_symbol_candles_reports_actionable_error():
    conn = seed_handler(T0, T0 + 240 * HOUR, symbols=("BTC/USDT",))
    with pytest.raises(ValueError, match="kho khong co nen ETH/USDT"):
        await portfolio.seed(FakePool(conn), "binance", days=60)


@pytest.mark.asyncio
@pytest.mark.parametrize("days", [0, -1])
async def test_seed_rejects_non_positive_days(days):
    conn = seed_handler(T0, T0 + 240 * HOUR)
    with pytest.raises(ValueError, match="days phai >= 1"):
        await portfolio.seed(FakePool(conn), "binance", days=days)
    assert not conn.calls


# --- Loi 4: cung ts sap theo uuid ngau nhien -> so du chay loan, deposit xuong cuoi ---

def posting(ts, kind, amount, symbol=None):
    return {"ts": ts, "kind": kind, "symbol": symbol, "source": "seed",
            "note": kind, "amount": Decimal(amount)}


def ledger_rows():
    """Bon event cung gio, giong het journal that: deposit roi BTC, ETH, SOL."""
    return [
        posting(T0, "deposit", "100000"),
        posting(T0, "buy", "-40040", "BTC/USDT"),
        posting(T0, "buy", "-30030", "ETH/USDT"),
        posting(T0, "buy", "-10010", "SOL/USDT"),
        posting(T0 + HOUR, "sell", "5000", "BTC/USDT"),
    ]


def ledger_handler(rows):
    def handler(method, sql, args):
        if "p.account = 'CASH'" in sql:
            return rows
        raise AssertionError(f"SQL ngoai du kien: {sql}")
    return FakeConn(handler)


@pytest.mark.asyncio
async def test_cash_ledger_runs_balance_chronologically_then_shows_newest_first():
    conn = ledger_handler(ledger_rows())
    got = await portfolio.ledger(FakePool(conn), "cash")
    assert "ORDER BY j.ts, j.seq" in conn.sqls()[0]
    assert [r["kind"] for r in got] == ["sell", "buy", "buy", "buy", "deposit"]
    assert [r["balance"] for r in got][::-1] == [100000, 59960, 29930, 19920, 24920]
    assert all(r["balance"] >= 0 for r in got)


@pytest.mark.asyncio
async def test_cash_ledger_limit_keeps_newest_rows_and_full_history_balance():
    rows = [posting(T0, "deposit", "100000")]
    rows += [posting(T0 + i * HOUR, "buy", "-1000", "BTC/USDT") for i in range(1, 6)]
    got = await portfolio.ledger(FakePool(ledger_handler(rows)), "cash", limit=2)
    assert len(got) == 2
    assert [r["ts"] for r in got] == [(T0 + 5 * HOUR).isoformat(), (T0 + 4 * HOUR).isoformat()]
    # so du phai tinh tu dau lich su, khong reset ve 0 theo cua so bi cat
    assert [r["balance"] for r in got] == [95000, 96000]


@pytest.mark.asyncio
async def test_fills_tab_orders_by_seq_desc():
    def handler(method, sql, args):
        assert "ORDER BY ts DESC, seq DESC" in sql
        assert args == (7,)
        return []

    await portfolio.ledger(FakePool(FakeConn(handler)), "fills", limit=7)