# Hợp đồng strategy — backtest lát cắt 1

Chốt 2026-11-12, trước khi viết engine. Mọi strategy và chính engine phải tuân
thủ file này; sửa hợp đồng là sửa hành vi backtest, phải kèm test mới.

## Bốn điều khoản

- **C1 — Chỉ nhận quá khứ.** Engine gọi `on_bar(history, weight)` với
  `history = candles[:i+1]`, toàn nến ĐÃ ĐÓNG của kho. Không đưa cả mảng,
  không đưa nến đang chạy. Look-ahead bị chặn bằng cấu trúc.
- **C2 — Chỉ trả ý định.** Strategy trả trọng số mục tiêu của vị thế
  (`0.0` = đứng ngoài, `1.0` = full vốn, `None` = giữ nguyên). Không tự khớp,
  không tự giữ tiền. Chọn trọng số mục tiêu thay vì lệnh buy/sell rời vì khớp
  quy ước % vốn của seed/rebalance sẵn có, và oracle đối chiếu dễ hơn.
- **C3 — Engine giữ sổ.** Tiền mặt, vị thế, phí, đường equity thuộc engine.
  Strategy chỉ giữ state riêng của nó (SMA, momentum…). Cùng engine chạy được
  mọi strategy kể cả benchmark.
- **C4 — Hàm thuần theo input.** Cùng chuỗi nến và cùng state khởi điểm phải
  ra cùng chuỗi trọng số. Không đọc DB, không gọi mạng, không đồng hồ tường.

## Quy tắc khớp giá

- **R1 — Thời điểm quyết định.** Tín hiệu tính sau khi nến `i` đóng.
- **R2 — Giá khớp.** Khớp tại **open của nến `i+1`** cùng venue/timeframe.
  Không đoán: giá đó đã nằm trong kho. Nếu nến `i+1` không tồn tại (cuối kho),
  tín hiệu bị BỎ và ghi vào log backtest, không giả định khớp.
- **R3 — Hở phiên Mỹ.** Với venue yahoo, nến `i+1` sau nến cuối phiên là nến
  đầu phiên kế tiếp; khoảng hở đêm/cuối tuần được mô phỏng thật, không nội suy.
- **R4 — Phí và trượt giá.** Mua khớp `open × 1.0005`, bán khớp `open × 0.9995`
  (trượt 0.05% mỗi chiều); phí 0.1% trên notional mỗi chiều, trừ vào tiền mặt.
  Đúng quy ước sổ paper hiện hành.
- **R5 — Cấm ăn gian giá.** Không khớp ở close nến `i`; không dùng high/low
  nến `i+1` để chọn giá đẹp hơn open.
- **R6 — Cỡ lệnh.** Notional mục tiêu = trọng số × equity mark tại close nến
  `i`; engine suy ra lượng chênh lệch so vị thế hiện tại, làm tròn 8 chữ số
  thập phân như sổ paper; phần lẻ cent không tiêu được nằm lại tiền mặt.
- **R7 — Không bán khống, không đòn bẩy.** Trọng số ngoài `[0, 1]` bị kẹp về
  biên và ghi log kẹp.
- **R8 — Nhật ký khớp.** Engine ghi từng fill: ts tín hiệu, ts khớp, open thô,
  giá khớp, lượng, phí. Oracle test tính tay lại từng dòng từ nhật ký này.
- **R9 — Benchmark công bằng.** Buy-and-hold là strategy trọng số hằng `1.0`,
  khớp cùng R2–R6, không được hưởng quy tắc riêng.
- **R10 — Chuỗi nến.** Dùng đúng chuỗi nến đã đóng trong kho (crypto liên tục
  24/7, Mỹ 7 nến/ngày); không ghép thêm nến nội suy hay nến đang chạy.

## Chữ ký tối thiểu

```python
class Strategy(Protocol):
    def on_bar(self, history: Sequence[Bar], weight: float) -> float | None:
        """Trả trọng số mục tiêu [0, 1] hoặc None = giữ nguyên vị thế."""
```

`Bar` là nến đã đóng chuẩn hoá của kho: ts, open, high, low, close, volume.

## Test phải enforce hợp đồng

1. Bẫy look-ahead: engine chỉ truyền prefix — strategy tham lam đọc phần tử
   ngoài prefix phải không thể tồn tại (kiểu trả về chỉ nhận `history`).
2. Oracle khớp giá: chuỗi 3 nến tổng hợp, tính tay open nến sau × trượt giá,
   phí, lượng q8; so từng fill trong nhật ký.
3. Hở phiên Mỹ: tín hiệu ở nến cuối phiên khớp ở open phiên kế tiếp.
4. Cuối kho: tín hiệu nến cuối bị bỏ và có dòng log, equity không đổi.
5. Kẹp trọng số: strategy trả 1.5 hoặc -0.2 bị kẹp về 1.0 / 0.0 kèm log.
6. Benchmark: buy-and-hold khớp đúng R2–R6 trên cùng cửa sổ.

## Ngoài phạm vi lát cắt 1

UI, lưu kết quả backtest vào DB, walk-forward / chia in-sample (chốt ở lát cắt
2), bán khống, nhiều strategy chạy song song. Metrics dùng lại module
`metrics.py` với ppy theo venue (8760/1638 cho 1h).