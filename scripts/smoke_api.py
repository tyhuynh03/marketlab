"""Smoke API cho CI: doi chieu API voi fixture nen that trong db/ci_fixture.sql.

Chay tren stack docker cua runner (db + api, khong worker) nen khong cham san:
runner o My hay bi Binance chan, va Yahoo co the gioi han IP la. Moi con so
duoi day suy ra tu fixture hoac tu cong thuc metrics doc lap, khong hard-code
ket qua cua API.

Cach chay: python scripts/smoke_api.py [base_url]
"""
from __future__ import annotations

import json
import math
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8010").rstrip("/")
FIXTURE = Path(__file__).resolve().parent.parent / "db" / "ci_fixture.sql"
NY = ZoneInfo("America/New_York")
ROW = re.compile(
    r"INSERT INTO candle VALUES \('([^']+)','([^']+)','([^']+)','([^']+)',"
    r"([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+)\)")

results: list[tuple[str, bool, str]] = []


def ok(name: str, passed: bool, detail: str = "") -> None:
    results.append((name, passed, detail))
    print(f"{'PASS' if passed else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


def close(a: float, b: float) -> bool:
    return math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-6)


def call(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"} if body is not None else {})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw)
        except ValueError:
            return exc.code, {"detail": raw.decode(errors="replace")}


def load_fixture() -> dict[tuple[str, str, str], list[dict]]:
    groups: dict[tuple[str, str, str], list[dict]] = {}
    for m in ROW.finditer(FIXTURE.read_text(encoding="utf-8")):
        venue, symbol, tf, ts, o, h, l, c, v = m.groups()
        groups.setdefault((venue, symbol, tf), []).append({
            "ts": datetime.fromisoformat(ts), "open": float(o), "high": float(h),
            "low": float(l), "close": float(c), "volume": float(v)})
    for rows in groups.values():
        rows.sort(key=lambda r: r["ts"])
    return groups


def rollup(rows: list[dict], hours: int) -> list[dict]:
    buckets: dict[datetime, list[dict]] = {}
    for r in rows:
        t = r["ts"].replace(minute=0, second=0, microsecond=0)
        key = t.replace(hour=t.hour - t.hour % hours) if hours < 24 else t.replace(hour=0)
        buckets.setdefault(key, []).append(r)
    out = []
    for key in sorted(buckets):
        grp = buckets[key]
        out.append({"ts": key, "open": grp[0]["open"], "high": max(g["high"] for g in grp),
                    "low": min(g["low"] for g in grp), "close": grp[-1]["close"],
                    "volume": sum(g["volume"] for g in grp)})
    return out


def same_bars(api: list[dict], want: list[dict]) -> bool:
    if len(api) != len(want):
        return False
    for a, w in zip(api, want):
        if datetime.fromisoformat(a["ts"]) != w["ts"]:
            return False
        if not all(close(a[k], w[k]) for k in ("open", "high", "low", "close", "volume")):
            return False
    return True


fx = load_fixture()
btc = fx[("binance", "BTC/USDT", "1h")]
aapl_h = fx[("yahoo", "AAPL", "1h")]
aapl_d = fx[("yahoo", "AAPL", "1d")]

# ---------- health & watchlist ----------
st, health = call("GET", "/health")
ok("health ok va thay TimescaleDB", st == 200 and health.get("status") == "ok"
   and bool(health.get("timescaledb")), f"HTTP {st}, {health.get('timescaledb')}")
ok("kho chua du 200 nen fixture", health.get("candles") == len(btc) + len(aapl_h) + len(aapl_d),
   f"{health.get('candles')} nen")
st, wl = call("GET", "/api/watchlist")
ok("watchlist seed du 18 symbol", st == 200 and len(wl) == 18, f"{len(wl)}")
ok("6 symbol venue yahoo", sum(1 for e in wl if e["venue"] == "yahoo") == 6)

# ---------- nen goc khop fixture ----------
st, got = call("GET", "/api/candles?symbol=BTC/USDT&timeframe=1h&limit=5000&venue=binance")
ok("BTC 1h khop fixture tung nen", st == 200 and same_bars(got["candles"], btc),
   f"{len(got.get('candles', []))}/{len(btc)} nen")
st, got_h = call("GET", "/api/candles?symbol=AAPL&timeframe=1h&limit=5000&venue=yahoo")
ok("AAPL 1h khop fixture tung nen", st == 200 and same_bars(got_h["candles"], aapl_h),
   f"{len(got_h.get('candles', []))}/{len(aapl_h)} nen")

# ---------- rollup 4h/1d tinh doc lap tu nen 1h ----------
for tf, hours in (("4h", 4), ("1d", 24)):
    st, got_r = call("GET", f"/api/candles?symbol=BTC/USDT&timeframe={tf}&limit=5000&venue=binance")
    ok(f"BTC {tf} = rollup UTC cua 1h", st == 200 and same_bars(got_r["candles"], rollup(btc, hours)),
       f"{len(got_r.get('candles', []))} bucket")
st, got_y4 = call("GET", "/api/candles?symbol=AAPL&timeframe=4h&limit=5000&venue=yahoo")
ok("AAPL 4h = rollup cua 1h yahoo", st == 200 and same_bars(got_y4["candles"], rollup(aapl_h, 4)),
   f"{len(got_y4.get('candles', []))} bucket")

# ---------- nen ngay My la nen chinh thuc, khong phai rollup ----------
st, got_d = call("GET", "/api/candles?symbol=AAPL&timeframe=1d&limit=5000&venue=yahoo")
ok("AAPL 1d khop nen ngay chinh thuc", st == 200 and same_bars(got_d["candles"], aapl_d),
   f"{len(got_d.get('candles', []))}/{len(aapl_d)} nen")
rolled = {r["ts"]: r for r in rollup(aapl_h, 24)}
leched = [r["ts"].date().isoformat() for r in aapl_d
          if r["ts"] in rolled and not close(r["volume"], rolled[r["ts"]]["volume"])]
ok("AAPL 1d KHAC rollup 1h (chung to doc nen chinh thuc)", len(leched) > 0,
   f"{len(leched)} ngay lech khoi luong")
ok("nen ngay My moc 00:00 UTC", all(r["ts"].hour == 0 and r["ts"].minute == 0 for r in aapl_d))

# ---------- nen 1h My nam trong phien NY ----------
def in_session(ts: datetime) -> bool:
    local = ts.astimezone(NY)
    minutes = local.hour * 60 + local.minute
    return local.weekday() < 5 and local.minute == 30 and 570 <= minutes < 960


ok("moi nen 1h AAPL trong phien NY, moc :30", all(in_session(r["ts"]) for r in aapl_h),
   f"{sum(1 for r in aapl_h if not in_session(r['ts']))} nen ngoai phien")

# ---------- summary doi chieu cong thuc doc lap ----------
for venue, symbol, rows, ppy in (("binance", "BTC/USDT", btc, 8760.0), ("yahoo", "AAPL", aapl_h, 1638.0)):
    st, s = call("GET", f"/api/summary?symbol={symbol}&timeframe=1h&limit=5000&venue={venue}")
    n = len(rows)
    tr = rows[-1]["close"] / rows[0]["close"] - 1
    ann = (rows[-1]["close"] / rows[0]["close"]) ** (ppy / (n - 1)) - 1
    ok(f"summary {venue} dung observations/total_return", st == 200
       and s["observations"] == n and close(s["total_return"], tr),
       f"obs {s.get('observations')}, tr {s.get('total_return'):.6f}")
    ok(f"summary {venue} annual hoa theo ppy {ppy:g}", close(s["annualized_return"], ann),
       f"api {s['annualized_return']:.6f} vs oracle {ann:.6f}")
    ok(f"summary {venue} max_drawdown am", s["max_drawdown"] <= 0, f"{s['max_drawdown']:.6f}")

# ---------- cach ly venue va bien gioi ----------
st, _ = call("GET", "/api/candles?symbol=AAPL&timeframe=1h&venue=binance")
ok("AAPL venue binance -> 404", st == 404, f"HTTP {st}")
st, _ = call("GET", "/api/candles?symbol=BTC/USDT&timeframe=1h&venue=yahoo")
ok("BTC venue yahoo -> 404", st == 404, f"HTTP {st}")
st, _ = call("GET", "/api/candles?symbol=BTC/USDT&timeframe=1h&limit=1")
ok("limit=1 -> 422", st == 422, f"HTTP {st}")
st, _ = call("POST", "/api/watchlist", {"symbol": "BTC-USD"})
ok("cap crypto sai dinh dang -> 422", st == 422, f"HTTP {st}")
st, _ = call("POST", "/api/watchlist", {"symbol": "ZZZZZZ9", "venue": "yahoo"})
ok("ticker rac venue yahoo -> 422 truoc khi cham mang", st == 422, f"HTTP {st}")
st, _ = call("DELETE", "/api/watchlist?symbol=../etc/passwd")
ok("symbol path traversal -> 422", st == 422, f"HTTP {st}")

# ---------- bot watchlist chi cham DB ----------
st, _ = call("DELETE", "/api/watchlist?symbol=ETH/USDT")
ok("bot ETH/USDT -> 200", st == 200, f"HTTP {st}")
st, _ = call("DELETE", "/api/watchlist?symbol=ETH/USDT")
ok("bot lan hai -> 404", st == 404, f"HTTP {st}")
st, wl2 = call("GET", "/api/watchlist")
ok("watchlist con 17 sau khi bot", st == 200 and len(wl2) == 17, f"{len(wl2)}")

failed = [r for r in results if not r[1]]
print(f"\n=== {len(results) - len(failed)}/{len(results)} PASS ===")
for name, _, detail in failed:
    print("FAIL:", name, detail)
sys.exit(1 if failed else 0)