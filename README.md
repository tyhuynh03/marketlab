# marketlab-web

Dashboard nghiên cứu thị trường: ccxt → TimescaleDB → FastAPI → React.

Tách ra từ `../market-lab` (bản CLI + Jinja/stdlib) khi cần kho dữ liệu time-series
thật và chart tương tác. Market-lab vẫn là bản không dependency.

## Stack và lý do chọn

| Lớp             | Công cụ                                  | Vì sao đặc thù fintech                                                      |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| Nguồn dữ liệu | `ccxt` 4.5                               | chuẩn hoá ~100 sàn; đổi venue chỉ sửa `VENUE`                          |
| Lưu trữ        | TimescaleDB 2.31 (Postgres 17)             | hypertable theo `ts`, `time_bucket` + continuous aggregate cho rollup 4h/1d |
| Tính toán      | `pandas` / `numpy`                     | vector hoá log return, cummax drawdown                                         |
| API              | FastAPI + asyncpg + pydantic-settings      | pool async, schema cấu hình có kiểm chứng                                  |
| Lịch            | APScheduler                                | worker ingest chạy theo chu kỳ                                                |
| Frontend         | React 19 + TypeScript + Vite + Tailwind v4 | —                                                                              |
| Chart            | `lightweight-charts` 5.3                 | Apache-2.0, ~45KB gzip, canvas, dựng nến thật                                |
| Data fetching    | TanStack Query 5                           | cache theo `(symbol, timeframe, limit)`, AbortSignal                          |
| Realtime         | Binance kline WS → hub → SSE               | một kết nối sàn cho cả terminal, client không nối thẳng sàn                 |

## Chạy bằng Docker (đổi máy / mang về nhà)

```bash
git clone https://github.com/tyhuynh03/marketlab.git marketlab-web && cd marketlab-web
cp .env.example .env              # đổi POSTGRES_PASSWORD, và port nếu máy đã chiếm
docker compose up -d --build      # db + api + worker ingest + web
```

Mở `http://localhost:5173`. Worker tự nạp 120 ngày nến cho BTC/ETH ngay lần boot đầu;
thêm symbol khác thì:

```bash
curl -X POST localhost:8010/api/watchlist -H 'Content-Type: application/json' -d '{"symbol":"SOL/USDT"}'
curl -X POST localhost:8010/api/watchlist -H 'Content-Type: application/json' -d '{"symbol":"BNB/USDT"}'
```

Port publish cấu hình trong `.env` (`DB_PORT`, `API_PORT`, `WEB_PORT`) — mặc định
5433/8010/5173 và bind `127.0.0.1`. Muốn máy khác trong LAN vào được thì bỏ tiền tố
`127.0.0.1:` trong `docker-compose.yml`.

Dữ liệu nằm trong volume `dbdata`, `docker compose down` không xoá. Muốn làm lại
từ đầu: `docker compose down -v`.

## Chạy dev cục bộ (sửa code nóng)

```bash
cp .env.example .env            # compose đọc POSTGRES_* từ đây
docker compose up -d db         # bootstrap schema + hypertable + CAgg lần đầu
cd backend && python -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m marketlab_web.ingest      # worker: nap 120 ngay + lien tuc 5 phut
.venv/Scripts/python -m uvicorn marketlab_web.api:app --port 8010
cd ../web && npm install && npm run dev           # http://localhost:5173
```

Hai đường này dùng chung một schema và một volume; chạy song song thì đổi port
trong `.env` để không đụng nhau.

## API

