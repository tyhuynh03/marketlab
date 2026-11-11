import { useMemo, useState } from "react";
import { fmtCompact, fmtPct, fmtPrice, fmtTime, type Candle, type Summary, type WatchEntry } from "../api";
import type { LiveState } from "../live";
import { Empty, Icon, ToolButton } from "./ui";

function Spark({ values, up }: { values: number[]; up: boolean }) {
  if (values.length < 2) return <span className="h-5 w-[44px]" aria-hidden="true" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * 44},${18 - ((v - min) / span) * 16}`)
    .join(" ");
  return (
    <svg width={44} height={20} viewBox="0 0 44 20" className="shrink-0" aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke={up ? "var(--c-up)" : "var(--c-down)"}
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-line px-3 py-1.5 last:border-b-0">
      <span className="text-[11px] text-dim">{label}</span>
      <span className={"tnum text-[12px] " + (tone === "up" ? "text-up" : tone === "down" ? "text-down" : "")}>{value}</span>
    </div>
  );
}

export default function RightPanel({
  entries,
  selected,
  sparks,
  hovered,
  last,
  candles,
  summary,
  timeframe,
  venue,
  livePrice,
  livePrices,
  liveState,
  forming,
  onSelect,
  onRemove,
  onOpenSearch,
}: {
  entries: WatchEntry[];
  selected: string;
  sparks: Record<string, number[]>;
  hovered: Candle | null;
  last: Candle | undefined;
  candles: Candle[];
  summary: Summary | undefined;
  timeframe: string;
  venue: string;
  livePrice: number | null;
  livePrices: Record<string, number>;
  liveState: LiveState;
  forming: boolean;
  onSelect: (symbol: string) => void;
  onRemove: (symbol: string) => void;
  onOpenSearch: () => void;
}) {
  const [tab, setTab] = useState<"watch" | "details">("watch");
  const [filter, setFilter] = useState("");

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      e.symbol.toLowerCase().includes(q) || (e.label ?? "").toLowerCase().includes(q));
  }, [entries, filter]);

  const bar = hovered ?? last;
  const windowHigh = candles.length ? Math.max(...candles.map((c) => c.high)) : null;
  const windowLow = candles.length ? Math.min(...candles.map((c) => c.low)) : null;
  const totalVolume = candles.reduce((acc, c) => acc + c.volume, 0);

  return (
    <aside className="z-20 flex w-[286px] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-1.5">
        {(["watch", "details"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={
              "h-6 rounded-card px-2 text-[12px] transition-colors " +
              (tab === t ? "bg-hover font-medium text-ink" : "text-dim hover:bg-hover")
            }
          >
            {t === "watch" ? "Theo dõi" : "Chi tiết"}
          </button>
        ))}
        <ToolButton icon="plus" label="Thêm symbol (Ctrl+K)" onClick={onOpenSearch} className="ml-auto" />
      </div>

      {tab === "watch" ? (
        <>
          <div className="flex items-center gap-1.5 border-b border-line px-2.5 py-1.5">
            <Icon name="search" size={13} className="text-faint" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Lọc danh sách"
              aria-label="Lọc danh sách theo dõi"
              className="w-full bg-transparent text-[12px] outline-none placeholder:text-faint"
            />
            {filter && <ToolButton icon="close" label="Bỏ lọc" onClick={() => setFilter("")} className="h-5 w-5" />}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {shown.length === 0 && (
              <Empty
                icon="star"
                title={entries.length === 0 ? "Danh sách trống" : "Không khớp bộ lọc"}
                hint={entries.length === 0 ? "Bấm + để thêm symbol và nạp lịch sử từ Binance." : undefined}
              />
            )}
            {shown.map((e) => {
              const streamed = liveState === "on" ? livePrices[e.symbol] : undefined;
              const live = streamed ?? e.last_close;
              const delta = streamed !== undefined && e.prev_close ? streamed / e.prev_close - 1 : e.delta;
              const up = (delta ?? 0) >= 0;
              const active = e.symbol === selected;
              const values = streamed === undefined ? (sparks[e.symbol] ?? []) : [...(sparks[e.symbol] ?? []), streamed];
              return (
                <div
                  key={`${e.venue}/${e.symbol}/${e.timeframe}`}
                  className={
                    "group flex items-center gap-1.5 border-b border-line px-2 py-1.5 " +
                    (active ? "bg-hover" : "hover:bg-hover/60")
                  }
                >
                  <button type="button" onClick={() => onSelect(e.symbol)} className="min-w-0 flex-1 text-left">
                    <span className="flex items-baseline gap-1.5">
                      <span className="truncate text-[12px] font-semibold">{e.symbol}</span>
                      {streamed !== undefined && (
                        <span className="rounded-card bg-up/15 px-1 text-[9px] font-medium text-up">LIVE</span>
                      )}
                    </span>
                    <span className="block truncate text-[10px] text-faint">{e.label ?? e.venue}</span>
                  </button>
                  <Spark values={values} up={up} />
                  <button type="button" onClick={() => onSelect(e.symbol)} className="w-[78px] shrink-0 text-right">
                    <span className="tnum block text-[12px]">{fmtPrice(live)}</span>
                    <span className={"tnum block text-[11px] " + (up ? "text-up" : "text-down")}>{fmtPct(delta)}</span>
                  </button>
                  <ToolButton
                    icon="trash"
                    label={`Bỏ ${e.symbol}`}
                    danger
                    onClick={() => onRemove(e.symbol)}
                    className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100"
                  />
                </div>
              );
            })}
          </div>
          <p className="shrink-0 border-t border-line px-2.5 py-1.5 text-[10px] leading-relaxed text-faint">
            Giá trực tiếp từ luồng Binance qua backend; % so với nến đóng trước đó. Sparkline là 60 nến gần nhất.
          </p>
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="border-b border-line px-3 py-2">
            <p className="text-[12px] font-semibold">{selected}</p>
            <p className="text-[10px] uppercase text-faint">{venue} · {timeframe} · {candles.length} nến</p>
          </div>

          <h3 className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-faint">
            Cửa sổ dữ liệu {hovered ? "· nến đang trỏ" : forming ? "· nến đang chạy" : "· nến cuối"}
          </h3>
          {bar ? (
            <div className="tnum">
              <Stat label="Giờ mở" value={`${fmtTime(bar.ts)} UTC`} />
              <Stat label="Open" value={fmtPrice(bar.open)} />
              <Stat label="High" value={fmtPrice(bar.high)} />
              <Stat label="Low" value={fmtPrice(bar.low)} />
              <Stat label="Close" value={fmtPrice(bar.close)} tone={bar.close >= bar.open ? "up" : "down"} />
              <Stat label="Thay đổi" value={fmtPct(bar.open ? bar.close / bar.open - 1 : null)} tone={bar.close >= bar.open ? "up" : "down"} />
              <Stat label="Biên độ" value={fmtPrice(bar.high - bar.low)} />
              <Stat label="Volume" value={fmtCompact(bar.volume)} />
            </div>
          ) : (
            <Empty icon="info" title="Chưa có nến" />
          )}

          <h3 className="px-3 pb-1 pt-3 text-[10px] uppercase tracking-wide text-faint">Toàn cửa sổ {candles.length} nến</h3>
          <div className="tnum">
            <Stat label="Nến đầu" value={candles[0] ? `${fmtTime(candles[0].ts)} UTC` : "—"} />
            <Stat label="Nến cuối" value={last ? `${fmtTime(last.ts)} UTC` : "—"} />
            <Stat label="Cao nhất" value={fmtPrice(windowHigh)} />
            <Stat label="Thấp nhất" value={fmtPrice(windowLow)} />
            <Stat label="Tổng volume" value={fmtCompact(totalVolume)} />
          </div>

          <h3 className="px-3 pb-1 pt-3 text-[10px] uppercase tracking-wide text-faint">Chỉ số nhanh</h3>
          <div className="tnum">
            <Stat label="Total return" value={fmtPct(summary?.total_return)} tone={(summary?.total_return ?? 0) >= 0 ? "up" : "down"} />
            <Stat label="Max drawdown" value={fmtPct(summary?.max_drawdown)} tone="down" />
            <Stat label="Sharpe" value={summary?.sharpe === undefined ? "—" : summary.sharpe.toFixed(2)} />
          </div>

          <h3 className="px-3 pb-1 pt-3 text-[10px] uppercase tracking-wide text-faint">Giá trực tiếp</h3>
          <div className="px-3 pb-3">
            <p className="tnum text-[15px] font-semibold">{livePrice === null ? "—" : fmtPrice(livePrice)}</p>
            <p className="text-[10px] leading-relaxed text-faint">
              {liveState === "on"
                ? "Luồng nến Binance qua backend; chỉ nến đóng mới ghi vào kho."
                : liveState === "error"
                  ? "Không mở được luồng trực tiếp; kho nến vẫn cập nhật theo chu kỳ ingest."
                  : liveState === "connecting"
                    ? "Đang nối luồng trực tiếp…"
                    : "Đã tắt trong thanh trạng thái."}
            </p>
          </div>
        </div>
      )}
    </aside>
  );
}