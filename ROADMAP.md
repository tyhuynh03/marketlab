# ROADMAP — marketlab (Quantitative Financial Engineering)

Cập nhật 2026-11-11. Bản **đã chỉnh** từ plan 4 phase gốc (xem mục "Khác biệt so với plan gốc").
Phase 0 (nền tảng dữ liệu + realtime) đã hoàn thiện và kiểm chứng thật: kho TimescaleDB chỉ chứa
nến ĐÃ ĐÓNG, luồng Binance WS → LiveHub → SSE → chart, metrics có oracle test.

## Nguyên tắc xuyên suốt

- **Tự xây** engine khớp lệnh + portfolio để hiểu dòng chảy tiền; KHÔNG dùng testnet/demo sàn
  làm đường chính. Demo sàn chỉ dùng để đối chiếu / kiểm chứng engine mình viết.
- **Một fill engine duy nhất** (fee + slippage + quy ước khớp) dùng chung cho paper trading và backtest.
- Tiền dùng `numeric`/`Decimal`, không float. Sổ cái **double-entry** (sum debit == sum credit).
  Mọi lệnh có **idempotency key** chống double-submit.
- Mỗi phase kết thúc bằng **exit criteria** (test + bất biến kiểm chứng), không ước lượng bằng tuần.
- Mọi đổi schema đi qua **migration đánh version** (schema hiện chỉ bootstrap lần đầu theo volume).
- Chỉ tin số đo thật; không nhận "đã verify" nếu không có lệnh chạy thật.

## Phase 0.5 — Hardening (điều kiện tiên quyết, làm trước / song song Phase 1)

Backtest và tuning sẽ gọi đường đọc nến hàng nghìn lần; phải sửa trước khi chúng chậm không chịu nổi.

1. Đẩy `LIMIT` xuống SQL cho `fetch_candles` / `fetch_rollup` (hi load toàn bộ rồi cắt Python:
   `backend/marketlab_web/db.py:75`, `db.py:98`).
2. `refresh_continuous_aggregate` theo **cửa sổ bucket gần đây**, bỏ refresh toàn bộ `NULL, NULL`
   mỗi chu kỳ (`db.py:54`).
3. Upsert **theo lô** (COPY vào temp + `ON CONFLICT`) thay `executemany` từng dòng (`db.py:67`).
4. Công cụ **migration SQL đánh version** cho các bảng mới (wallet/positions/orders/ledger...).
5. CI chạy pytest + web build + typecheck; pin dependencies (requirements đang mở).

Exit criteria: benchmark đọc nến / refresh rollup trước-sau; migration chạy được trên volume hiện có;
CI xanh; không đổi hành vi API hiện tại.

## Phase 1 — Paper Trading Engine (vốn ảo 100k USD)

Backend:
- Schema: `wallet`, `positions`, `orders` + sổ cái double-entry; tiền `numeric`.
- Fill engine: mark price lấy từ `hub.bars` (live) hoặc nến đóng gần nhất; phí Taker 0.1% +
  slippage 0.05% (cấu hình được); khớp trong **một atomic transaction**; idempotency key.
- Tách **realized PnL** (chỉ khi BÁN) và **unrealized PnL** (theo mark live); average-entry gia quyền.
- Snapshot equity mỗi nến đóng để vẽ đường vốn.

Frontend:
- Order ticket BUY/SELL + số dư khả dụng; bảng positions; PnL realtime; equity curve;
  trade markers (`setMarkers`) tại điểm khớp.

Exit criteria: test double-entry luôn cân; replay cùng idempotency key không tạo lệnh trùng;
lỗi giữa chừng rollback toàn bộ; PnL đối chiếu tính tay khớp; UI mua/bán/xem portfolio chạy thật.

## Phase 2 — Rule-based Backtesting (SMA / RSI)

- **Tái dùng fill engine Phase 1**, không viết engine khớp riêng.
- Chốt **quy ước intra-bar**: nến 1h không biết chạm High trước hay Low trước → chọn bi quan
  (giả định chạm bất lợi trước) hoặc fill bằng nến 1m; ghi rõ giả định vào kết quả.
- Engine chiến lược + log giao dịch giả lập; form tham số; markers mua/bán; so sánh equity.
- Tách **in-sample / out-of-sample** ngay từ phase này.

Exit criteria: backtest và paper trading cho cùng một chuỗi lệnh → kết quả khớp nhau;
test quy ước intra-bar; báo cáo luôn kèm cửa sổ OOS.

## Phase 3 — Portfolio & Tối ưu hóa

- Đa tài sản + DCA / rebalance (ví dụ tỷ trọng 80/20); query chéo symbol cùng `time_bucket`.
- **Tăng lịch sử** (`HISTORY_DAYS`, hiện 120) trước khi tune; mẫu quá nhỏ dễ overfit.
- Grid search / Optuna + **walk-forward**; không tune và báo cáo trên cùng một cửa sổ.
- Biểu đồ phân bổ vốn + heatmap kết quả tối ưu.

Exit criteria: báo cáo tối ưu luôn có số liệu OOS độc lập; rebalance giữ đúng bất biến sổ cái;
tuning chạy nền không block API.

## Phase 4 — Vi mô & Học máy (STRETCH / optional, có gate)

Chỉ bắt đầu khi Phase 1-3 đạt exit criteria.

- Order book L2: **snapshot top-N mức giá theo nhịp cố định** (ví dụ 1s), KHÔNG lưu từng tick
  (khối lượng ghi quá lớn cho TimescaleDB).
- ML dự báo volatility: timebox rõ; feature pipeline + validation độc lập; chấp nhận payoff không chắc.
- Hiển thị thanh khoản sổ lệnh + cảnh báo đảo chiều (thận trọng, không hứa lợi nhuận).

## Khác biệt so với plan gốc

1. Thêm **Phase 0.5 hardening** (LIMIT xuống SQL, refresh cửa sổ, upsert lô, migration, CI) — plan gốc bỏ qua.
2. Ledger nêu rõ **Decimal + double-entry + idempotency** — plan gốc chỉ ghi "Ledger, Atomic Transaction".
3. Backtest **dùng chung fill engine** với paper — plan gốc tách engine riêng.
4. Chốt **quy ước intra-bar** cho backtest — plan gốc bỏ qua bẫy High/Low.
5. Thêm **hàng rào overfitting** (tăng lịch sử, walk-forward, OOS) trước tuning — plan gốc thiếu.
6. Hạ **Phase 4 xuống stretch**, L2 chỉ snapshot sampled, ML timebox — plan gốc coi là phase bắt buộc.
7. Thay ước lượng tuần bằng **exit criteria** mỗi phase; thêm migration + CI xuyên suốt.

## Tham chiếu code hiện tại

- `backend/marketlab_web/db.py` — pool, upsert, fetch, rollup (điểm cần hardening).
- `backend/marketlab_web/live.py` — LiveHub, `hub.bars` (nguồn mark price); WS hardcode Binance (`live.py:22`).
- `backend/marketlab_web/api.py` — endpoint hiện có; nơi thêm route paper/backtest.
- `backend/marketlab_web/metrics.py` + `backend/tests/test_metrics_oracle.py` — chuẩn chỉ số.
- `web/src/live.ts` — SSE + gom bản tin 400ms; nơi nối PnL/order ticket.
