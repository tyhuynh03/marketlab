"""marketlab_web.portfolio — paper trading engine + so cai kep (double-entry).

Nguyen tac (khop ROADMAP Phase 1):
  * Event-sourced: moi bien dong so du la mot journal event + cac posting doi ung.
    Khong bao gio luu balance "khoi": cash/qty/avg/realized deu suy ra tu posting.
  * Double-entry: tong posting cua moi event = 0 theo tung unit (USDT hoac qty symbol).
  * Atomic + idempotent: mot transaction cho ca event lan posting; idem_key unique.
  * Decimal cho tien/qty; phi taker 0.1% + truot gia 0.05% chieu bat loi.
  * NAV gio = cash + sum(qty * close_1h) -> replay duoc tu DB, khong luu vet.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any

import asyncpg
import pandas as pd

from marketlab_web import metrics

FEE_RATE = Decimal("0.001")
SLIPPAGE = Decimal("0.0005")
INITIAL_CAPITAL = Decimal("100000")
Q8 = Decimal("0.00000001")
HOUR = timedelta(hours=1)
PERIODS_PER_YEAR = metrics.PERIODS_PER_YEAR["1h"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS paper_journal (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ts        timestamptz NOT NULL,
    kind      text NOT NULL,
    symbol    text,
    qty       numeric(38,18),
    price     numeric(38,18),
    fee       numeric(38,18),
    realized  numeric(38,18),
    source    text NOT NULL DEFAULT 'ui',
    idem_key  text UNIQUE,
    note      text
);
CREATE INDEX IF NOT EXISTS paper_journal_ts_idx ON paper_journal (ts);
CREATE TABLE IF NOT EXISTS paper_posting (
    journal_id uuid NOT NULL REFERENCES paper_journal(id) ON DELETE CASCADE,
    account    text NOT NULL,
    unit       text NOT NULL,
    amount     numeric(38,18) NOT NULL,
    PRIMARY KEY (journal_id, account, unit)
);
CREATE TABLE IF NOT EXISTS paper_target (
    symbol text PRIMARY KEY,
    weight numeric(9,6) NOT NULL CHECK (weight >= 0 AND weight <= 1)
);
INSERT INTO paper_target (symbol, weight) VALUES
    ('BTC/USDT', 0.40), ('ETH/USDT', 0.30), ('SOL/USDT', 0.10), ('CASH', 0.20)
ON CONFLICT DO NOTHING;
"""

DEFAULT_TARGETS = {"BTC/USDT": 0.40, "ETH/USDT": 0.30, "SOL/USDT": 0.10, "CASH": 0.20}


def q8(x: Decimal) -> Decimal:
    return x.quantize(Q8, rounding=ROUND_HALF_UP)


