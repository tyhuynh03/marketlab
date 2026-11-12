import { useEffect, useMemo, useRef, useState } from "react";
import { fmtCompact, fmtNum, fmtPct, fmtPrice, fmtTime, venueLabel, type Candle, type Summary } from "../api";
import { drawdownSeries, equitySeries } from "../indicators";
import type { BottomTab } from "../store";
import { Empty, Icon, ToolButton } from "./ui";

export type LogEntry = { id: number; at: string; text: string; tone: "info" | "ok" | "error" };

const TABS: { id: BottomTab; label: string; icon: string }[] = [
  { id: "metrics", label: "Chỉ số", icon: "bolt" },
  { id: "data", label: "Dữ liệu nến", icon: "table" },
  { id: "log", label: "Nhật ký", icon: "list" },
  { id: "about", label: "Nguồn dữ liệu", icon: "database" },
];

type SortKey = "ts" | "open" | "high" | "low" | "close" | "volume" | "change";

function Metric({ label, value, tone, hint, className = "" }: { label: string; value: string; tone?: "up" | "down"; hint?: string; className?: string }) {
  return (
    <div className={"min-w-0 rounded-card border border-line bg-bg px-3 py-2 " + className}>
      <p className="truncate text-[10px] uppercase tracking-wide text-faint">{label}</p>
      <p className={"tnum truncate text-[15px] font-semibold " + (tone === "up" ? "text-up" : tone === "down" ? "text-down" : "")}>
        {value}
      </p>
      {hint && <p className="truncate text-[10px] text-faint">{hint}</p>}
    </div>
  );
}

