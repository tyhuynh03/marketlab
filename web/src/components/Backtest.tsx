import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  createChart,
  createSeriesMarkers,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  LIMITS,
  TIMEFRAMES,
  fetchBacktest,
  fmtNum,
  fmtPct,
  fmtTime,
  venueLabel,
  type BacktestMetrics,
  type BacktestParams,
  type BacktestResponse,
  type BacktestStrategy,
  type Timeframe,
  type WatchEntry,
} from "../api";
import { chartOptions, type Palette } from "../theme";
import { CoinBadge, Empty, Icon, NumberField } from "./ui";

type Tone = "info" | "ok" | "error";
type Notify = (text: string, tone?: Tone) => void;

const STRATEGIES: { id: BacktestStrategy; label: string }[] = [
  { id: "sma_cross", label: "SMA fast cắt slow" },
  { id: "buy_hold", label: "Buy & Hold (benchmark)" },
];

const usd = (v: number): string =>
  `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyFmt = (v: number): string => v.toLocaleString("en-US", { maximumFractionDigits: 8 });
const signClass = (v: number): string => (v > 0 ? "text-up" : v < 0 ? "text-down" : "text-dim");
const secs = (ts: string): UTCTimestamp => (Date.parse(ts) / 1000) as UTCTimestamp;

const selectCls =
  "h-7 rounded-card border border-line bg-bg px-1.5 text-[12px] text-ink outline-none focus:border-accent";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-dim">
      <span className="shrink-0">{label}</span>
      {children}
    </label>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: number }) {
  return (
    <div className="rounded-card border border-line bg-panel px-3 py-2.5">
      <p className="truncate text-[10px] uppercase tracking-wide text-faint">{label}</p>
      <p className={"tnum mt-0.5 truncate text-[20px] font-semibold leading-tight " + (tone === undefined ? "" : signClass(tone))}>{value}</p>
      {sub && <p className="mt-0.5 truncate text-[11px] text-dim">{sub}</p>}
    </div>
  );
}

/* ---------- đường vốn chiến lược + benchmark, đoạn OOS đổi màu, marker khớp lệnh ---------- */
function EquityChart({ data, palette }: { data: BacktestResponse; palette: Palette }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const stratS = useRef<ISeriesApi<"Line"> | null>(null);
  const oosS = useRef<ISeriesApi<"Line"> | null>(null);
  const benchS = useRef<ISeriesApi<"Line"> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const c = createChart(el, chartOptions(palette, { grid: true, logScale: false, magnet: false }));
    const strat = c.addSeries(LineSeries, { color: palette.accent, lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    const oos = c.addSeries(LineSeries, { color: palette.warn, lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    const bench = c.addSeries(LineSeries, {
      color: palette.violet, lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: true,
    });
    chart.current = c; stratS.current = strat; oosS.current = oos; benchS.current = bench;
    markers.current = createSeriesMarkers(strat, [] as SeriesMarker<Time>[]);
    return () => {
      c.remove();
      chart.current = null; stratS.current = null; oosS.current = null; benchS.current = null; markers.current = null;
    };
  }, [palette]);

  useEffect(() => {
    const strat = stratS.current, oos = oosS.current, bench = benchS.current;
    if (!strat || !oos || !bench) return;
    const eq = data.equity;
    const nTrain = data.holdout.train_bars;
    strat.setData(eq.map((p) => ({ time: secs(p.ts), value: p.equity })));
    // đoạn out-of-sample: neo tại nến train cuối để nối liền mạch, tô màu warn
    oos.setData(eq.slice(Math.max(0, nTrain - 1)).map((p) => ({ time: secs(p.ts), value: p.equity })));
    bench.setData(data.benchmark.equity.map((p) => ({ time: secs(p.ts), value: p.equity })));

    const mk: SeriesMarker<Time>[] = data.fills.map((f) => ({
      time: secs(f.fill_ts),
      position: f.side === "buy" ? "belowBar" : "aboveBar",
      color: f.side === "buy" ? palette.up : palette.down,
      shape: f.side === "buy" ? "arrowUp" : "arrowDown",
      text: f.side === "buy" ? "M" : "B",
      size: 1,
    }));
    mk.push({
      time: secs(data.holdout.boundary_ts), position: "aboveBar", color: palette.warn,
      shape: "square", text: "OOS", size: 1,
    });
    mk.sort((a, b) => (a.time as number) - (b.time as number));
    markers.current?.setMarkers(mk);
    chart.current?.timeScale().fitContent();
  }, [data, palette]);

  return (
    <div className="relative h-[300px] w-full">
      <div ref={box} className="absolute inset-0" />
    </div>
  );
}

const METRIC_ROWS: { key: keyof BacktestMetrics; label: string; pct: boolean; tone: boolean }[] = [
  { key: "total_return", label: "Tổng lợi nhuận", pct: true, tone: true },
  { key: "annualized_return", label: "Lợi nhuận năm hoá", pct: true, tone: true },
  { key: "max_drawdown", label: "Sụt giảm tối đa", pct: true, tone: false },
  { key: "volatility", label: "Biến động năm hoá", pct: true, tone: false },
  { key: "sharpe", label: "Sharpe", pct: false, tone: true },
  { key: "sortino", label: "Sortino", pct: false, tone: true },
  { key: "calmar", label: "Calmar", pct: false, tone: true },
];

function MetricsTable({ data }: { data: BacktestResponse }) {
  const h = data.holdout;
  const cols: { m: BacktestMetrics; oos?: boolean }[] = [
    { m: data.metrics }, { m: data.benchmark.metrics },
    { m: h.in_sample.metrics }, { m: h.in_sample.benchmark_metrics },
    { m: h.out_of_sample.metrics, oos: true }, { m: h.out_of_sample.benchmark_metrics, oos: true },
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-line text-[10px] uppercase tracking-wide text-faint">
            <th className="px-2.5 py-1.5 text-left font-normal" rowSpan={2}>Chỉ số</th>
            <th className="px-2.5 py-1 text-center font-normal" colSpan={2}>Toàn bộ</th>
            <th className="px-2.5 py-1 text-center font-normal" colSpan={2}>In-sample</th>
            <th className="bg-hover/40 px-2.5 py-1 text-center font-normal text-warn" colSpan={2}>Out-of-sample</th>
          </tr>
          <tr className="border-b border-line text-[10px] uppercase tracking-wide text-faint">
            <th className="px-2.5 py-1 text-right font-normal">CL</th>
            <th className="px-2.5 py-1 text-right font-normal">B&H</th>
            <th className="px-2.5 py-1 text-right font-normal">CL</th>
            <th className="px-2.5 py-1 text-right font-normal">B&H</th>
            <th className="bg-hover/40 px-2.5 py-1 text-right font-normal">CL</th>
            <th className="bg-hover/40 px-2.5 py-1 text-right font-normal">B&H</th>
          </tr>
        </thead>
        <tbody>
          {METRIC_ROWS.map((r) => (
            <tr key={r.key} className="border-b border-line/60 last:border-b-0">
              <td className="px-2.5 py-1.5 text-left text-dim">{r.label}</td>
              {cols.map((c, i) => {
                const v = c.m[r.key];
                const txt = r.pct ? fmtPct(v) : fmtNum(v, 2);
                const cls = r.tone ? signClass(v) : "text-dim";
                return <td key={i} className={"tnum px-2.5 py-1.5 text-right " + cls + (c.oos ? " bg-hover/40" : "")}>{txt}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FillsTable({ data }: { data: BacktestResponse }) {
  const fills = data.fills;
  return (
    <div className="ml-thin-scroll max-h-[280px] overflow-y-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead className="sticky top-0 bg-panel">
          <tr className="border-b border-line text-[10px] uppercase tracking-wide text-faint">
            <th className="px-3 py-1.5 text-left font-normal">Tín hiệu</th>
            <th className="px-3 py-1.5 text-left font-normal">Khớp (open nến kế)</th>
            <th className="px-3 py-1.5 text-left font-normal">Chiều</th>
            <th className="px-3 py-1.5 text-right font-normal">Giá khớp</th>
            <th className="px-3 py-1.5 text-right font-normal">Khối lượng</th>
            <th className="px-3 py-1.5 text-right font-normal">Notional</th>
            <th className="px-3 py-1.5 text-right font-normal">Phí</th>
          </tr>
        </thead>
        <tbody className="tnum">
          {fills.map((f, i) => (
            <tr key={i} className="border-b border-line/60 last:border-b-0">
              <td className="px-3 py-1.5 text-dim">{fmtTime(f.signal_ts)}</td>
              <td className="px-3 py-1.5 text-dim">{fmtTime(f.fill_ts)}</td>
              <td className="px-3 py-1.5">
                <span className={"rounded-card px-1.5 py-0.5 text-[11px] font-medium " + (f.side === "buy" ? "bg-up/15 text-up" : "bg-down/15 text-down")}>
                  {f.side === "buy" ? "Mua" : "Bán"}
                </span>
              </td>
              <td className="px-3 py-1.5 text-right">{fmtNum(f.exec_price, 4)}</td>
              <td className="px-3 py-1.5 text-right">{qtyFmt(f.qty)}</td>
              <td className="px-3 py-1.5 text-right text-dim">{usd(f.notional)}</td>
              <td className="px-3 py-1.5 text-right text-dim">{usd(f.fee)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Backtest({ entries, palette, onToast, onLog }: {
  entries: WatchEntry[];
  palette: Palette;
  onToast: Notify;
  onLog: Notify;
}) {
  const [symbol, setSymbol] = useState("BTC/USDT");
  const [timeframe, setTimeframe] = useState<Timeframe>("1d");
  const [strategy, setStrategy] = useState<BacktestStrategy>("sma_cross");
  const [fast, setFast] = useState(10);
  const [slow, setSlow] = useState(30);
  const [oos, setOos] = useState(0.3);
  const [limit, setLimit] = useState(500);
  const [submitted, setSubmitted] = useState<BacktestParams | null>(null);

  useEffect(() => {
    const first = entries[0];
    if (first && !entries.some((e) => e.symbol === symbol)) setSymbol(first.symbol);
  }, [entries, symbol]);

  const venue = entries.find((e) => e.symbol === symbol)?.venue ?? "binance";
  const invalid = strategy === "sma_cross" && fast >= slow;

  const query = useQuery({
    queryKey: ["backtest", submitted],
    queryFn: ({ signal }) => fetchBacktest(submitted as BacktestParams, signal),
    enabled: submitted !== null,
    staleTime: 30_000,
    retry: 1,
  });
  const data = query.data;

  const run = () => {
    if (invalid) {
      onToast("SMA cần fast < slow.", "error");
      return;
    }
    const params: BacktestParams = { symbol, timeframe, limit, venue, strategy, fast, slow, oos };
    setSubmitted(params);
    onLog(`Backtest ${symbol} ${timeframe} · ${strategy === "sma_cross" ? `SMA(${fast},${slow})` : "buy_hold"} · OOS ${Math.round(oos * 100)}%`);
  };

  const legend = useMemo(() => [
    { color: palette.accent, label: "Chiến lược (in-sample)" },
    { color: palette.warn, label: "Chiến lược (out-of-sample)" },
    { color: palette.violet, label: "Buy & Hold", dashed: true },
  ], [palette]);

  return (
    <div className="ml-thin-scroll min-h-0 flex-1 overflow-y-auto bg-bg">
      {/* Thanh tham số thường trực */}
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-panel px-3 py-2">
        <span className="flex items-center gap-1.5 pr-1 text-[13px] font-semibold">
          <Icon name="fx" size={15} className="text-accent" /> Backtest
        </span>

        <Field label="Symbol">
          <select className={selectCls} value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {entries.map((e) => <option key={e.symbol} value={e.symbol}>{e.symbol}</option>)}
          </select>
        </Field>

        <div className="flex items-center rounded-card border border-line" role="group" aria-label="Khung thời gian">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf} type="button" onClick={() => setTimeframe(tf)} aria-pressed={tf === timeframe}
              className={"h-7 px-2 text-[12px] transition-colors " + (tf === timeframe ? "bg-hover font-semibold text-accent" : "text-dim hover:bg-hover hover:text-ink")}
            >{tf}</button>
          ))}
        </div>

        <Field label="Chiến lược">
          <select className={selectCls} value={strategy} onChange={(e) => setStrategy(e.target.value as BacktestStrategy)}>
            {STRATEGIES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </Field>

        {strategy === "sma_cross" && (
          <>
            <NumberField label="Fast" value={fast} min={2} max={200} onChange={setFast} />
            <NumberField label="Slow" value={slow} min={3} max={400} onChange={setSlow} />
          </>
        )}

        <NumberField label="OOS" value={oos} min={0.05} max={0.9} step={0.05} onChange={setOos} />

        <Field label="Số nến">
          <select className={selectCls} value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {LIMITS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </Field>

        <div className="ml-auto flex items-center gap-2">
          {invalid && <span className="text-[11px] text-down">fast phải &lt; slow</span>}
          <button
            type="button" onClick={run} disabled={invalid || query.isFetching}
            className="flex h-7 items-center gap-1.5 rounded-card bg-accent px-2.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            <Icon name="refresh" size={14} className={query.isFetching ? "ml-pulse" : ""} />
            {query.isFetching ? "Đang chạy…" : "Chạy backtest"}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 p-3">
        {!submitted ? (
          <div className="rounded-card border border-line bg-panel">
            <Empty
              icon="fx"
              title="Chọn tham số rồi chạy backtest"
              hint="Engine thuần khớp tại open nến kế tiếp, phí 0.1% + trượt 0.05% mỗi chiều — đúng sổ paper. Báo cáo luôn kèm cửa sổ out-of-sample độc lập để chống overfit."
            />
          </div>
        ) : query.isPending ? (
          <div className="ml-pulse flex h-48 items-center justify-center rounded-card border border-line bg-panel text-[12px] text-faint">
            Đang chạy backtest trên nến đã đóng…
          </div>
        ) : query.isError || !data ? (
          <div className="rounded-card border border-line bg-panel">
            <Empty icon="alert" title="Không chạy được backtest" hint={(query.error as Error | null)?.message ?? "Kiểm tra backend rồi thử lại."} />
            <div className="flex justify-center pb-5">
              <button type="button" onClick={run} className="flex h-7 items-center gap-1.5 rounded-card bg-accent px-3 text-[12px] font-medium text-white hover:opacity-90">
                <Icon name="refresh" size={14} /> Thử lại
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Ghi chú phương pháp */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-line bg-panel px-3 py-2 text-[11px] text-dim">
              <span className="flex items-center gap-1.5 font-medium text-ink"><CoinBadge symbol={data.symbol} />{data.symbol}</span>
              <span className="rounded-card border border-line px-1.5 uppercase text-faint">{venueLabel(data.venue)}</span>
              <span>{data.timeframe} · {data.observations} nến đã đóng</span>
              <span>Vốn khởi tạo {usd(data.initial_capital)}</span>
              <span className="text-warn">
                OOS {Math.round(data.holdout.oos_fraction * 100)}%: {data.holdout.train_bars} nến train / {data.holdout.test_bars} nến test · ranh giới {fmtTime(data.holdout.boundary_ts)}
              </span>
            </div>

            {/* KPI so sánh */}
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <Kpi label="Chiến lược · toàn bộ" value={fmtPct(data.metrics.total_return)} tone={data.metrics.total_return}
                sub={`Sharpe ${fmtNum(data.metrics.sharpe, 2)} · maxDD ${fmtPct(data.metrics.max_drawdown)}`} />
              <Kpi label="Buy & Hold · toàn bộ" value={fmtPct(data.benchmark.metrics.total_return)} tone={data.benchmark.metrics.total_return}
                sub={`Sharpe ${fmtNum(data.benchmark.metrics.sharpe, 2)} · benchmark cùng luật`} />
              <Kpi label="Chiến lược · OOS" value={fmtPct(data.holdout.out_of_sample.metrics.total_return)} tone={data.holdout.out_of_sample.metrics.total_return}
                sub={`${data.holdout.out_of_sample.n_fills} lệnh khớp · ${data.holdout.test_bars} nến kiểm định`} />
              <Kpi label="Buy & Hold · OOS" value={fmtPct(data.holdout.out_of_sample.benchmark_metrics.total_return)} tone={data.holdout.out_of_sample.benchmark_metrics.total_return}
                sub={`maxDD ${fmtPct(data.holdout.out_of_sample.benchmark_metrics.max_drawdown)}`} />
            </div>

            {/* Đường vốn */}
            <section className="rounded-card border border-line bg-panel">
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
                <h3 className="text-[12px] font-semibold">Đường vốn · chiến lược vs Buy & Hold</h3>
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-dim">
                  {legend.map((l) => (
                    <span key={l.label} className="flex items-center gap-1.5">
                      <span className="inline-block h-0.5 w-4 rounded-pill" style={{ background: l.dashed ? "none" : l.color, borderTop: l.dashed ? `2px dashed ${l.color}` : undefined }} />
                      {l.label}
                    </span>
                  ))}
                  <span className="flex items-center gap-1.5"><Icon name="info" size={12} className="text-warn" /> M/B = mua/bán</span>
                </div>
              </header>
              <EquityChart data={data} palette={palette} />
            </section>

            {/* Bảng chỉ số */}
            <section className="rounded-card border border-line bg-panel">
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
                <h3 className="text-[12px] font-semibold">Chỉ số · toàn bộ / in-sample / out-of-sample</h3>
                <span className="text-[11px] text-faint">Cột OOS mới là thước đo trung thực — tham số cố định từ train, đo trên dữ liệu chưa từng tune.</span>
              </header>
              <MetricsTable data={data} />
            </section>

            {/* Nhật ký khớp + minh bạch hợp đồng */}
            <section className="rounded-card border border-line bg-panel">
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
                <h3 className="text-[12px] font-semibold">Nhật ký khớp lệnh <span className="tnum text-faint">({data.fills.length})</span></h3>
                <span className="text-[11px] text-faint">
                  Cuối kỳ: tiền mặt {usd(data.final.cash)} · nắm giữ {qtyFmt(data.final.qty)} · equity {usd(data.final.equity)} · tỷ trọng {fmtPct(data.final.position_weight, 1)}
                  {data.dropped_signals.length > 0 && ` · ${data.dropped_signals.length} tín hiệu cuối kho bị bỏ`}
                  {data.clamped_weights.length > 0 && ` · ${data.clamped_weights.length} trọng số bị kẹp`}
                </span>
              </header>
              {data.fills.length === 0 ? (
                <Empty icon="info" title="Không có lệnh khớp" hint="Chiến lược giữ nguyên vị thế suốt cửa sổ (ví dụ SMA chưa warmup hoặc không cắt)." />
              ) : (
                <FillsTable data={data} />
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}