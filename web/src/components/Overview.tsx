import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { AreaSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import {
  TIMEFRAMES,
  TIMEFRAME_SECONDS,
  autoDigits,
  fetchCandles,
  fetchSummary,
  fmtCompact,
  fmtPct,
  fmtPrice,
  venueLabel,
  type Candle,
  type Health,
  type Summary,
  type Timeframe,
  type WatchEntry,
} from "../api";
import type { LiveState } from "../live";
import { chartOptions, withAlpha, type Palette } from "../theme";
import { CoinBadge, Empty, Icon, ToolButton } from "./ui";

type SortKey = "symbol" | "price" | "delta" | "volume" | "sharpe";
type Category = "all" | "up" | "down" | "flat";

const WINDOWS = [60, 120, 250] as const;
const CATEGORIES: { id: Category; label: string }[] = [
  { id: "all", label: "Tất cả" },
  { id: "up", label: "Tăng" },
  { id: "down", label: "Giảm" },
  { id: "flat", label: "Đứng giá" },
];

function PriceTick({ value, digits }: { value: number | null; digits: number }) {
  const prev = useRef<number | null>(value);
  const [flash, setFlash] = useState<{ tone: "up" | "down"; key: number } | null>(null);
  useEffect(() => {
    if (value === null || prev.current === null || value === prev.current) {
      prev.current = value;
      return;
    }
    const tone = value > prev.current ? "up" : "down";
    prev.current = value;
    setFlash((f) => ({ tone, key: (f?.key ?? 0) + 1 }));
  }, [value]);
  return (
    <span
      key={flash?.key ?? 0}
      className={"tnum inline-block rounded-card px-1 text-[13px] font-semibold " + (flash ? `flash-${flash.tone}` : "")}
    >
      {value === null ? "—" : value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}
    </span>
  );
}

function SparkArea({ values, up, palette }: { values: number[]; up: boolean; palette: Palette }) {
  const id = useMemo(() => `sg-${Math.random().toString(36).slice(2, 8)}`, []);
  if (values.length < 2) return <div className="h-8 w-[92px] rounded-card bg-hover/40" aria-hidden="true" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const W = 100;
  const H = 32;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, H - 2 - ((v - min) / span) * (H - 4)] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const color = up ? palette.up : palette.down;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-8 w-[92px]" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.30" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${line} ${W},${H}`} fill={`url(#${id})`} stroke="none" />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function HighlightCard({
  title, rows, onMore, onOpen,
}: {
  title: string;
  rows: { symbol: string; price: number | null; delta: number | null }[];
  onMore: () => void;
  onOpen: (symbol: string) => void;
}) {
  return (
    <section className="rounded-card border border-line bg-panel">
      <header className="flex items-center justify-between px-3 py-2">
        <h3 className="text-[12px] font-semibold">{title}</h3>
        <button type="button" onClick={onMore} className="flex items-center gap-0.5 text-[11px] text-dim hover:text-accent">
          Nhiều hơn <Icon name="chevronRight" size={12} />
        </button>
      </header>
      <div className="px-1.5 pb-2">
        {rows.length === 0 && <p className="px-2 py-3 text-[11px] text-faint">Chưa có dữ liệu.</p>}
        {rows.map((r) => {
          const up = (r.delta ?? 0) >= 0;
          return (
            <button
              key={r.symbol}
              type="button"
              onClick={() => onOpen(r.symbol)}
              className="flex w-full items-center gap-2 rounded-card px-1.5 py-1.5 text-left hover:bg-hover"
            >
              <CoinBadge symbol={r.symbol} />
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{r.symbol.split("/")[0]}</span>
              <span className="tnum text-[12px] text-dim">{r.price === null ? "—" : fmtCompact(r.price)}</span>
              <span className={"tnum w-[62px] text-right text-[12px] " + (up ? "text-up" : "text-down")}>{fmtPct(r.delta)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function IndexChart({ points, palette }: { points: { time: UTCTimestamp; value: number }[]; palette: Palette }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Area"> | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const c = createChart(el, chartOptions(palette, { grid: true, logScale: false, magnet: false }));
    const s = c.addSeries(AreaSeries, {
      lineColor: palette.accent,
      topColor: withAlpha(palette.accent, 0.30),
      bottomColor: withAlpha(palette.accent, 0.02),
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    chart.current = c;
    series.current = s;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
    };
  }, [palette]);

  useEffect(() => {
    if (!series.current) return;
    series.current.setData(points);
    chart.current?.timeScale().fitContent();
  }, [points]);

  return (
    <div className="relative h-[200px] w-full">
      <div ref={box} className="absolute inset-0" />
      {points.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-[12px] text-faint">
          Chưa đủ nến để dựng chỉ số thị trường.
        </div>
      )}
    </div>
  );
}

export default function Overview({
  entries, livePrices, liveState, health, palette, ingesting,
  onOpenSymbol, onRemove, onOpenSearch, onIngest, onToggleLive, liveEnabled,
}: {
  entries: WatchEntry[];
  livePrices: Record<string, number>;
  liveState: LiveState;
  health: Health | undefined;
  palette: Palette;
  ingesting: boolean;
  onOpenSymbol: (symbol: string, tf?: Timeframe) => void;
  onRemove: (symbol: string) => void;
  onOpenSearch: () => void;
  onIngest: () => void;
  onToggleLive: () => void;
  liveEnabled: boolean;
}) {
  const [tf, setTf] = useState<Timeframe>("1d");
  const [window, setWindow] = useState<number>(120);
  const [sortKey, setSortKey] = useState<SortKey>("volume");
  const [sortDesc, setSortDesc] = useState(true);
  const [filter, setFilter] = useState("");
  const [category, setCategory] = useState<Category>("all");
  const tableRef = useRef<HTMLDivElement>(null);

  const candleQueries = useQueries({
    queries: entries.map((e) => ({
      queryKey: ["ov-candles", e.symbol, tf, window, e.venue],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchCandles(e.symbol, tf, window, e.venue, signal),
      staleTime: 30_000,
    })),
  });
  const summaryQueries = useQueries({
    queries: entries.flatMap((e) =>
      TIMEFRAMES.map((t) => ({
        queryKey: ["ov-summary", e.symbol, t, window, e.venue],
        queryFn: ({ signal }: { signal: AbortSignal }) => fetchSummary(e.symbol, t, window, e.venue, signal),
        staleTime: 60_000,
        retry: false,
      })),
    ),
  });

  const candlesBy = useMemo(() => {
    const out: Record<string, Candle[]> = {};
    entries.forEach((e, i) => {
      const d = candleQueries[i]?.data;
      if (d) out[e.symbol] = d.candles;
    });
    return out;
  }, [entries, candleQueries]);

  const summaryBy = useMemo(() => {
    const out: Record<string, Partial<Record<Timeframe, Summary>>> = {};
    entries.forEach((e, i) => {
      const row: Partial<Record<Timeframe, Summary>> = {};
      TIMEFRAMES.forEach((t, j) => {
        const d = summaryQueries[i * TIMEFRAMES.length + j]?.data;
        if (d) row[t] = d;
      });
      out[e.symbol] = row;
    });
    return out;
  }, [entries, summaryQueries]);

  const stats = useMemo(() => entries.map((e) => {
    const cs = candlesBy[e.symbol] ?? [];
    const streamed = liveState === "on" ? livePrices[e.symbol] : undefined;
    const lastClosed = cs[cs.length - 1];
    const prevClosed = cs[cs.length - 2];
    const price = streamed ?? lastClosed?.close ?? e.last_close;
    const prev = prevClosed?.close ?? e.prev_close;
    const delta = price !== null && prev ? price / prev - 1 : e.delta;
    const volume = cs.reduce((a, c) => a + c.volume * c.close, 0);
    const high = cs.length ? Math.max(...cs.map((c) => c.high)) : null;
    const low = cs.length ? Math.min(...cs.map((c) => c.low)) : null;
    const sum = summaryBy[e.symbol]?.[tf];
    const spark = streamed !== undefined && cs.length ? [...cs.map((c) => c.close), streamed] : cs.map((c) => c.close);
    return { e, price, delta, streamed, volume, high, low, sum, spark };
  }), [entries, candlesBy, summaryBy, livePrices, liveState, tf]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let list = stats;
    if (q) list = list.filter((s) => s.e.symbol.toLowerCase().includes(q) || (s.e.label ?? "").toLowerCase().includes(q));
    if (category !== "all") {
      list = list.filter((s) => {
        const d = s.delta ?? 0;
        if (category === "up") return d > 0.000001;
        if (category === "down") return d < -0.000001;
        return Math.abs(d) <= 0.000001;
      });
    }
    const dir = sortDesc ? -1 : 1;
    const val = (s: (typeof stats)[number]): number | string => {
      switch (sortKey) {
        case "symbol": return s.e.symbol;
        case "price": return s.price ?? -Infinity;
        case "delta": return s.delta ?? -Infinity;
        case "sharpe": return s.sum?.sharpe ?? -Infinity;
        default: return s.volume;
      }
    };
    return [...list].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (typeof av === "string" || typeof bv === "string") return String(av).localeCompare(String(bv)) * dir;
      return (av - bv) * dir;
    });
  }, [stats, filter, category, sortKey, sortDesc]);

  const breadth = useMemo(() => {
    let up = 0, down = 0, flat = 0, sum = 0, n = 0;
    for (const s of stats) {
      if (s.delta === null || s.delta === undefined) continue;
      n += 1; sum += s.delta;
      if (s.delta > 0.000001) up += 1;
      else if (s.delta < -0.000001) down += 1;
      else flat += 1;
    }
    return { up, down, flat, avg: n ? sum / n : null, n };
  }, [stats]);

  const byVolume = useMemo(() => [...stats].sort((a, b) => b.volume - a.volume), [stats]);
  const byDelta = useMemo(() => [...stats].sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0)), [stats]);
  const cardRows = (list: typeof stats) => list.slice(0, 3).map((s) => ({ symbol: s.e.symbol, price: s.price, delta: s.delta }));

  const indexPoints = useMemo(() => {
    const lists = entries.map((e) => candlesBy[e.symbol] ?? []).filter((l) => l.length > 1);
    const firstList = lists[0];
    if (!firstList) return [];
    const maps = lists.map((l) => new Map(l.map((c) => [c.ts, c.close])));
    const common = firstList.map((c) => c.ts).filter((ts) => maps.every((m) => m.has(ts)));
    const firstTs = common[0];
    if (common.length < 2 || firstTs === undefined) return [];
    const bases = maps.map((m) => m.get(firstTs) ?? 1);
    const step = TIMEFRAME_SECONDS[tf] ?? 3600;
    const pts = common.map((ts) => {
      const avg = maps.reduce((acc, m, i) => acc + ((m.get(ts) ?? bases[i] ?? 1) / (bases[i] ?? 1)) * 100, 0) / maps.length;
      return { time: (Date.parse(ts) / 1000) as UTCTimestamp, value: Number(avg.toFixed(3)) };
    });
    if (liveState === "on") {
      const liveVals = entries.map((e) => {
        const lp = livePrices[e.symbol];
        const first = candlesBy[e.symbol]?.[0];
        if (lp === undefined || !first || !first.close) return null;
        return (lp / first.close) * 100;
      }).filter((v): v is number => v !== null);
      const lastTs = common[common.length - 1];
      if (liveVals.length === maps.length && lastTs !== undefined) {
        const avg = liveVals.reduce((a, b) => a + b, 0) / liveVals.length;
        pts.push({ time: ((Date.parse(lastTs) / 1000) + step) as UTCTimestamp, value: Number(avg.toFixed(3)) });
      }
    }
    return pts;
  }, [entries, candlesBy, livePrices, liveState, tf]);

  const maxAbsReturn = useMemo(() => {
    let m = 0.0001;
    for (const e of entries) for (const t of TIMEFRAMES) {
      const r = summaryBy[e.symbol]?.[t]?.total_return;
      if (r !== undefined) m = Math.max(m, Math.abs(r));
    }
    return m;
  }, [entries, summaryBy]);

  const heatColor = (r: number | undefined) => {
    if (r === undefined) return { background: "transparent", color: palette.faint };
    const a = 0.12 + 0.55 * Math.min(1, Math.abs(r) / maxAbsReturn);
    return { background: withAlpha(r >= 0 ? palette.up : palette.down, a), color: palette.text };
  };

  const loading = entries.length > 0 && candleQueries.every((q) => q.isPending);

  const header = (key: SortKey, label: string, align: "left" | "right" = "right") => (
    <th className={"px-3 py-2 font-normal " + (align === "left" ? "text-left" : "text-right")}>
      <button
        type="button"
        onClick={() => {
          if (sortKey === key) setSortDesc((v) => !v);
          else { setSortKey(key); setSortDesc(true); }
        }}
        className={
          "inline-flex items-center gap-1 whitespace-nowrap text-[10px] uppercase tracking-wide hover:text-ink " +
          (sortKey === key ? "text-accent" : "text-faint")
        }
      >
        {label}
        <Icon
          name={sortKey === key ? "chevronDown" : "sort"}
          size={11}
          className={sortKey === key && !sortDesc ? "rotate-180" : ""}
        />
      </button>
    </th>
  );

  const scrollToTable = (key: SortKey, desc: boolean, cat: Category = "all") => {
    setSortKey(key); setSortDesc(desc); setCategory(cat);
    tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="ml-thin-scroll min-h-0 flex-1 overflow-y-auto bg-bg">
      {/* Thanh điều khiển thường trực */}
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-1.5 border-b border-line bg-panel px-3 py-2">
        <span className="flex items-center gap-1.5 pr-1 text-[13px] font-semibold">
          <Icon name="layers" size={15} className="text-accent" /> Tổng quan
        </span>
        {[...new Set(entries.map((e) => e.venue))].sort().map((v) => (
          <span key={v} className="rounded-card border border-line px-1.5 text-[10px] uppercase text-faint">
            {venueLabel(v)}
          </span>
        ))}

        <div className="flex items-center rounded-card border border-line" role="group" aria-label="Khung của cột thay đổi">
          {TIMEFRAMES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTf(t)}
              aria-pressed={t === tf}
              className={"h-6 px-2 text-[11px] " + (t === tf ? "bg-hover font-semibold text-accent" : "text-dim hover:text-ink")}
            >
              {t}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-1 text-[11px] text-dim">
          Cửa sổ
          <select
            value={window}
            onChange={(e) => setWindow(Number(e.target.value))}
            className="h-6 rounded-card border border-line bg-bg px-1 text-[11px] text-ink outline-none focus:border-accent"
            aria-label="Số nến cửa sổ"
          >
            {WINDOWS.map((w) => <option key={w} value={w}>{w} nến</option>)}
          </select>
        </label>

        <div className="flex min-w-[150px] flex-1 items-center gap-1.5 rounded-card border border-line bg-bg px-2">
          <Icon name="search" size={13} className="text-faint" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Tìm symbol…"
            aria-label="Tìm symbol trong tổng quan"
            className="h-6 w-full bg-transparent text-[12px] outline-none placeholder:text-faint"
          />
          {filter && <ToolButton icon="close" label="Bỏ lọc" onClick={() => setFilter("")} className="h-5 w-5" />}
        </div>

        <ToolButton
          icon="bolt"
          label={liveEnabled ? "Tắt luồng trực tiếp" : "Bật luồng trực tiếp"}
          active={liveEnabled && liveState === "on"}
          onClick={onToggleLive}
          className="h-6"
        >
          <span className="text-[11px]">{liveState === "on" ? "LIVE" : liveState === "connecting" ? "…" : "OFF"}</span>
        </ToolButton>
        <ToolButton icon="refresh" label="Nạp lại dữ liệu" onClick={onIngest} disabled={ingesting} className={"h-6 " + (ingesting ? "ml-pulse" : "")} />
        <ToolButton icon="plus" label="Thêm symbol" onClick={onOpenSearch} className="h-6" />
      </div>

      <div className="flex flex-col gap-3 p-3">
        {entries.length === 0 ? (
          <div className="rounded-card border border-line bg-panel">
            <Empty icon="star" title="Chưa có symbol nào trong danh sách" hint="Thêm symbol để dựng tổng quan thị trường; lịch sử nạp tự động từ nguồn dữ liệu." />
            <div className="flex justify-center pb-5">
              <button type="button" onClick={onOpenSearch} className="flex h-7 items-center gap-1.5 rounded-card bg-accent px-3 text-[12px] font-medium text-white hover:opacity-90">
                <Icon name="plus" size={14} /> Thêm symbol đầu tiên
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Hàng thẻ highlight kiểu markets overview */}
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <HighlightCard title="Hàng đầu" rows={cardRows(stats)} onMore={() => scrollToTable("symbol", false)} onOpen={(s) => onOpenSymbol(s, tf)} />
              <HighlightCard title="Top tăng giá" rows={cardRows(byDelta)} onMore={() => scrollToTable("delta", true, "up")} onOpen={(s) => onOpenSymbol(s, tf)} />
              <HighlightCard title="Top giảm giá" rows={cardRows([...byDelta].reverse())} onMore={() => scrollToTable("delta", false, "down")} onOpen={(s) => onOpenSymbol(s, tf)} />
              <HighlightCard title="Volume lớn nhất" rows={cardRows(byVolume)} onMore={() => scrollToTable("volume", true)} onOpen={(s) => onOpenSymbol(s, tf)} />
            </div>

            {/* Tab phân loại + độ rộng */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-0.5 rounded-card border border-line bg-panel px-0.5" role="group" aria-label="Phân loại theo chiều giá">
                {CATEGORIES.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setCategory(c.id)}
                    aria-pressed={category === c.id}
                    className={"h-6 rounded-card px-2 text-[11px] " + (category === c.id ? "bg-hover font-semibold text-accent" : "text-dim hover:text-ink")}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2 text-[11px] text-dim">
                <span className="text-up">{breadth.up} tăng</span>
                <span className="text-faint">{breadth.flat} đứng</span>
                <span className="text-down">{breadth.down} giảm</span>
                <span className="text-faint">·</span>
                <span>Δ TB <span className={(breadth.avg ?? 0) >= 0 ? "text-up" : "text-down"}>{fmtPct(breadth.avg)}</span></span>
              </div>
              <div className="ml-auto flex h-2 w-[140px] overflow-hidden rounded-pill bg-hover" role="img"
                aria-label={`Tăng ${breadth.up}, giảm ${breadth.down}, đứng ${breadth.flat}`}>
                {breadth.n > 0 && (
                  <>
                    <span style={{ width: `${(breadth.up / breadth.n) * 100}%`, background: palette.up }} />
                    <span style={{ width: `${(breadth.flat / breadth.n) * 100}%`, background: palette.faint }} />
                    <span style={{ width: `${(breadth.down / breadth.n) * 100}%`, background: palette.down }} />
                  </>
                )}
              </div>
            </div>

            {/* Bảng token chính */}
            <section ref={tableRef} className="scroll-mt-14 rounded-card border border-line bg-panel">
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
                <div>
                  <h2 className="text-[13px] font-semibold">Symbol trong danh sách theo dõi</h2>
                  <p className="text-[10px] text-faint">
                    Giá mới nhất, thay đổi theo khung {tf}, khối lượng cửa sổ {window} nến quy USD · bấm tiêu đề cột để sắp xếp
                  </p>
                </div>
                <span className="tnum text-[11px] text-dim">{shown.length}/{entries.length} symbol · kho {fmtCompact(health?.candles)} nến</span>
              </header>

              {loading ? (
                <div className="flex h-40 items-center justify-center text-[12px] text-faint ml-pulse">Đang tải bảng thị trường…</div>
              ) : shown.length === 0 ? (
                <Empty icon="search" title="Không khớp bộ lọc" hint="Đổi tab phân loại hoặc xoá từ khoá tìm." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-[12px]">
                    <thead>
                      <tr className="border-b border-line">
                        {header("symbol", "Tên", "left")}
                        {header("price", "Giá")}
                        <th className="px-3 py-2 text-right font-normal">
                          <span className="inline-flex items-center gap-1 whitespace-nowrap text-[10px] uppercase tracking-wide text-faint">
                            Thay đổi
                            <select
                              value={tf}
                              onChange={(e) => setTf(e.target.value as Timeframe)}
                              className="h-5 rounded-card border border-line bg-bg px-1 text-[10px] normal-case text-ink outline-none focus:border-accent"
                              aria-label="Khung của cột thay đổi"
                            >
                              {TIMEFRAMES.map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </span>
                        </th>
                        {header("volume", "KL cửa sổ (USD)")}
                        <th className="whitespace-nowrap px-3 py-2 text-center font-normal text-[10px] uppercase tracking-wide text-faint">Xu hướng</th>
                        {header("sharpe", "Sharpe")}
                        <th className="whitespace-nowrap px-2 py-2 text-right font-normal text-[10px] uppercase tracking-wide text-faint">Hành động</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((s) => {
                        const up = (s.delta ?? 0) >= 0;
                        const digits = autoDigits(s.price);
                        return (
                          <tr
                            key={s.e.symbol}
                            className="cursor-pointer border-b border-line last:border-b-0 hover:bg-hover/60"
                            onClick={() => onOpenSymbol(s.e.symbol, tf)}
                          >
                            <td className="px-3 py-2">
                              <span className="flex items-center gap-2">
                                <CoinBadge symbol={s.e.symbol} />
                                <span className="min-w-0">
                                  <span className="flex items-center gap-1.5 font-semibold">
                                    {s.e.symbol.split("/")[0]}
                                    {s.e.venue !== "binance" && (
                                      <span className="rounded-card border border-line px-1 text-[9px] font-normal text-faint">
                                        {venueLabel(s.e.venue)}
                                      </span>
                                    )}
                                    {s.streamed !== undefined && <span className="rounded-card bg-up/15 px-1 text-[9px] font-medium text-up">LIVE</span>}
                                  </span>
                                  <span className="block truncate text-[10px] text-faint">{s.e.label ?? s.e.symbol}</span>
                                </span>
                              </span>
                            </td>
                            <td className="px-3 py-2 text-right">
                              <PriceTick value={s.price} digits={digits} />
                              <span className="tnum block text-[10px] text-faint">{fmtPrice(s.price)}</span>
                            </td>
                            <td className={"tnum px-3 py-2 text-right font-medium " + (up ? "text-up" : "text-down")}>{fmtPct(s.delta)}</td>
                            <td className="tnum px-3 py-2 text-right text-dim">{fmtCompact(s.volume)}</td>
                            <td className="px-3 py-2">
                              <span className="flex justify-center"><SparkArea values={s.spark} up={up} palette={palette} /></span>
                            </td>
                            <td className="tnum px-3 py-2 text-right text-dim">{s.sum?.sharpe === undefined ? "—" : s.sum.sharpe.toFixed(2)}</td>
                            <td className="px-2 py-2">
                              <span className="flex justify-end gap-0.5">
                                <ToolButton icon="candles" label={`Mở chart ${s.e.symbol}`} onClick={() => onOpenSymbol(s.e.symbol, tf)} className="h-6 w-6" />
                                <ToolButton icon="trash" label={`Bỏ ${s.e.symbol}`} danger onClick={() => onRemove(s.e.symbol)} className="h-6 w-6" />
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Phân tích thêm: chỉ số equal-weight + heatmap */}
            <div className="grid gap-3 lg:grid-cols-[2fr_1fr]">
              <section className="rounded-card border border-line bg-panel">
                <header className="flex items-center justify-between border-b border-line px-3 py-2">
                  <div>
                    <h2 className="text-[12px] font-semibold">Chỉ số thị trường (equal-weight)</h2>
                    <p className="text-[10px] text-faint">Trung bình chuẩn hoá về 100 của {entries.length} symbol · khung {tf} · {indexPoints.length} nến chung · điểm cuối theo giá live</p>
                  </div>
                  <span className="tnum rounded-card bg-hover px-2 py-0.5 text-[12px] font-semibold text-accent">
                    {indexPoints[indexPoints.length - 1]?.value.toFixed(2) ?? "—"}
                  </span>
                </header>
                {loading ? (
                  <div className="flex h-[200px] items-center justify-center text-[12px] text-faint ml-pulse">Đang dựng chỉ số…</div>
                ) : (
                  <IndexChart points={indexPoints} palette={palette} />
                )}
              </section>

              <section className="rounded-card border border-line bg-panel">
                <header className="border-b border-line px-3 py-2">
                  <h2 className="text-[12px] font-semibold">Heatmap lợi nhuận theo khung</h2>
                  <p className="text-[10px] text-faint">Total return cửa sổ {window} nến · bấm ô để mở chart</p>
                </header>
                <div className="overflow-x-auto p-2">
                  <table className="w-full border-collapse text-[11px]">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wide text-faint">
                        <th className="px-2 py-1 text-left font-normal">Symbol</th>
                        {TIMEFRAMES.map((t) => <th key={t} className="px-2 py-1 text-right font-normal">{t}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {stats.map((s) => (
                        <tr key={s.e.symbol}>
                          <td className="px-2 py-1 font-medium">{s.e.symbol.split("/")[0]}</td>
                          {TIMEFRAMES.map((t) => {
                            const r = summaryBy[s.e.symbol]?.[t]?.total_return;
                            return (
                              <td key={t} className="px-1 py-0.5">
                                <button
                                  type="button"
                                  onClick={() => onOpenSymbol(s.e.symbol, t)}
                                  style={heatColor(r)}
                                  className="tnum w-full rounded-card px-1.5 py-1 text-right transition-transform hover:scale-[1.03]"
                                  title={`${s.e.symbol} ${t}: ${fmtPct(r)}`}
                                >
                                  {fmtPct(r, 1)}
                                </button>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>

            <p className="pb-2 text-[10px] leading-relaxed text-faint">
              Giá trực tiếp từ luồng backend (crypto nhịp ~2s, cổ phiếu Mỹ ~10s); cột thay đổi so nến đóng trước của khung đang chọn.
              Kho TimescaleDB chỉ chứa nến đã đóng nên Sharpe / heatmap tái lập được, không lẫn nến đang chạy.
              Chỉ số equal-weight chuẩn hoá mỗi symbol về 100 tại nến đầu cửa sổ rồi trung bình; điểm cuối nối thêm giá live.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