| Đường dẫn                                  | Nội dung                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /health`                                | phiên bản TimescaleDB + tổng số nến                                    |
| `GET /api/watchlist`                         | symbol, giá đóng gần nhất, delta so với nến trước, số nến        |
| `GET /api/candles?symbol=&timeframe=&limit=` | nến; `4h`/`1d` đọc continuous aggregate                              |
| `GET /api/summary?symbol=&timeframe=&limit=` | total return, annualised, max drawdown, volatility, Sharpe, Sortino, Calmar |
| `POST /api/ingest?symbol=&days=`             | kéo ccxt về `days` ngày, UPSERT, rồi refresh CAgg                     |
| `GET /api/live`                              | SSE: state + snapshot nến đang chạy + `bar`/`closed` + heartbeat 15s   |

`symbol` dùng dạng ccxt (`BTC/USDT`), không phải dạng Binance (`BTCUSDT`).

## Quy ước chỉ số

Định nghĩa ghi trong `backend/marketlab_web/metrics.py` và bị ràng buộc bởi
`backend/tests/test_metrics_oracle.py` (tính lại bằng `statistics` thuần + đối chiếu
`quantstats.stats.max_drawdown`):

```
log return    r_t = ln(P_t / P_{t-1})
total return  P_end / P_start - 1
volatility    std(r, ddof=1) * sqrt(periods_per_year)      # annual hoá
max drawdown  min_t (P_t / running_max(P)_t - 1)           # am
sharpe        mean(r) / std(r, ddof=1) * sqrt(periods_per_year)
sortino       mean(r) / downside_dev(r) * sqrt(periods_per_year)
calmar        annualized_return / abs(max_drawdown)
```

`periods_per_year` theo `1m/5m/15m/1h/4h/1d/1w`; timeframe lạ → `ValueError`,
không âm thầm mặc định.

Khác với market-lab CLI: ở đây `volatility` **annual hoá** và dùng **sample** stdev
(`ddof=1`), còn CLI dùng population stdev trên log return thô theo `BRIEF.md`.

## Chỉ lưu nến đã đóng

`fetch_history` loại mọi nến có `ts + timeframe > now`. Binance trả cả nến đang
chạy, nên nếu lưu thì mỗi vòng ingest ghi đè một dòng đã tồn tại bằng snapshot
giữa giờ: giá trị không tái lập được và mọi chỉ số tính trên nến cuối thay đổi
mà không có dữ liệu mới.

Bất biến này vẫn giữ nguyên cho **kho nến**. Nến đang chạy đi đường riêng (mục
dưới): nằm trong bộ nhớ hub, hiển thị trên chart, và chỉ vào kho khi sàn báo đóng.
Metrics, bảng nến và `/api/summary` vẫn đọc đúng chuỗi nến đã đóng.

## Realtime: nến đang chạy

```
Binance kline WS ──► LiveHub (bộ nhớ) ──► SSE /api/live ──► EventSource ──► chart
        │                    │
        └── k.x = true ──────┴──► UPSERT candle + refresh CAgg ──► invalidate query