function Curve({ values, color, label, format }: { values: number[]; color: string; label: string; format: (v: number) => string }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 300;
  const h = 54;
  const path = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / span) * (h - 6) - 3}`).join(" ");
  return (
    <div className="min-w-0 flex-1 rounded-card border border-line bg-bg px-3 py-2">
      <p className="flex items-baseline justify-between text-[10px] uppercase tracking-wide text-faint">
        {label}
        <span className="tnum normal-case">{format(values[values.length - 1]!)}</span>
      </p>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-[54px] w-full" aria-hidden="true">
        <polyline points={path} fill="none" stroke={color} strokeWidth={1.3} vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

export default function BottomPanel({
  tab,
  height,
  candles,
  summary,
  log,
  symbol,
  timeframe,
  venue,
  loading,
  ingesting,
  lastIngest,
  onTab,
  onHeight,
  onCollapse,
  onIngest,
}: {
  tab: BottomTab;
  height: number;
  candles: Candle[];
  summary: Summary | undefined;
  log: LogEntry[];
  symbol: string;
  timeframe: string;
  venue: string;
  loading: boolean;
  ingesting: boolean;
  lastIngest: string | null;
  onTab: (tab: BottomTab) => void;
  onHeight: (height: number) => void;
  onCollapse: () => void;
  onIngest: () => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "ts", desc: true });
  const [direction, setDirection] = useState<"all" | "up" | "down">("all");
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      onHeight(Math.min(520, Math.max(140, drag.startHeight + (drag.startY - e.clientY))));
    };
    const up = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [onHeight]);

  const rows = useMemo(() => {
    const value = (c: Candle, key: SortKey): number =>
      key === "ts" ? Date.parse(c.ts) : key === "change" ? (c.open ? c.close / c.open - 1 : 0) : c[key];
    const filtered = candles.filter((c) =>
      direction === "all" ? true : direction === "up" ? c.close >= c.open : c.close < c.open);
    const sorted = [...filtered].sort((a, b) => value(a, sort.key) - value(b, sort.key));
    if (sort.desc) sorted.reverse();
    return sorted;
  }, [candles, sort, direction]);

  const closes = useMemo(() => candles.map((c) => c.close), [candles]);
  const equity = useMemo(() => equitySeries(closes), [closes]);
  const drawdown = useMemo(() => drawdownSeries(closes), [closes]);

  const exportCsv = () => {
    const header = "ts,open,high,low,close,volume\n";
    const body = candles.map((c) => `${c.ts},${c.open},${c.high},${c.low},${c.close},${c.volume}`).join("\n");
    const url = URL.createObjectURL(new Blob([header + body], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${symbol.replace("/", "-")}-${timeframe}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: true }));

  const columns: { key: SortKey; label: string }[] = [
    { key: "ts", label: "Giờ mở (UTC)" },
    { key: "open", label: "Open" },
    { key: "high", label: "High" },
    { key: "low", label: "Low" },
    { key: "close", label: "Close" },
    { key: "change", label: "%" },
    { key: "volume", label: "Volume" },
  ];

  return (
    <section
      style={{ height }}
      className="z-20 flex shrink-0 flex-col border-t border-line bg-panel"
      aria-label="Bảng dữ liệu"
    >
      <div
        onMouseDown={(e) => {
          dragRef.current = { startY: e.clientY, startHeight: height };
          document.body.style.cursor = "ns-resize";
          document.body.style.userSelect = "none";
        }}
        onDoubleClick={onCollapse}
        title="Kéo để đổi chiều cao, nhấp đúp để thu gọn"
        className="group flex h-1.5 shrink-0 cursor-ns-resize items-center justify-center bg-panel hover:bg-hover"
      >
        <span className="h-0.5 w-8 rounded-pill bg-line2 group-hover:bg-dim" />
      </div>

      <div className="ml-thin-scroll flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onTab(t.id)}
            aria-pressed={tab === t.id}
            className={
              "flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-card px-2 text-[12px] transition-colors " +
              (tab === t.id ? "bg-hover font-medium text-ink" : "text-dim hover:bg-hover")
            }
          >
            <Icon name={t.icon} size={13} />
            {t.label}
            {t.id === "log" && log.length > 0 && (
              <span className="tnum rounded-pill bg-bg px-1 text-[10px] text-faint">{log.length}</span>
            )}
          </button>
        ))}
        <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
          {tab === "data" && (
            <>
              <div className="flex items-center rounded-card border border-line">
                {(["all", "up", "down"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDirection(d)}
                    aria-pressed={direction === d}
                    className={
                      "h-5 px-1.5 text-[11px] " +
                      (direction === d
                        ? d === "up" ? "text-up" : d === "down" ? "text-down" : "text-accent"
                        : "text-faint hover:text-ink")
                    }
                  >
                    {d === "all" ? "Tất cả" : d === "up" ? "Tăng" : "Giảm"}
                  </button>
                ))}
              </div>
              <ToolButton icon="camera" label="Xuất CSV" onClick={exportCsv} className="h-6" />
            </>
          )}
          <span className="tnum hidden px-1 text-[11px] text-faint sm:block">{candles.length} nến</span>
          <ToolButton icon="chevronDown" label="Thu gọn bảng" onClick={onCollapse} className="h-6" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "metrics" && (
          <div className="space-y-2 p-2.5">
            {summary?.error ? (
              <Empty icon="alert" title="Không tính được chỉ số" hint={summary.error} />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Metric label="Total return" value={fmtPct(summary?.total_return)} tone={(summary?.total_return ?? 0) >= 0 ? "up" : "down"} hint={`${summary?.observations ?? 0} nến`} />
                  <Metric label="Annualised" value={fmtPct(summary?.annualized_return)} tone={(summary?.annualized_return ?? 0) >= 0 ? "up" : "down"} hint="theo số kỳ mỗi năm" />
                  <Metric label="Max drawdown" value={fmtPct(summary?.max_drawdown)} tone="down" hint="đỉnh chạy dần" />
                  <Metric label="Volatility" value={fmtNum(summary?.volatility, 3)} hint="annual hoá, ddof=1" />
                  <Metric label="Sharpe" value={fmtNum(summary?.sharpe, 2)} tone={(summary?.sharpe ?? 0) >= 0 ? "up" : "down"} />
                  <Metric label="Sortino" value={fmtNum(summary?.sortino, 2)} tone={(summary?.sortino ?? 0) >= 0 ? "up" : "down"} />
                  <Metric label="Calmar" value={fmtNum(summary?.calmar, 2)} tone={(summary?.calmar ?? 0) >= 0 ? "up" : "down"} />
                  <Metric label="Đầu → cuối" value={`${fmtPrice(summary?.first_close)} → ${fmtPrice(summary?.last_close)}`} className="col-span-2 sm:col-span-1" />
                </div>
                <div className="flex flex-col gap-2 lg:flex-row">
                  <Curve values={equity} color="var(--c-accent)" label="Đường vốn (chuẩn hoá = 1)" format={(v) => `${v.toFixed(3)}×`} />
                  <Curve values={drawdown} color="var(--c-down)" label="Drawdown" format={(v) => fmtPct(v)} />
                </div>
                <p className="text-[10px] leading-relaxed text-faint">
                  Log return ln(Pₜ/Pₜ₋₁); volatility và Sharpe dùng sample stdev (ddof=1) nhân √số kỳ mỗi năm.
                  Mọi con số do backend tính và có oracle test độc lập đối chiếu.
                </p>
              </>
            )}
          </div>
        )}

        {tab === "data" && (
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 z-10 bg-panel">
              <tr>
                {columns.map((c) => (
                  <th key={c.key} className="border-b border-line px-3 py-1.5 text-left font-medium text-dim">
                    <button type="button" onClick={() => toggleSort(c.key)} className="flex items-center gap-1 hover:text-ink">
                      {c.label}
                      {sort.key === c.key && <Icon name="chevronDown" size={11} className={sort.desc ? "" : "rotate-180"} />}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tnum">
              {rows.map((r) => {
                const up = r.close >= r.open;
                return (
                  <tr key={r.ts} className="border-b border-line/60 hover:bg-hover/50">
                    <td className="whitespace-nowrap px-3 py-1 text-dim">{fmtTime(r.ts)}</td>
                    <td className="px-3 py-1">{fmtPrice(r.open)}</td>
                    <td className="px-3 py-1">{fmtPrice(r.high)}</td>
                    <td className="px-3 py-1">{fmtPrice(r.low)}</td>
                    <td className={"px-3 py-1 " + (up ? "text-up" : "text-down")}>{fmtPrice(r.close)}</td>
                    <td className={"px-3 py-1 " + (up ? "text-up" : "text-down")}>{fmtPct(r.open ? r.close / r.open - 1 : null)}</td>
                    <td className="px-3 py-1 text-dim">{fmtCompact(r.volume)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {tab === "log" && (
          log.length === 0 ? (
            <Empty icon="list" title="Chưa có sự kiện trong phiên này" hint="Nhật ký ghi lại thao tác thật: nạp dữ liệu, thêm symbol, vẽ, đổi chỉ báo." />
          ) : (
            <ul className="divide-y divide-line/60">
              {[...log].reverse().map((e) => (
                <li key={e.id} className="flex items-baseline gap-3 px-3 py-1.5 text-[12px]">
                  <span className="tnum shrink-0 text-[11px] text-faint">{e.at}</span>
                  <Icon
                    name={e.tone === "error" ? "alert" : e.tone === "ok" ? "check" : "info"}
                    size={13}
                    className={e.tone === "error" ? "text-down" : e.tone === "ok" ? "text-up" : "text-dim"}
                  />
                  <span className="min-w-0 flex-1">{e.text}</span>
                </li>
              ))}
            </ul>
          )
        )}

        {tab === "about" && (
          <div className="grid gap-3 p-3 text-[12px] leading-relaxed lg:grid-cols-2">
            <div className="space-y-1.5">
              <h3 className="text-[11px] uppercase tracking-wide text-faint">Đường đi của dữ liệu</h3>
              <p className="text-dim">
                Crypto: ccxt <code className="text-ink">fetch_ohlcv</code>; cổ phiếu Mỹ: chart Yahoo. Cả hai UPSERT vào
                hypertable <code className="text-ink">candle</code> (TimescaleDB) → continuous aggregate{" "}
                <code className="text-ink">candle_4h</code> / <code className="text-ink">candle_1d</code> → FastAPI → trang này.
              </p>
              <p className="text-dim">
                Khung <b className="text-ink">1h</b> đọc nến gốc; <b className="text-ink">4h</b> và{" "}
                <b className="text-ink">1d</b> đọc continuous aggregate nên không lưu trùng dữ liệu. Riêng cổ phiếu Mỹ,
                nến <b className="text-ink">1d</b> là nến ngày chính thức nạp từ Yahoo vì rollup từ 1h thiếu khối lượng khớp lệnh định kỳ.
              </p>
            </div>
            <div className="space-y-1.5">
              <h3 className="text-[11px] uppercase tracking-wide text-faint">Vì sao nến cuối trễ một khung</h3>
              <p className="text-dim">
                Kho chỉ chứa nến <b className="text-ink">đã đóng</b>. Nến đang chạy bị loại vì giá của nó đổi liên tục:
                lưu vào thì mỗi vòng ingest lại ghi đè một dòng cũ, và mọi chỉ số tính trên nến cuối sẽ không tái lập được.
              </p>
              <p className="text-dim">
                Giá trực tiếp ở bảng bên phải lấy từ luồng ticker riêng, chỉ để xem, không đi vào kho.
              </p>
            </div>
            <div className="tnum space-y-1 text-dim">
              <h3 className="text-[11px] uppercase tracking-wide text-faint">Phiên hiện tại</h3>
              <p>Symbol: <span className="text-ink">{symbol}</span> · {venueLabel(venue)} · {timeframe}</p>
              <p>Số nến đang tải: <span className="text-ink">{candles.length}</span></p>
              <p>Lần nạp gần nhất: <span className="text-ink">{lastIngest ?? "chưa nạp trong phiên này"}</span></p>
            </div>
            <div className="flex items-start gap-2">
              <button
                type="button"
                onClick={onIngest}
                disabled={ingesting || loading}
                className="flex h-7 items-center gap-1.5 rounded-card border border-line px-2.5 text-[12px] hover:bg-hover disabled:opacity-50"
              >
                <Icon name="refresh" size={14} className={ingesting ? "ml-pulse" : ""} />
                {ingesting ? "Đang nạp từ nguồn…" : "Nạp lại toàn bộ watchlist"}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}