async def ensure_schema(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as conn:
        await conn.execute(SCHEMA)


def _legs(kind: str, symbol: str | None, qty: Decimal, exec_price: Decimal,
          fee: Decimal, avg: Decimal) -> list[tuple[str, str, Decimal]]:
    """Posting doi ung; tong = 0 theo tung unit. REALIZED ghi am khi lai."""
    if kind == "deposit":
        return [("CASH", "USDT", qty), ("CAPITAL", "USDT", -qty)]
    notional = q8(qty * exec_price)
    if kind == "buy":
        return [
            ("CASH", "USDT", -(notional + fee)),
            ("FEES", "USDT", fee),
            (f"COST:{symbol}", "USDT", notional),
            (f"POS:{symbol}", symbol, qty),
            ("MARKET", symbol, -qty),
        ]
    cost_sold = q8(qty * avg)
    gross = notional - cost_sold
    return [
        ("CASH", "USDT", notional - fee),
        ("FEES", "USDT", fee),
        (f"COST:{symbol}", "USDT", -cost_sold),
        ("REALIZED", "USDT", -gross),
        (f"POS:{symbol}", symbol, -qty),
        ("MARKET", symbol, qty),
    ]


async def _fill(conn: asyncpg.Connection, *, ts: datetime, kind: str, symbol: str | None,
                qty: Decimal, mark: Decimal, avg: Decimal, source: str,
                idem_key: str | None, note: str | None = None) -> dict[str, Any]:
    exec_price = q8(mark * (1 + SLIPPAGE) if kind == "buy" else mark * (1 - SLIPPAGE))
    fee = q8(qty * exec_price * FEE_RATE)
    legs = _legs(kind, symbol, qty, exec_price, fee, avg)
    sums: dict[str, Decimal] = {}
    for _, unit, amount in legs:
        sums[unit] = sums.get(unit, Decimal(0)) + amount
    if any(v != 0 for v in sums.values()):
        raise ValueError(f"posting khong can bang: {sums}")
    row = await conn.fetchrow("""
        INSERT INTO paper_journal (ts, kind, symbol, qty, price, fee, realized, source, idem_key, note)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id, ts, kind, symbol, qty, price, fee, realized, source
    """, ts, kind, symbol, qty, exec_price, fee,
        (q8(qty * exec_price) - q8(qty * avg)) if kind == "sell" else None,
        source, idem_key, note)
    await conn.executemany(
        "INSERT INTO paper_posting (journal_id, account, unit, amount) VALUES ($1,$2,$3,$4)",
        [(row["id"], a, u, amt) for a, u, amt in legs])
    return dict(row)


async def state(conn: asyncpg.Connection) -> dict[str, Any]:
    """Trang thai suy ra tu posting: cash, fees, realized, qty + cost theo symbol."""
    rows = await conn.fetch("""
        SELECT account, unit, sum(amount) AS amount
        FROM paper_posting GROUP BY account, unit
    """)
    cash = fees = realized_gross = capital = Decimal(0)
    qty: dict[str, Decimal] = {}
    cost: dict[str, Decimal] = {}
    for r in rows:
        acc, amount = r["account"], r["amount"]
        if acc == "CASH":
            cash = amount
        elif acc == "FEES":
            fees = amount
        elif acc == "REALIZED":
            realized_gross = -amount
        elif acc == "CAPITAL":
            capital = -amount
        elif acc.startswith("POS:"):
            qty[acc[4:]] = amount
        elif acc.startswith("COST:"):
            cost[acc[5:]] = amount
    positions = {}
    for sym, q in qty.items():
        if q > 0:
            positions[sym] = {"qty": q, "cost": cost.get(sym, Decimal(0)),
                              "avg": cost.get(sym, Decimal(0)) / q}
    return {"cash": cash, "fees": fees, "realized_gross": realized_gross,
            "realized_net": realized_gross - fees, "capital": capital, "positions": positions}


async def place_order(pool: asyncpg.Pool, *, symbol: str, side: str, qty: Decimal,
                      mark: Decimal, source: str = "ui", idem_key: str | None = None,
                      ts: datetime | None = None) -> dict[str, Any]:
    if side not in ("buy", "sell"):
        raise ValueError("side phai la buy hoac sell")
    if qty <= 0:
        raise ValueError("qty phai > 0")
    qty = q8(qty)
    async with pool.acquire() as conn:
        if idem_key:
            old = await conn.fetchrow("SELECT id FROM paper_journal WHERE idem_key = $1", idem_key)
            if old:
                return {"duplicate": True, "id": str(old["id"])}
        async with conn.transaction():
            st = await state(conn)
            if side == "buy":
                exec_price = q8(mark * (1 + SLIPPAGE))
                need = q8(qty * exec_price * (1 + FEE_RATE))
                if need > st["cash"]:
                    raise ValueError(f"khong du tien mat: can {need} USDT, co {st['cash']}")
                avg = Decimal(0)
            else:
                pos = st["positions"].get(symbol)
                if not pos or qty > pos["qty"]:
                    raise ValueError(f"khong du vi the {symbol}: co {pos['qty'] if pos else 0}")
                avg = pos["avg"]
            row = await _fill(conn, ts=ts or datetime.now(timezone.utc), kind=side,
                              symbol=symbol, qty=qty, mark=mark, avg=avg,
                              source=source, idem_key=idem_key)
    return {k: (float(v) if isinstance(v, Decimal) else v) for k, v in row.items()}


async def mark_price(pool: asyncpg.Pool, hub: Any, venue: str, symbol: str) -> tuple[Decimal, str]:
    """Mark = nen dang chay (LiveHub) neu co, else nen dong gan nhat trong kho."""
    if hub is not None and hub.state == "on":
        bar = hub.bars.get(hub.key(symbol, "1h"))
        if bar:
            return Decimal(str(bar["close"])), "live"
    async with pool.acquire() as conn:
        close = await conn.fetchval("""
            SELECT close FROM candle WHERE venue=$1 AND symbol=$2 AND timeframe='1h'
            ORDER BY ts DESC LIMIT 1
        """, venue, symbol)
    if close is None:
        raise ValueError(f"khong co nen cho {symbol}")
    return Decimal(str(close)), "closed"


async def snapshot(pool: asyncpg.Pool, hub: Any, venue: str) -> dict[str, Any]:
    async with pool.acquire() as conn:
        st = await state(conn)
        inception = await conn.fetchval("SELECT min(ts) FROM paper_journal")
        targets = {r["symbol"]: float(r["weight"]) for r in
                   await conn.fetch("SELECT symbol, weight FROM paper_target")}
    marks: dict[str, Decimal] = {}
    sources: dict[str, str] = {}
    for sym in st["positions"]:
        marks[sym], sources[sym] = await mark_price(pool, hub, venue, sym)
    holdings = sum((p["qty"] * marks[s] for s, p in st["positions"].items()), Decimal(0))
    unreal = sum((p["qty"] * (marks[s] - p["avg"]) for s, p in st["positions"].items()), Decimal(0))
    nav = st["cash"] + holdings
    cost_open = sum((p["cost"] for p in st["positions"].values()), Decimal(0))
    positions = []
    for sym, p in sorted(st["positions"].items(), key=lambda kv: -(kv[1]["qty"] * marks[kv[0]])):
        value = p["qty"] * marks[sym]
        u = p["qty"] * (marks[sym] - p["avg"])
        positions.append({
            "symbol": sym, "qty": float(p["qty"]), "avg": float(p["avg"]),
            "mark": float(marks[sym]), "mark_source": sources[sym], "value": float(value),
            "unrealized": float(u), "unrealized_pct": float(u / p["cost"]) if p["cost"] else 0.0,
            "weight": float(value / nav) if nav else 0.0,
            "breakeven": float(p["avg"] * (1 + FEE_RATE) / (1 - FEE_RATE)),
        })
    drift = []
    current = {p["symbol"]: p["weight"] for p in positions}
    current["CASH"] = float(st["cash"] / nav) if nav else 0.0
    for sym, target in sorted(targets.items(), key=lambda kv: -kv[1]):
        cur = current.get(sym, 0.0)
        drift.append({"symbol": sym, "target": target, "current": cur, "drift": cur - target})
    return {
        "inception": inception.isoformat() if inception else None,
        "capital": float(st["capital"]), "cash": float(st["cash"]),
        "holdings": float(holdings), "nav": float(nav),
        "nav_pct": float(nav / st["capital"] - 1) if st["capital"] else 0.0,
        "unrealized": float(unreal),
        "unrealized_pct": float(unreal / cost_open) if cost_open else 0.0,
        "realized_net": float(st["realized_net"]), "fees": float(st["fees"]),
        "positions": positions, "targets": drift,
        "reconciliation": float(nav - st["capital"] - st["realized_net"] - unreal),
    }


async def _hourly_marks(conn: asyncpg.Connection, venue: str, symbols: list[str],
                        since: datetime) -> dict[str, dict[datetime, float]]:
    if not symbols:
        return {}
    rows = await conn.fetch("""
        SELECT symbol, ts, close FROM candle
        WHERE venue=$1 AND timeframe='1h' AND symbol = ANY($2::text[]) AND ts >= $3
        ORDER BY ts
    """, venue, symbols, since)
    out: dict[str, dict[datetime, float]] = {s: {} for s in symbols}
    for r in rows:
        out[r["symbol"]][r["ts"]] = float(r["close"])
    return out


async def equity(pool: asyncpg.Pool, venue: str, benchmark: str = "btc") -> dict[str, Any]:
    """Replay journal tren luoi gio -> NAV + benchmark + underwater. Khong luu vet."""
    async with pool.acquire() as conn:
        events = await conn.fetch("SELECT * FROM paper_journal ORDER BY ts, id")
        if not events:
            return {"points": [], "metrics": {}, "inception": None}
        inception = events[0]["ts"].replace(minute=0, second=0, microsecond=0)
        symbols = sorted({e["symbol"] for e in events if e["symbol"]})
        marks = await _hourly_marks(conn, venue, symbols, inception)
        bench_syms = ["BTC/USDT"] if benchmark == "btc" else ["BTC/USDT", "ETH/USDT"]
        bench_marks = await _hourly_marks(conn, venue, bench_syms, inception)
        capital = float(-sum((r["amount"] for r in await conn.fetch(
            "SELECT amount FROM paper_posting WHERE account='CAPITAL'")), Decimal(0)))
    grid_end = max((max(m) for m in marks.values() if m), default=inception)
    hours = int((grid_end - inception).total_seconds() // 3600) + 1
    cash = Decimal(0)
    qty: dict[str, Decimal] = {}
    cost: dict[str, Decimal] = {}
    ei = 0
    points = []
    last_mark: dict[str, float] = {}
    last_bench: dict[str, float] = {}
    bench_qty: dict[str, float] = {}
    for h in range(hours):
        ts = inception + h * HOUR
        while ei < len(events) and events[ei]["ts"] <= ts + timedelta(minutes=59, seconds=59):
            e = events[ei]
            if e["kind"] == "deposit":
                cash += e["qty"]
            elif e["kind"] == "buy":
                cash -= q8(e["qty"] * e["price"]) + e["fee"]
                qty[e["symbol"]] = qty.get(e["symbol"], Decimal(0)) + e["qty"]
                cost[e["symbol"]] = cost.get(e["symbol"], Decimal(0)) + q8(e["qty"] * e["price"])
            elif e["kind"] == "sell":
                avg = cost[e["symbol"]] / qty[e["symbol"]]
                cash += q8(e["qty"] * e["price"]) - e["fee"]
                cost[e["symbol"]] -= q8(e["qty"] * avg)
                qty[e["symbol"]] -= e["qty"]
            ei += 1
        for s in symbols:
            if ts in marks.get(s, {}):
                last_mark[s] = marks[s][ts]
        for s in bench_syms:
            if ts in bench_marks.get(s, {}):
                last_bench[s] = bench_marks[s][ts]
        nav = float(cash) + sum(float(q) * last_mark.get(s, 0.0) for s, q in qty.items() if q > 0)
        if not bench_qty and h == 0:
            split = {"BTC/USDT": 1.0} if benchmark == "btc" else {"BTC/USDT": 0.8, "ETH/USDT": 0.2}
            for s, w in split.items():
                m0 = last_bench.get(s)
                if m0:
                    exec0 = m0 * (1 + float(SLIPPAGE))
                    bench_qty[s] = capital * w / (exec0 * (1 + float(FEE_RATE)))
        bench = sum(bench_qty.get(s, 0.0) * last_bench.get(s, 0.0) for s in bench_syms) \
            if bench_qty else capital
        points.append({"ts": ts.isoformat(), "nav": nav, "bench": bench})
    nav_s = pd.Series([p["nav"] for p in points])
    bench_s = pd.Series([p["bench"] for p in points])
    for p, dd, ddb in zip(points, nav_s / nav_s.cummax() - 1, bench_s / bench_s.cummax() - 1):
        p["dd"] = float(dd)
        p["dd_bench"] = float(ddb)
    rp = metrics.log_returns(nav_s)
    rb = metrics.log_returns(bench_s)
    beta = alpha = None
    if len(rp) > 2 and len(rb) > 2 and float(rb.var(ddof=1)) > 0:
        cov = float(pd.concat([rp, rb], axis=1).cov().iloc[0, 1])
        beta = cov / float(rb.var(ddof=1))
        alpha = (float(rp.mean()) - beta * float(rb.mean())) * PERIODS_PER_YEAR
    return {
        "inception": inception.isoformat(), "benchmark": benchmark, "points": points,
        "metrics": {
            "sharpe": metrics.sharpe(nav_s, PERIODS_PER_YEAR),
            "sortino": metrics.sortino(nav_s, PERIODS_PER_YEAR),
            "max_drawdown": metrics.max_drawdown(nav_s),
            "volatility": metrics.volatility(nav_s, PERIODS_PER_YEAR),
            "total_return": metrics.total_return(nav_s),
            "bench_return": metrics.total_return(bench_s),
            "beta": beta, "alpha": alpha,
        },
    }


async def risk_contributions(pool: asyncpg.Pool, venue: str, snap: dict[str, Any]) -> dict[str, float | None]:
    """RC_i = w_i * Cov(r_i, r_p) / Var(r_p); tong RC cua cac vi the = 1 (cash = 0)."""
    syms = [p["symbol"] for p in snap["positions"]]
    if not syms:
        return {}
    async with pool.acquire() as conn:
        since = await conn.fetchval("SELECT min(ts) FROM paper_journal")
        marks = await _hourly_marks(conn, venue, syms, since)
        eq = await equity(pool, venue)
    rp = pd.Series([p["nav"] for p in eq["points"]]).pct_change().dropna()
    out: dict[str, float | None] = {}
    var_p = float(rp.var(ddof=1)) if len(rp) > 2 else 0.0
    for p in snap["positions"]:
        s = pd.Series([marks[p["symbol"]].get(datetime.fromisoformat(pt["ts"]), None)
                       for pt in eq["points"]]).ffill().pct_change().dropna()
        if var_p <= 0 or len(s) < 3 or len(s) != len(rp):
            out[p["symbol"]] = None
            continue
        cov = float(pd.concat([s.reset_index(drop=True), rp.reset_index(drop=True)], axis=1).cov().iloc[0, 1])
        out[p["symbol"]] = p["weight"] * cov / var_p
    return out


async def ledger(pool: asyncpg.Pool, tab: str, limit: int = 200) -> list[dict[str, Any]]:
    async with pool.acquire() as conn:
        if tab == "cash":
            rows = await conn.fetch("""
                SELECT j.ts, j.kind, j.symbol, j.source, j.note, p.amount
                FROM paper_posting p JOIN paper_journal j ON j.id = p.journal_id
                WHERE p.account = 'CASH' ORDER BY j.ts, j.id
            """)
            balance = Decimal(0)
            out = []
            for r in rows:
                balance += r["amount"]
                out.append({"ts": r["ts"].isoformat(), "kind": r["kind"], "symbol": r["symbol"],
                            "source": r["source"], "note": r["note"],
                            "amount": float(r["amount"]), "balance": float(balance)})
            return out[-limit:][::-1]
        rows = await conn.fetch("""
            SELECT ts, kind, symbol, qty, price, fee, realized, source, id, note
            FROM paper_journal WHERE kind IN ('buy','sell') ORDER BY ts DESC, id DESC LIMIT $1
        """, limit)
    return [{"ts": r["ts"].isoformat(), "kind": r["kind"], "symbol": r["symbol"],
             "qty": float(r["qty"]), "price": float(r["price"]), "fee": float(r["fee"]),
             "realized": float(r["realized"]) if r["realized"] is not None else None,
             "source": r["source"], "id": str(r["id"])[:8], "note": r["note"]} for r in rows]


async def rebalance_plan(pool: asyncpg.Pool, hub: Any, venue: str) -> list[dict[str, Any]]:
    snap = await snapshot(pool, hub, venue)
    nav = Decimal(str(snap["nav"]))
    plan = []
    for t in snap["targets"]:
        if t["symbol"] == "CASH" or abs(t["drift"]) < 0.005:
            continue
        mark, _ = await mark_price(pool, hub, venue, t["symbol"])
        delta_value = (Decimal(str(t["target"])) - Decimal(str(t["current"]))) * nav
        side = "buy" if delta_value > 0 else "sell"
        exec_price = mark * (1 + SLIPPAGE) if side == "buy" else mark * (1 - SLIPPAGE)
        qty = q8(abs(delta_value) / exec_price)
        pos = next((p for p in snap["positions"] if p["symbol"] == t["symbol"]), None)
        if side == "sell":
            if not pos:
                continue
            qty = min(qty, Decimal(str(pos["qty"])))
        if qty <= 0 or q8(qty * exec_price) < 1:
            continue
        plan.append({"symbol": t["symbol"], "side": side, "qty": float(qty),
                     "est_price": float(exec_price), "est_fee": float(q8(qty * exec_price * FEE_RATE)),
                     "current": t["current"], "target": t["target"], "drift": t["drift"]})
    return sorted(plan, key=lambda p: p["side"] != "sell")


async def rebalance_execute(pool: asyncpg.Pool, hub: Any, venue: str,
                            idem_key: str | None = None) -> list[dict[str, Any]]:
    plan = await rebalance_plan(pool, hub, venue)
    done = []
    async with pool.acquire() as conn:
        async with conn.transaction():
            for i, p in enumerate(plan):
                mark, _ = await mark_price(pool, hub, venue, p["symbol"])
                st = await state(conn)
                qty = Decimal(str(p["qty"]))
                if p["side"] == "buy":
                    need = q8(qty * mark * (1 + SLIPPAGE) * (1 + FEE_RATE))
                    if need > st["cash"]:
                        raise ValueError("khong du tien mat sau khi ban — huy rebalance")
                    avg = Decimal(0)
                else:
                    avg = st["positions"][p["symbol"]]["avg"]
                row = await _fill(conn, ts=datetime.now(timezone.utc), kind=p["side"],
                                  symbol=p["symbol"], qty=qty, mark=mark, avg=avg,
                                  source="rebalance",
                                  idem_key=f"{idem_key}:{i}" if idem_key else None)
                done.append({k: (float(v) if isinstance(v, Decimal) else v) for k, v in row.items()})
    return done


async def reset(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("DELETE FROM paper_journal")
            await _fill(conn, ts=datetime.now(timezone.utc), kind="deposit", symbol=None,
                        qty=INITIAL_CAPITAL, mark=Decimal(1), avg=Decimal(0),
                        source="reset", idem_key=None, note="Nap von paper khoi tao")


async def seed(pool: asyncpg.Pool, venue: str, days: int = 60) -> int:
    """Replay chien luoc paper qua khu tu nen 1h that; gan nhan source='seed'."""
    async with pool.acquire() as conn:
        n = await conn.fetchval("SELECT count(*) FROM paper_journal WHERE kind IN ('buy','sell')")
        if n:
            raise ValueError("da co lenh paper — reset truoc khi seed")
        t0 = await conn.fetchval("""
            SELECT max(ts) - ($1 || ' hours')::interval FROM candle
            WHERE venue=$2 AND timeframe='1h'
        """, str(days * 24), venue)
        t0 = t0.replace(minute=0, second=0, microsecond=0)
        closes: dict[str, dict[datetime, Decimal]] = {}
        for sym in ("BTC/USDT", "ETH/USDT", "SOL/USDT"):
            rows = await conn.fetch("""
                SELECT ts, close FROM candle WHERE venue=$1 AND symbol=$2
                  AND timeframe='1h' AND ts >= $3 ORDER BY ts
            """, venue, sym, t0)
            closes[sym] = {r["ts"]: Decimal(str(r["close"])) for r in rows}

        def mark_at(sym: str, ts: datetime) -> Decimal:
            series = closes[sym]
            if ts in series:
                return series[ts]
            prior = [t for t in series if t <= ts]
            return series[max(prior)]

        async with conn.transaction():
            # Reset de lai deposit o hien tai; seed thay bang deposit cua no tai t0
            # de von khong bi nhan doi.
            await conn.execute("DELETE FROM paper_journal")
            await _fill(conn, ts=t0, kind="deposit", symbol=None, qty=INITIAL_CAPITAL,
                        mark=Decimal(1), avg=Decimal(0), source="seed",
                        idem_key="seed:deposit", note="Nap von paper khoi tao (seed)")
            seq = 0

            async def order(ts: datetime, sym: str, side: str, qty: Decimal, note: str) -> None:
                nonlocal seq
                st = await state(conn)
                avg = st["positions"][sym]["avg"] if side == "sell" else Decimal(0)
                seq += 1
                await _fill(conn, ts=ts, kind=side, symbol=sym, qty=qty,
                            mark=mark_at(sym, ts), avg=avg, source="seed",
                            idem_key=f"seed:{seq}", note=note)

            for sym, notional in (("BTC/USDT", 40000), ("ETH/USDT", 30000), ("SOL/USDT", 10000)):
                m = mark_at(sym, t0)
                await order(t0, sym, "buy", q8(Decimal(notional) / (m * (1 + SLIPPAGE))), "Mo vi the core (seed)")
            for week in range(1, 8):
                ts = t0 + week * 7 * 24 * HOUR
                st = await state(conn)
                if st["cash"] > 6000:
                    m = mark_at("BTC/USDT", ts)
                    await order(ts, "BTC/USDT", "buy", q8(Decimal(2000) / (m * (1 + SLIPPAGE))), "DCA hang tuan (seed)")
            ts = t0 + 20 * 24 * HOUR
            st = await state(conn)
            await order(ts, "BTC/USDT", "sell", q8(st["positions"]["BTC/USDT"]["qty"] * Decimal("0.2")), "Chot 20% BTC (seed)")
            ts = t0 + 40 * 24 * HOUR
            st = await state(conn)
            await order(ts, "ETH/USDT", "sell", q8(st["positions"]["ETH/USDT"]["qty"] * Decimal("0.3")), "Chot 30% ETH (seed)")
            ts = t0 + 50 * 24 * HOUR
            m = mark_at("SOL/USDT", ts)
            await order(ts, "SOL/USDT", "buy", q8(Decimal(3000) / (m * (1 + SLIPPAGE))), "Mua them SOL (seed)")
    return seq