```

- `backend/marketlab_web/live.py` mở **một** combined stream
  (`btcusdt@kline_1h/…@kline_4h/…@kline_1d` cho mọi symbol trong watchlist), giữ
  nến đang chạy trong `hub.bars`, tự nối lại với backoff và nạp lại watchlist mỗi
  30s nên thêm/bớt symbol không cần restart.
- `GET /api/live` là SSE: mở đầu bằng `state` + snapshot để client mới không phải
  chờ nhịp kế tiếp, sau đó đẩy `bar`; heartbeat 15s giữ kết nối qua proxy. Hàng
  đợi mỗi client có chặn 256 — client chậm bị bỏ bản tin cũ chứ không kéo sập hub.
- Khi `k.x = true` và đúng khung gốc, hub UPSERT nến đó vào TimescaleDB rồi phát
  `closed`; frontend invalidate query để chuỗi nến đã đóng trở lại nguồn sự thật.
  Nến 4h/1d không ghi đè kho vì chúng là continuous aggregate của nến 1h.
- Frontend (`web/src/live.ts`) gom bản tin 400ms trước khi render: sàn đẩy ~1
  bản tin/giây/stream, render lại cả terminal từng bản tin là phí. Nến đang chạy
  được ghép vào cuối dãy nến của chart, **không** lẫn vào metrics hay bảng nến.
- Chart tự cuộn theo nến mới chỉ khi người dùng đang ở mép phải; đang xem quá khứ
  thì giữ nguyên khung. Chú giải đổi nhãn `nến đang chạy` ↔ `nến đã đóng`.
- Tắt LIVE ở thanh trạng thái thì đóng EventSource, chart lùi về đúng nến đã đóng.
  `LIVE_ENABLED=false` tắt hub ngay từ lifespan.

## Cột `trades` đã bỏ

`ccxt.fetch_ohlcv` chuẩn hoá còn 6 cột; số lệnh là field riêng của từng sàn
(Binance `klines` index 8). Bảng `candle` không giữ cột mà worker không bao giờ
điền được. Cần số lệnh thì viết adapter raw endpoint riêng cho từng venue.

## Kiểm chứng

Trước khi tin một con số trên trang:

```bash
cd backend && .venv/Scripts/python -m pytest -q      # 51 passed (0 skipped)
```

Và tái kiểm trên hàng thật bằng SQL độc lập (`psql` → `statistics` thuần):

```sql
SELECT bucket, open, high, low, close, volume FROM candle_1d
WHERE venue='binance' AND symbol='BTC/USDT' ORDER BY bucket DESC LIMIT 121;
```

Lần chạy 2026-11-11: 121/121 bucket 1d khớp nến giờ gốc về OHLC+volume;
8/8 chỉ số BTC và ETH khớp oracle tới 1e-12.

Bất biến của kho — hash cả chuỗi, ingest lại, hash lại:

```bash
Q="SELECT symbol, count(*), md5(string_agg(format('%s|%s|%s|%s|%s|%s',
     ts, open, high, low, close, volume), '|' ORDER BY ts))
   FROM candle WHERE timeframe='1h' GROUP BY symbol;"
docker compose exec -T db psql -U marketlab -d marketlab -Atc "$Q"
curl -s -X POST "http://127.0.0.1:8010/api/ingest"
docker compose exec -T db psql -U marketlab -d marketlab -Atc "$Q"   # phai giong het
```

Lần chạy 2026-11-11 06:32 UTC: hash trước/sau `POST /api/ingest` giống hệt nhau
(2881 nến/symbol, 0 gap, nến cuối 05:00 trong khi 06:00 đang mở); 24 nến đã đóng
của mỗi symbol khớp `klines` Binance tới 8 chữ số thập phân.

## Ghi chú

- Continuous aggregate chỉ tự refresh theo chính sách 1 giờ, nên `run_once` và
  `POST /api/ingest` gọi `refresh_continuous_aggregate` ngay sau khi ghi.
- `db/init/01_schema.sql` chỉ chạy lúc bootstrap volume; sửa schema sau đó phải
  migrate thủ công.
- Thiết kế tối giản theo `../market-lab/DESIGN.md`: không emoji, không gradient,
  không box-shadow, card radius 10px (pill 999px), border 1px `#e6e8ee`, font hệ thống 13px.
  UI không có chi tiết trang trí giả: mọi nút đều gọi API thật — không có ô search hay nút "Buy" chỉ cho đủ bố cục.
- Frontend proxy `/api` và `/health` sang `127.0.0.1:8010`; CORS allow-list chỉ
  mở cho origin dev.
- Port cố định khác mặc định để tránh đụng đồ đang chạy trên máy này: Postgres
  publish `127.0.0.1:5433` (không phải 5432 — `odoo-db` của dự án khác đòi
  `0.0.0.0:5432`), API chạy `8010` (không phải 8000 — `inventree-dev-server` đòi
  `0.0.0.0:8000`). Nếu hai dự án đó đổi máy khác thì vẫn nên giữ nguyên, vì
  DATABASE_URL và proxy đọc từ cấu hình chứ không phụ thuộc máy.
