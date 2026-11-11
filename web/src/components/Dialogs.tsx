import { LIMITS } from "../api";
import { INDICATOR_NAMES, INDICATOR_SHORT, makeIndicator, type Indicator, type IndicatorKind } from "../indicators";
import type { Settings } from "../store";
import { ColorField, Divider, Icon, Modal, NumberField, ToolButton, Toggle } from "./ui";

const KINDS: IndicatorKind[] = ["sma", "ema", "bb", "rsi", "macd"];
const KIND_HINT: Record<IndicatorKind, string> = {
  sma: "Trung bình cộng của N nến đóng",
  ema: "Trung bình có trọng số, bám giá nhanh hơn",
  bb: "Đường giữa ± k lần độ lệch chuẩn",
  rsi: "Dao động 0–100, mốc 30/70",
  macd: "Hiệu hai EMA và đường tín hiệu",
};
const SWATCHES = ["#f7a600", "#2962ff", "#9c27b0", "#26a69a", "#ef5350", "#00bcd4", "#ff6d00", "#8bc34a"];

export function IndicatorsDialog({
  open,
  indicators,
  onClose,
  onChange,
}: {
  open: boolean;
  indicators: Indicator[];
  onClose: () => void;
  onChange: (next: Indicator[]) => void;
}) {
  const add = (kind: IndicatorKind) => {
    const color = SWATCHES[indicators.length % SWATCHES.length]!;
    onChange([...indicators, makeIndicator(kind, color)]);
  };
  const patch = (id: string, partial: Partial<Indicator>) =>
    onChange(indicators.map((i) => (i.id === id ? { ...i, ...partial } : i)));
  const remove = (id: string) => onChange(indicators.filter((i) => i.id !== id));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Chỉ báo kỹ thuật"
      subtitle="Tính ngay trên trình duyệt từ nến đang tải; đổi tham số là chart cập nhật liền."
      width={720}
    >
      <div className="grid gap-0 md:grid-cols-[240px_1fr]">
        <div className="border-b border-line md:border-b-0 md:border-r">
          <h3 className="px-4 pb-1 pt-3 text-[10px] uppercase tracking-wide text-faint">Thêm chỉ báo</h3>
          {KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => add(kind)}
              className="flex w-full items-start gap-2 px-4 py-2 text-left hover:bg-hover"
            >
              <Icon name="plus" size={14} className="mt-0.5 shrink-0 text-accent" />
              <span className="min-w-0">
                <span className="block text-[12px]">{INDICATOR_NAMES[kind]}</span>
                <span className="block text-[11px] leading-snug text-faint">{KIND_HINT[kind]}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="min-w-0">
          <h3 className="px-4 pb-1 pt-3 text-[10px] uppercase tracking-wide text-faint">
            Đang dùng · {indicators.length}
          </h3>
          {indicators.length === 0 && (
            <p className="px-4 py-6 text-[12px] text-dim">Chưa có chỉ báo nào. Chọn một loại ở cột bên trái.</p>
          )}
          <div className="space-y-2 px-4 pb-4">
            {indicators.map((ind) => (
              <div key={ind.id} className="rounded-card border border-line bg-bg p-2.5">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-pill" style={{ background: ind.color }} />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                    {INDICATOR_NAMES[ind.kind]}
                  </span>
                  <ToolButton
                    icon={ind.visible ? "eye" : "eyeOff"}
                    label={ind.visible ? "Ẩn" : "Hiện"}
                    active={!ind.visible}
                    onClick={() => patch(ind.id, { visible: !ind.visible })}
                    className="h-6 w-6"
                  />
                  <ToolButton icon="trash" label="Bỏ chỉ báo" danger onClick={() => remove(ind.id)} className="h-6 w-6" />
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {ind.kind === "macd" ? (
                    <>
                      <NumberField label="EMA nhanh" value={ind.fast} min={2} max={200} onChange={(v) => patch(ind.id, { fast: v })} />
                      <NumberField label="EMA chậm" value={ind.slow} min={3} max={400} onChange={(v) => patch(ind.id, { slow: v })} />
                      <NumberField label="Tín hiệu" value={ind.signal} min={2} max={100} onChange={(v) => patch(ind.id, { signal: v })} />
                    </>
                  ) : (
                    <NumberField label="Chu kỳ" value={ind.period} min={2} max={400} onChange={(v) => patch(ind.id, { period: v })} />
                  )}
                  {ind.kind === "bb" && (
                    <NumberField label="Hệ số k" value={ind.mult} min={0.5} max={5} step={0.1} onChange={(v) => patch(ind.id, { mult: v })} />
                  )}
                  <ColorField label="Màu" value={ind.color} onChange={(v) => patch(ind.id, { color: v })} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function SettingsDialog({
  open,
  settings,
  limit,
  paletteUp,
  paletteDown,
  onClose,
  onPatch,
  onLimit,
  onReset,
}: {
  open: boolean;
  settings: Settings;
  limit: number;
  paletteUp: string;
  paletteDown: string;
  onClose: () => void;
  onPatch: (partial: Partial<Settings>) => void;
  onLimit: (limit: number) => void;
  onReset: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Tuỳ chọn chart"
      subtitle="Lưu vào máy bạn, mở lại trang vẫn giữ nguyên."
      width={520}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-faint">Đặt lại trả mọi thứ về mặc định của terminal.</span>
          <button
            type="button"
            onClick={onReset}
            className="flex h-7 items-center gap-1.5 rounded-card border border-line px-2.5 text-[12px] hover:bg-hover"
          >
            <Icon name="undo" size={14} />
            Đặt lại mặc định
          </button>
        </div>
      }
    >
      <h3 className="px-4 pb-1 pt-3 text-[10px] uppercase tracking-wide text-faint">Hiển thị</h3>
      <Toggle checked={settings.theme === "dark"} onChange={(v) => onPatch({ theme: v ? "dark" : "light" })} label="Nền tối" hint="Đúng tông nền của terminal giao dịch" />
      <Toggle checked={settings.grid} onChange={(v) => onPatch({ grid: v })} label="Lưới toạ độ" />
      <Toggle checked={settings.watermark} onChange={(v) => onPatch({ watermark: v })} label="Chìm tên symbol giữa chart" />
      <Toggle checked={settings.volume} onChange={(v) => onPatch({ volume: v })} label="Cột volume" hint="Phủ 16% đáy khung giá" />
      <Toggle checked={settings.logScale} onChange={(v) => onPatch({ logScale: v })} label="Thang giá logarit" hint="Hữu ích khi xem chuỗi dài nhiều lần tăng" />
      <Toggle checked={settings.magnet} onChange={(v) => onPatch({ magnet: v })} label="Nam châm hút vào OHLC" hint="Điểm vẽ bám đúng giá mở/cao/thấp/đóng" />
      <Toggle checked={settings.live} onChange={(v) => onPatch({ live: v })} label="Nến trực tiếp Binance" hint="Nến đang chạy đẩy qua SSE; chỉ nến đóng mới ghi vào kho" />

      <Divider />
      <h3 className="px-4 pb-1 pt-2 text-[10px] uppercase tracking-wide text-faint">Màu nến</h3>
      <div className="space-y-2 px-4 py-2">
        <ColorField label="Nến tăng" value={settings.upColor || paletteUp} onChange={(v) => onPatch({ upColor: v })} />
        <ColorField label="Nến giảm" value={settings.downColor || paletteDown} onChange={(v) => onPatch({ downColor: v })} />
        <button
          type="button"
          onClick={() => onPatch({ upColor: "", downColor: "" })}
          className="text-[11px] text-accent hover:underline"
        >
          Dùng lại màu theo giao diện
        </button>
      </div>

      <Divider />
      <h3 className="px-4 pb-1 pt-2 text-[10px] uppercase tracking-wide text-faint">Dữ liệu</h3>
      <div className="px-4 py-2">
        <p className="mb-1.5 text-[12px] text-dim">Số nến tải mỗi lần</p>
        <div className="flex flex-wrap gap-1">
          {LIMITS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onLimit(n)}
              aria-pressed={n === limit}
              className={
                "tnum h-6 rounded-card border px-2 text-[12px] " +
                (n === limit ? "border-accent text-accent" : "border-line text-dim hover:bg-hover")
              }
            >
              {n}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
          Ảnh hưởng cả chart lẫn cửa sổ tính chỉ số. Nhiều nến hơn thì nhìn được quá khứ xa hơn nhưng chỉ số đo trên quãng dài hơn.
        </p>
      </div>
      <div className="px-4 pb-4 pt-1">
        <p className="mb-1.5 text-[12px] text-dim">Múi giờ trục thời gian</p>
        <div className="flex gap-1">
          {(["utc", "local"] as const).map((tz) => (
            <button
              key={tz}
              type="button"
              onClick={() => onPatch({ timezone: tz })}
              aria-pressed={settings.timezone === tz}
              className={
                "h-6 rounded-card border px-2 text-[12px] " +
                (settings.timezone === tz ? "border-accent text-accent" : "border-line text-dim hover:bg-hover")
              }
            >
              {tz === "utc" ? "UTC" : "Giờ máy"}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

const SHORTCUTS: { keys: string; text: string }[] = [
  { keys: "O", text: "Màn Tổng quan" },
  { keys: "C", text: "Màn Terminal (chart)" },
  { keys: "P", text: "Màn Tài sản (portfolio)" },
  { keys: "Ctrl + K", text: "Mở ô tìm symbol" },
  { keys: "/", text: "Mở ô tìm symbol" },
  { keys: "1 / 2 / 3", text: "Khung 1h / 4h / 1d" },
  { keys: "I", text: "Bảng chỉ báo" },
  { keys: "S", text: "Tuỳ chọn chart" },
  { keys: "F", text: "Toàn màn hình chart" },
  { keys: "Alt + V", text: "Con trỏ" },
  { keys: "Alt + T", text: "Đường xu thế" },
  { keys: "Alt + R", text: "Tia" },
  { keys: "Alt + H", text: "Đường ngang" },
  { keys: "Alt + B", text: "Hình chữ nhật" },
  { keys: "Alt + F", text: "Fibonacci thoái lui" },
  { keys: "Alt + M", text: "Đo lường" },
  { keys: "Alt + E", text: "Xoá hình" },
  { keys: "Delete", text: "Xoá hình đang chọn" },
  { keys: "Esc", text: "Huỷ thao tác / đóng hộp thoại" },
  { keys: "?", text: "Bảng phím tắt này" },
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Phím tắt" subtitle="Làm việc nhanh như một terminal thật." width={480}>
      <ul className="py-1">
        {SHORTCUTS.map((s) => (
          <li key={s.keys} className="flex items-center justify-between gap-4 px-4 py-1.5 text-[12px]">
            <span className="text-dim">{s.text}</span>
            <kbd className="tnum shrink-0 rounded-card border border-line2 bg-bg px-1.5 py-0.5 text-[11px]">{s.keys}</kbd>
          </li>
        ))}
      </ul>
      <p className="border-t border-line px-4 py-2 text-[11px] text-faint">
        {INDICATOR_SHORT.sma}, {INDICATOR_SHORT.ema}, {INDICATOR_SHORT.bb} vẽ đè lên giá; {INDICATOR_SHORT.rsi} và{" "}
        {INDICATOR_SHORT.macd} có khung riêng bên dưới.
      </p>
    </Modal>
  );
}