import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createChart,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  PAPER_CAPITAL,
  PAPER_FEE_RATE,
  PAPER_SLIPPAGE,
  autoDigits,
  executeRebalance,
  fetchCashLedger,
  fetchEquity,
  fetchFills,
  fetchPortfolio,
  fetchRebalancePlan,
  fmtNum,
  fmtPct,
  fmtTime,
  placeOrder,
  resetPortfolio,
  seedPortfolio,
  setTargets,
  type Benchmark,
  type EquityMetrics,
  type EquityPoint,
  type PortfolioSnapshot,
  type Position,
  type WatchEntry,
} from "../api";
import type { LiveState } from "../live";
import { chartOptions, withAlpha, type Palette } from "../theme";
import { CoinBadge, coinColor, Divider, Empty, Icon, Modal, ToolButton } from "./ui";

type Tone = "info" | "ok" | "error";
type Notify = (text: string, tone?: Tone) => void;
type OrderRequest = { symbol: string; side: "buy" | "sell"; qty?: number };
type LivePosition = Position & { cost: number };
type LiveView = Omit<PortfolioSnapshot, "positions"> & { positions: LivePosition[] };
type LedgerTab = "positions" | "fills" | "cash";

const BENCHMARKS: { id: Benchmark; label: string }[] = [
  { id: "btc", label: "100% BTC" },
  { id: "8020", label: "80/20 BTC·ETH" },
];

const usd = (v: number): string =>
  `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedUsd = (v: number): string =>
  `${v >= 0 ? "+" : "-"}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyFmt = (v: number): string => v.toLocaleString("en-US", { maximumFractionDigits: 8 });
const priceFmt = (v: number): string =>
  v.toLocaleString("en-US", { minimumFractionDigits: autoDigits(v), maximumFractionDigits: autoDigits(v) });
const toneClass = (tone?: "up" | "down"): string => (tone === "up" ? "text-up" : tone === "down" ? "text-down" : "");
const SOURCE_LABEL: Record<string, string> = { seed: "Seed", ui: "Thủ công", rebalance: "Rebalance", reset: "Reset" };
const KIND_LABEL: Record<string, string> = { deposit: "Nạp vốn", buy: "Mua", sell: "Bán" };
const sourceLabel = (s: string): string => SOURCE_LABEL[s] ?? s;
const kindLabel = (k: string): string => KIND_LABEL[k] ?? k;

/* ---------- ô số nhảy theo giá live ---------- */
function Tick({ value, digits, className = "" }: { value: number; digits: number; className?: string }) {
  const prev = useRef(value);
  const [flash, setFlash] = useState<{ tone: "up" | "down"; key: number } | null>(null);
  useEffect(() => {
    if (value === prev.current) return;
    const tone = value > prev.current ? "up" : "down";
    prev.current = value;
    setFlash((f) => ({ tone, key: (f?.key ?? 0) + 1 }));
  }, [value]);
  return (
    <span
      key={flash?.key ?? 0}
      className={"tnum inline-block rounded-card px-0.5 " + (flash ? `flash-${flash.tone} ` : "") + className}
    >
      {value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}
    </span>
  );
}

function Kpi({ label, value, sub, tone, live, icon }: {
  label: string; value: string; sub?: ReactNode; tone?: "up" | "down"; live?: boolean; icon?: string;
}) {
  return (
    <div className="rounded-card border border-line bg-panel px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-faint">
        {icon && <Icon name={icon} size={12} />}
        <span className="truncate">{label}</span>
        {live && <span className="rounded-card bg-up/15 px-1 text-[9px] font-medium normal-case text-up">LIVE</span>}
      </p>
      <p className={"tnum mt-0.5 truncate text-[20px] font-semibold leading-tight " + toneClass(tone)}>{value}</p>
      {sub && <p className="mt-0.5 truncate text-[11px] text-dim">{sub}</p>}
    </div>
  );
}

function Stat({ label, value, tone, title }: { label: string; value: string; tone?: "up" | "down"; title?: string }) {
  return (
    <div className="rounded-card border border-line bg-bg px-2 py-1.5" title={title}>
      <p className="truncate text-[9px] uppercase tracking-wide text-faint">{label}</p>
      <p className={"tnum truncate text-[13px] font-semibold " + toneClass(tone)}>{value}</p>
    </div>
  );
}

/* ---------- đường vốn + benchmark ---------- */
function EquityChart({ points, palette }: { points: EquityPoint[]; palette: Palette }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const navS = useRef<ISeriesApi<"Line"> | null>(null);
  const benchS = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const c = createChart(el, chartOptions(palette, { grid: true, logScale: false, magnet: false }));
    const nav = c.addSeries(LineSeries, { color: palette.accent, lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    const bench = c.addSeries(LineSeries, {
      color: palette.violet, lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: true,
    });
    chart.current = c; navS.current = nav; benchS.current = bench;
    return () => { c.remove(); chart.current = null; navS.current = null; benchS.current = null; };
  }, [palette]);

  useEffect(() => {
    if (!navS.current || !benchS.current) return;
    navS.current.setData(points.map((p) => ({ time: (Date.parse(p.ts) / 1000) as UTCTimestamp, value: p.nav })));
    benchS.current.setData(points.map((p) => ({ time: (Date.parse(p.ts) / 1000) as UTCTimestamp, value: p.bench })));
    chart.current?.timeScale().fitContent();
  }, [points]);

  return (
    <div className="relative h-[250px] w-full">
      <div ref={box} className="absolute inset-0" />
      {points.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-[12px] text-faint">
          Chưa có lịch sử vốn — đặt lệnh hoặc seed để dựng đường NAV.
        </div>
      )}
    </div>
  );
}

function DrawdownChart({ points, palette }: { points: EquityPoint[]; palette: Palette }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const ddS = useRef<ISeriesApi<"Histogram"> | null>(null);
  const ddbS = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const c = createChart(el, chartOptions(palette, { grid: true, logScale: false, magnet: false }));
    const dd = c.addSeries(HistogramSeries, {
      base: 0, color: withAlpha(palette.down, 0.55), priceLineVisible: false, lastValueVisible: false,
    });
    const ddb = c.addSeries(LineSeries, {
      color: palette.dim, lineWidth: 1, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false,
    });
    chart.current = c; ddS.current = dd; ddbS.current = ddb;
    return () => { c.remove(); chart.current = null; ddS.current = null; ddbS.current = null; };
  }, [palette]);

  useEffect(() => {
    if (!ddS.current || !ddbS.current) return;
    ddS.current.setData(points.map((p) => ({ time: (Date.parse(p.ts) / 1000) as UTCTimestamp, value: p.dd })));
    ddbS.current.setData(points.map((p) => ({ time: (Date.parse(p.ts) / 1000) as UTCTimestamp, value: p.dd_bench })));
    chart.current?.timeScale().fitContent();
  }, [points]);

  return (
    <div className="relative h-[110px] w-full">
      <div ref={box} className="absolute inset-0" />
      <span className="pointer-events-none absolute left-2 top-1 text-[9px] uppercase tracking-wide text-faint">
        Underwater (drawdown)
      </span>
    </div>
  );
}

/* ---------- hộp thoại đặt lệnh ---------- */
function OrderModal({ request, onClose, entries, positions, cash, livePrices, liveState, onToast, onLog, onChanged }: {
  request: OrderRequest | null;
  onClose: () => void;
  entries: WatchEntry[];
  positions: LivePosition[];
  cash: number;
  livePrices: Record<string, number>;
  liveState: LiveState;
  onToast: Notify;
  onLog: Notify;
  onChanged: () => void;
}) {
  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [qtyStr, setQtyStr] = useState("");
  const [idem, setIdem] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!request) return;
    setSymbol(request.symbol);
    setSide(request.side);
    setQtyStr(request.qty !== undefined ? String(Number(request.qty.toFixed(8))) : "");
    setIdem(`ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    setErr(null);
  }, [request]);

  const symbols = useMemo(
    () => Array.from(new Set([...entries.map((e) => e.symbol), ...positions.map((p) => p.symbol)])),
    [entries, positions],
  );
  const pos = positions.find((p) => p.symbol === symbol);
  const entry = entries.find((e) => e.symbol === symbol);
  const mark = liveState === "on" && livePrices[symbol] !== undefined
    ? livePrices[symbol]
    : entry?.last_close ?? pos?.mark ?? 0;
  const isLive = liveState === "on" && livePrices[symbol] !== undefined;

  const qty = Number(qtyStr);
  const validQty = Number.isFinite(qty) && qty > 0;
  const exec = mark * (1 + (side === "buy" ? PAPER_SLIPPAGE : -PAPER_SLIPPAGE));
  const notional = validQty ? qty * exec : 0;
  const fee = notional * PAPER_FEE_RATE;
  const buyTotal = notional + fee;
  const sellNet = notional - fee;
  const maxBuyQty = exec > 0 ? cash / (exec * (1 + PAPER_FEE_RATE)) : 0;
  const maxSellQty = pos?.qty ?? 0;
  const estRealized = validQty && pos ? qty * (exec - pos.avg) - fee : 0;
  const affordable = side === "buy" ? buyTotal <= cash + 1e-9 : qty <= maxSellQty + 1e-9;
  const valid = validQty && mark > 0 && symbol !== "" && affordable;

  const setPct = (pct: number) => {
    const max = side === "buy" ? maxBuyQty : maxSellQty;
    setQtyStr(String(Number((pct * max).toFixed(8))));
  };

  const order = useMutation({
    mutationFn: () => placeOrder({ symbol, side, qty, idem_key: idem }),
    onSuccess: (res) => {
      onChanged();
      if (res.duplicate) onToast("Lệnh trùng khoá idempotent — đã khớp trước đó, không ghi trùng.", "info");
      else {
        onToast(`${side === "buy" ? "Mua" : "Bán"} ${qtyFmt(qty)} ${symbol} @ ${priceFmt(res.price ?? exec)} · phí ${usd(res.fee ?? fee)}`, "ok");
        onLog(`Khớp lệnh paper ${side} ${qtyFmt(qty)} ${symbol} @ ${priceFmt(res.price ?? exec)} (nguồn ${res.mark_source ?? "?"})`, "ok");
      }
      onClose();
    },
    onError: (e: Error) => { setErr(e.message); onToast(`Không khớp được lệnh: ${e.message}`, "error"); },
  });

  return (
    <Modal
      open={request !== null}
      onClose={onClose}
      title="Đặt lệnh paper"
      subtitle="Khớp theo giá mark, phí taker 0.1% + trượt giá 0.05% chiều bất lợi. Ghi sổ kép, không dùng tiền thật."
      width={480}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-faint">Khoá idempotent chống ghi trùng khi bấm nhiều lần.</span>
          <button
            type="button"
            disabled={!valid || order.isPending}
            onClick={() => order.mutate()}
            className={
              "flex h-8 items-center gap-1.5 rounded-card px-3 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40 " +
              (side === "buy" ? "bg-up" : "bg-down")
            }
          >
            <Icon name={order.isPending ? "refresh" : side === "buy" ? "plus" : "minus"} size={14} className={order.isPending ? "ml-pulse" : ""} />
            {order.isPending ? "Đang khớp…" : side === "buy" ? `Mua ${symbol.split("/")[0] ?? ""}` : `Bán ${symbol.split("/")[0] ?? ""}`}
          </button>
        </div>
      }
    >
      <div className="space-y-3 px-4 py-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-[11px] text-dim">
            Symbol
            <select
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              className="mt-1 h-8 w-full rounded-card border border-line bg-bg px-2 text-[12px] text-ink outline-none focus:border-accent"
            >
              {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <div className="block text-[11px] text-dim">
            Chiều lệnh
            <div className="mt-1 flex h-8 items-center rounded-card border border-line" role="group">
              {(["buy", "sell"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSide(s)}
                  aria-pressed={side === s}
                  className={
                    "h-full flex-1 rounded-card text-[12px] font-medium transition-colors " +
                    (side === s ? (s === "buy" ? "bg-up/15 text-up" : "bg-down/15 text-down") : "text-dim hover:text-ink")
                  }
                >
                  {s === "buy" ? "Mua" : "Bán"}
                </button>
              ))}
            </div>
          </div>
        </div>

        <label className="block text-[11px] text-dim">
          Khối lượng ({symbol.split("/")[0] ?? "coin"})
          <input
            type="text"
            inputMode="decimal"
            value={qtyStr}
            onChange={(e) => setQtyStr(e.target.value)}
            placeholder="0.00"
            className="tnum mt-1 h-9 w-full rounded-card border border-line bg-bg px-2 text-[14px] text-ink outline-none focus:border-accent"
          />
        </label>
        <div className="flex items-center gap-1">
          {[0.25, 0.5, 0.75, 1].map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPct(p)}
              className="h-6 flex-1 rounded-card border border-line text-[11px] text-dim hover:bg-hover hover:text-ink"
            >
              {p * 100}%
            </button>
          ))}
        </div>
        <p className="text-[11px] text-faint">
          {side === "buy"
            ? <>Tiền mặt khả dụng <span className="tnum text-dim">{usd(cash)}</span> · mua tối đa <span className="tnum text-dim">{qtyFmt(maxBuyQty)}</span></>
            : <>Đang giữ <span className="tnum text-dim">{qtyFmt(maxSellQty)}</span> {symbol.split("/")[0] ?? ""}{maxSellQty === 0 && " · chưa có vị thế để bán"}</>}
        </p>

        <div className="tnum space-y-1 rounded-card border border-line bg-bg px-3 py-2 text-[12px]">
          <div className="flex justify-between"><span className="text-dim">Giá mark {isLive && <span className="text-up">(live)</span>}</span><span>{mark > 0 ? priceFmt(mark) : "—"}</span></div>
          <div className="flex justify-between"><span className="text-dim">Giá khớp ước tính (trượt 0.05%)</span><span>{exec > 0 ? priceFmt(exec) : "—"}</span></div>
          <div className="flex justify-between"><span className="text-dim">Giá trị lệnh</span><span>{usd(notional)}</span></div>
          <div className="flex justify-between"><span className="text-dim">Phí (0.1%)</span><span>{usd(fee)}</span></div>
          <div className="flex justify-between border-t border-line pt-1 font-semibold">
            <span className="text-dim">{side === "buy" ? "Tổng trừ tiền mặt" : "Tiền nhận về"}</span>
            <span>{usd(side === "buy" ? buyTotal : sellNet)}</span>
          </div>
          {side === "sell" && pos && (
            <div className="flex justify-between"><span className="text-dim">Realized ước tính</span><span className={estRealized >= 0 ? "text-up" : "text-down"}>{signedUsd(estRealized)}</span></div>
          )}
        </div>

        {validQty && !affordable && (
          <p className="flex items-center gap-1.5 text-[11px] text-down">
            <Icon name="alert" size={13} />
            {side === "buy" ? "Vượt quá tiền mặt khả dụng." : "Vượt quá khối lượng đang giữ."}
          </p>
        )}
        {err && <p className="flex items-center gap-1.5 text-[11px] text-down"><Icon name="alert" size={13} />{err}</p>}
      </div>
    </Modal>
  );
}

/* ---------- hộp thoại rebalance ---------- */
function RebalanceModal({ open, onClose, onToast, onLog, onChanged }: {
  open: boolean; onClose: () => void; onToast: Notify; onLog: Notify; onChanged: () => void;
}) {
  const [idem, setIdem] = useState("");
  useEffect(() => { if (open) setIdem(`rb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`); }, [open]);
  const plan = useQuery({
    queryKey: ["portfolio", "rebalance-plan"],
    queryFn: fetchRebalancePlan,
    enabled: open,
    staleTime: 0,
  });
  const items = plan.data?.plan ?? [];
  const totalFee = items.reduce((a, p) => a + p.est_fee, 0);

  const exec = useMutation({
    mutationFn: () => executeRebalance(idem),
    onSuccess: (res) => {
      onChanged();
      onToast(`Đã rebalance — khớp ${res.executed.length} lệnh về đúng mục tiêu.`, "ok");
      onLog(`Rebalance danh mục: ${res.executed.length} lệnh`, "ok");
      onClose();
    },
    onError: (e: Error) => onToast(`Không rebalance được: ${e.message}`, "error"),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Rebalance về mục tiêu"
      subtitle="Tính khối lượng mua/bán chính xác để kéo tỷ trọng hiện tại về weight mục tiêu, theo giá live."
      width={620}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="tnum text-[11px] text-faint">Phí ước tính {usd(totalFee)} · bán trước, mua sau, một transaction.</span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="h-8 rounded-card border border-line px-3 text-[12px] hover:bg-hover">Huỷ</button>
            <button
              type="button"
              disabled={items.length === 0 || exec.isPending || plan.isPending}
              onClick={() => exec.mutate()}
              className="flex h-8 items-center gap-1.5 rounded-card bg-accent px-3 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-40"
            >
              <Icon name={exec.isPending ? "refresh" : "swap"} size={14} className={exec.isPending ? "ml-pulse" : ""} />
              {exec.isPending ? "Đang khớp…" : `Khớp ${items.length} lệnh`}
            </button>
          </div>
        </div>
      }
    >
      {plan.isPending ? (
        <div className="flex h-32 items-center justify-center text-[12px] text-faint ml-pulse">Đang tính khối lượng rebalance…</div>
      ) : items.length === 0 ? (
        <Empty icon="check" title="Danh mục đã cân đối" hint="Mọi tỷ trọng lệch dưới 0.5% so với mục tiêu — không cần mua bán thêm." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-line text-[10px] uppercase tracking-wide text-faint">
                <th className="px-3 py-2 text-left font-normal">Symbol</th>
                <th className="px-3 py-2 text-left font-normal">Lệnh</th>
                <th className="px-3 py-2 text-right font-normal">Khối lượng</th>
                <th className="px-3 py-2 text-right font-normal">Giá ước tính</th>
                <th className="px-3 py-2 text-right font-normal">Phí</th>
                <th className="px-3 py-2 text-right font-normal">Hiện tại → Mục tiêu</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {items.map((p) => (
                <tr key={p.symbol} className="border-b border-line/60 last:border-b-0">
                  <td className="px-3 py-2"><span className="flex items-center gap-2 font-medium"><CoinBadge symbol={p.symbol} />{p.symbol.split("/")[0]}</span></td>
                  <td className="px-3 py-2"><span className={"rounded-card px-1.5 py-0.5 text-[11px] font-medium " + (p.side === "buy" ? "bg-up/15 text-up" : "bg-down/15 text-down")}>{p.side === "buy" ? "Mua" : "Bán"}</span></td>
                  <td className="px-3 py-2 text-right">{qtyFmt(p.qty)}</td>
                  <td className="px-3 py-2 text-right text-dim">{priceFmt(p.est_price)}</td>
                  <td className="px-3 py-2 text-right text-dim">{usd(p.est_fee)}</td>
                  <td className="px-3 py-2 text-right text-dim">{fmtPct(p.current, 1)} → {fmtPct(p.target, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

/* ---------- hộp thoại sửa mục tiêu ---------- */
function TargetsModal({ open, onClose, targets, entries, onToast, onLog, onChanged }: {
  open: boolean; onClose: () => void; targets: { symbol: string; target: number }[];
  entries: WatchEntry[]; onToast: Notify; onLog: Notify; onChanged: () => void;
}) {
  const [rows, setRows] = useState<{ symbol: string; pct: number }[]>([]);
  const [addSym, setAddSym] = useState("");
  useEffect(() => {
    if (open) {
      setRows(targets.map((t) => ({ symbol: t.symbol, pct: Number((t.target * 100).toFixed(2)) })));
      setAddSym("");
    }
  }, [open, targets]);

  const sum = rows.reduce((a, r) => a + r.pct, 0);
  const ok = Math.abs(sum - 100) < 0.01 && rows.length > 0;
  const available = entries.map((e) => e.symbol).filter((s) => !rows.some((r) => r.symbol === s));

  const save = useMutation({
    mutationFn: () => setTargets(Object.fromEntries(rows.map((r) => [r.symbol, r.pct / 100] as [string, number]))),
    onSuccess: () => {
      onChanged();
      onToast("Đã lưu tỷ trọng mục tiêu mới.", "ok");
      onLog(`Cập nhật mục tiêu phân bổ: ${rows.map((r) => `${r.symbol} ${r.pct}%`).join(", ")}`);
      onClose();
    },
    onError: (e: Error) => onToast(`Không lưu được mục tiêu: ${e.message}`, "error"),
  });

  const normalize = () => {
    if (sum <= 0) return;
    setRows((rs) => rs.map((r) => ({ ...r, pct: Number(((r.pct / sum) * 100).toFixed(2)) })));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Tỷ trọng mục tiêu"
      subtitle="Tổng phải bằng 100%. CASH là phần tiền mặt mục tiêu. Dùng để tính độ lệch và rebalance."
      width={460}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className={"tnum text-[12px] font-medium " + (ok ? "text-up" : "text-down")}>Tổng {sum.toFixed(2)}% {ok ? "· hợp lệ" : "· phải = 100%"}</span>
          <div className="flex gap-2">
            <button type="button" onClick={normalize} disabled={sum <= 0} className="h-8 rounded-card border border-line px-3 text-[12px] hover:bg-hover disabled:opacity-40">Chuẩn hoá</button>
            <button
              type="button"
              disabled={!ok || save.isPending}
              onClick={() => save.mutate()}
              className="flex h-8 items-center gap-1.5 rounded-card bg-accent px-3 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-40"
            >
              <Icon name={save.isPending ? "refresh" : "check"} size={14} className={save.isPending ? "ml-pulse" : ""} />
              {save.isPending ? "Đang lưu…" : "Lưu mục tiêu"}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-2 px-4 py-3">
        {rows.map((r, i) => (
          <div key={r.symbol} className="flex items-center gap-2">
            <span className="flex min-w-0 flex-1 items-center gap-2 text-[12px] font-medium">
              {r.symbol === "CASH" ? <span className="flex h-6 w-6 items-center justify-center rounded-pill bg-hover text-[10px] text-dim">$</span> : <CoinBadge symbol={r.symbol} />}
              <span className="truncate">{r.symbol === "CASH" ? "Tiền mặt (CASH)" : r.symbol}</span>
            </span>
            <span className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={r.pct}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setRows((rs) => rs.map((x, j) => (j === i ? { ...x, pct: Number.isFinite(v) ? v : 0 } : x)));
                }}
                className="tnum h-7 w-20 rounded-card border border-line bg-bg px-2 text-right text-[12px] outline-none focus:border-accent"
              />
              <span className="text-[11px] text-faint">%</span>
            </span>
            <ToolButton icon="trash" label={`Bỏ ${r.symbol}`} danger onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className="h-6 w-6" />
          </div>
        ))}
        <div className="flex items-center gap-2 border-t border-line pt-2">
          <select
            value={addSym}
            onChange={(e) => setAddSym(e.target.value)}
            className="h-7 flex-1 rounded-card border border-line bg-bg px-2 text-[12px] text-ink outline-none focus:border-accent"
          >
            <option value="">Thêm symbol…</option>
            {available.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button
            type="button"
            disabled={!addSym}
            onClick={() => { setRows((rs) => [...rs, { symbol: addSym, pct: 0 }]); setAddSym(""); }}
            className="flex h-7 items-center gap-1 rounded-card border border-line px-2 text-[12px] hover:bg-hover disabled:opacity-40"
          >
            <Icon name="plus" size={13} /> Thêm
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------- hộp thoại xác nhận (reset / seed) ---------- */
function ConfirmModal({ open, onClose, title, message, confirmLabel, danger, busy, onConfirm, children }: {
  open: boolean; onClose: () => void; title: string; message: ReactNode;
  confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; children?: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={440}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-8 rounded-card border border-line px-3 text-[12px] hover:bg-hover">Huỷ</button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={
              "flex h-8 items-center gap-1.5 rounded-card px-3 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-40 " +
              (danger ? "bg-down" : "bg-accent")
            }
          >
            <Icon name={busy ? "refresh" : danger ? "undo" : "database"} size={14} className={busy ? "ml-pulse" : ""} />
            {busy ? "Đang xử lý…" : confirmLabel}
          </button>
        </div>
      }
    >
      <div className="space-y-3 px-4 py-3 text-[12px] leading-relaxed text-dim">
        {message}
        {children}
      </div>
    </Modal>
  );
}

/* ================= màn hình chính ================= */
export default function Portfolio({
  entries, livePrices, liveState, palette, onToast, onLog, onToggleLive, liveEnabled, onOpenSymbol,
}: {
  entries: WatchEntry[];
  livePrices: Record<string, number>;
  liveState: LiveState;
  palette: Palette;
  onToast: Notify;
  onLog: Notify;
  onToggleLive: () => void;
  liveEnabled: boolean;
  onOpenSymbol: (symbol: string) => void;
}) {
  const client = useQueryClient();
  const [benchmark, setBenchmark] = useState<Benchmark>("btc");
  const [tab, setTab] = useState<LedgerTab>("positions");
  const [orderReq, setOrderReq] = useState<OrderRequest | null>(null);
  const [rebalanceOpen, setRebalanceOpen] = useState(false);
  const [targetsOpen, setTargetsOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [seedOpen, setSeedOpen] = useState(false);
  const [seedDays, setSeedDays] = useState(60);

  const pf = useQuery({ queryKey: ["portfolio", "snapshot"], queryFn: ({ signal }) => fetchPortfolio(signal), refetchInterval: 15_000 });
  const equity = useQuery({ queryKey: ["portfolio", "equity", benchmark], queryFn: ({ signal }) => fetchEquity(benchmark, signal), refetchInterval: 60_000 });
  const fills = useQuery({ queryKey: ["portfolio", "fills"], queryFn: ({ signal }) => fetchFills(200, signal), refetchInterval: 30_000 });
  const cashLedger = useQuery({ queryKey: ["portfolio", "cash"], queryFn: ({ signal }) => fetchCashLedger(200, signal), refetchInterval: 30_000 });

  const refresh = useCallback(() => { void client.invalidateQueries({ queryKey: ["portfolio"] }); }, [client]);

  /* NAV / unrealized / weight nhảy theo giá live; cash + realized bất biến giữa các lần khớp. */
  const live = useMemo<LiveView | null>(() => {
    const snap = pf.data;
    if (!snap) return null;
    const useLive = liveState === "on";
    const positions: LivePosition[] = snap.positions.map((p) => {
      const lp = livePrices[p.symbol];
      const mark = useLive && lp !== undefined ? lp : p.mark;
      const cost = p.qty * p.avg;
      const value = p.qty * mark;
      const unrealized = value - cost;
      return { ...p, mark, cost, value, unrealized, unrealized_pct: cost ? unrealized / cost : 0 };
    });
    const holdings = positions.reduce((a, p) => a + p.value, 0);
    const nav = snap.cash + holdings;
    const unrealized = positions.reduce((a, p) => a + p.unrealized, 0);
    const costOpen = positions.reduce((a, p) => a + p.cost, 0);
    const withWeight = positions.map((p) => ({ ...p, weight: nav ? p.value / nav : 0 }));
    const current: Record<string, number> = { CASH: nav ? snap.cash / nav : 0 };
    for (const p of withWeight) current[p.symbol] = p.weight;
    const targets = snap.targets.map((t) => {
      const cur = current[t.symbol] ?? 0;
      return { ...t, current: cur, drift: cur - t.target };
    });
    return {
      ...snap, positions: withWeight, holdings, nav,
      nav_pct: snap.capital ? nav / snap.capital - 1 : 0,
      unrealized, unrealized_pct: costOpen ? unrealized / costOpen : 0, targets,
    };
  }, [pf.data, livePrices, liveState]);

  const resetMut = useMutation({
    mutationFn: resetPortfolio,
    onSuccess: () => {
      refresh();
      onToast(`Đã reset — xoá sổ lệnh, nạp lại ${usd(PAPER_CAPITAL)} tiền mặt.`, "ok");
      onLog("Reset danh mục paper về vốn khởi tạo", "ok");
      setResetOpen(false);
    },
    onError: (e: Error) => onToast(`Không reset được: ${e.message}`, "error"),
  });
  const seedMut = useMutation({
    mutationFn: () => seedPortfolio(seedDays),
    onSuccess: (res) => {
      refresh();
      onToast(`Đã seed ${res.seeded_orders} lệnh paper từ nến thật ${seedDays} ngày.`, "ok");
      onLog(`Seed ${res.seeded_orders} lệnh từ nến 1h thật (${seedDays} ngày)`, "ok");
      setSeedOpen(false);
    },
    onError: (e: Error) => onToast(`Không seed được: ${e.message}`, "error"),
  });

  const points = equity.data?.points ?? [];
  const m: EquityMetrics = equity.data?.metrics ?? {};
  const recon = live ? live.nav - live.capital - live.realized_net - live.unrealized : 0;
  const reconOk = Math.abs(recon) < 0.01;
  const defaultSymbol = live?.positions[0]?.symbol ?? entries[0]?.symbol ?? "BTC/USDT";
  const cashWeight = live && live.nav ? live.cash / live.nav : 0;

  const allocSegments = live
    ? [...live.positions.map((p) => ({ key: p.symbol, label: p.symbol.split("/")[0] ?? p.symbol, weight: p.weight, value: p.value, color: coinColor(p.symbol) })),
       { key: "CASH", label: "Tiền mặt", weight: cashWeight, value: live.cash, color: palette.faint }]
    : [];

  return (
    <div className="ml-thin-scroll min-h-0 flex-1 overflow-y-auto bg-bg">
      {/* Thanh điều khiển thường trực */}
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-1.5 border-b border-line bg-panel px-3 py-2">
        <span className="flex items-center gap-1.5 pr-1 text-[13px] font-semibold">
          <Icon name="wallet" size={15} className="text-accent" /> Tài sản
        </span>
        <span className="rounded-card border border-line px-1.5 text-[10px] uppercase text-faint">paper · {usd(PAPER_CAPITAL)}</span>
        <span className="rounded-card border border-line px-1.5 text-[10px] uppercase text-faint">binance</span>
        <span className="hidden text-[11px] text-faint sm:block">Khởi đầu {fmtTime(live?.inception)}</span>

        <div className="ml-auto flex items-center gap-1">
          <ToolButton
            icon="bolt"
            label={liveEnabled ? "Tắt luồng trực tiếp" : "Bật luồng trực tiếp"}
            active={liveEnabled && liveState === "on"}
            onClick={onToggleLive}
            className="h-6"
          >
            <span className="text-[11px]">{liveState === "on" ? "LIVE" : liveState === "connecting" ? "…" : "OFF"}</span>
          </ToolButton>
          <ToolButton icon="refresh" label="Làm mới danh mục" onClick={refresh} className="h-6" />
          <button
            type="button"
            onClick={() => setOrderReq({ symbol: defaultSymbol, side: "buy" })}
            className="flex h-7 items-center gap-1.5 rounded-card bg-accent px-2.5 text-[12px] font-medium text-white hover:opacity-90"
          >
            <Icon name="plus" size={14} /> Đặt lệnh
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 p-3">
        {pf.isPending ? (
          <div className="flex h-48 items-center justify-center rounded-card border border-line bg-panel text-[12px] text-faint ml-pulse">
            Đang tải danh mục và sổ cái…
          </div>
        ) : pf.isError || !live ? (
          <div className="rounded-card border border-line bg-panel">
            <Empty icon="alert" title="Không tải được danh mục" hint={(pf.error as Error | null)?.message ?? "Kiểm tra backend rồi thử lại."} />
            <div className="flex justify-center pb-5">
              <button type="button" onClick={refresh} className="flex h-7 items-center gap-1.5 rounded-card bg-accent px-3 text-[12px] font-medium text-white hover:opacity-90">
                <Icon name="refresh" size={14} /> Thử lại
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Vùng 1 — 5 thẻ KPI */}
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              <Kpi icon="wallet" label="NAV · Tổng tài sản" value={usd(live.nav)} tone={live.nav_pct >= 0 ? "up" : "down"}
                sub={<span className={live.nav_pct >= 0 ? "text-up" : "text-down"}>{fmtPct(live.nav_pct)} so với vốn</span>} />
              <Kpi icon="database" label="Tiền mặt khả dụng" value={usd(live.cash)}
                sub={`${fmtPct(cashWeight, 1)} NAV · không đổi khi giá nhảy`} />
              <Kpi icon="layers" label="Giá trị nắm giữ" value={usd(live.holdings)}
                sub={`${live.positions.length} vị thế · ${fmtPct(1 - cashWeight, 1)} NAV`} />
              <Kpi icon="bolt" label="Lãi/lỗ chưa chốt" live={liveState === "on"} value={signedUsd(live.unrealized)} tone={live.unrealized >= 0 ? "up" : "down"}
                sub={<span className={live.unrealized >= 0 ? "text-up" : "text-down"}>{fmtPct(live.unrealized_pct)} trên giá vốn</span>} />
              <Kpi icon="check" label="Lãi/lỗ đã chốt · ròng" value={signedUsd(live.realized_net)} tone={live.realized_net >= 0 ? "up" : "down"}
                sub={`đã trừ phí ${usd(live.fees)} · bất biến`} />
            </div>

            {/* Vùng 2 — đường vốn + phân bổ */}
            <div className="grid gap-3 xl:grid-cols-[2fr_1fr]">
              <section className="rounded-card border border-line bg-panel">
                <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
                  <div>
                    <h2 className="text-[12px] font-semibold">Đường vốn (NAV) so với benchmark</h2>
                    <p className="text-[10px] text-faint">Replay sổ cái trên nến 1h đã đóng · {points.length} điểm giờ · mua phí + trượt như thật</p>
                  </div>
                  <div className="flex items-center rounded-card border border-line" role="group" aria-label="Benchmark">
                    {BENCHMARKS.map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => setBenchmark(b.id)}
                        aria-pressed={benchmark === b.id}
                        className={"h-6 px-2 text-[11px] " + (benchmark === b.id ? "bg-hover font-semibold text-accent" : "text-dim hover:text-ink")}
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>
                </header>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 pt-2 text-[11px]">
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-pill" style={{ background: palette.accent }} />NAV <span className="tnum font-semibold">{usd(points[points.length - 1]?.nav ?? live.nav)}</span> <span className={"tnum " + ((m.total_return ?? 0) >= 0 ? "text-up" : "text-down")}>{fmtPct(m.total_return)}</span></span>
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-pill" style={{ background: palette.violet }} />Benchmark <span className="tnum font-semibold">{usd(points[points.length - 1]?.bench ?? live.capital)}</span> <span className={"tnum " + ((m.bench_return ?? 0) >= 0 ? "text-up" : "text-down")}>{fmtPct(m.bench_return)}</span></span>
                </div>
                {equity.isPending ? (
                  <div className="flex h-[250px] items-center justify-center text-[12px] text-faint ml-pulse">Đang replay đường vốn…</div>
                ) : (
                  <EquityChart points={points} palette={palette} />
                )}
                <div className="border-t border-line"><DrawdownChart points={points} palette={palette} /></div>
                <div className="grid grid-cols-4 gap-1.5 border-t border-line p-2 sm:grid-cols-8">
                  <Stat label="Sharpe" value={fmtNum(m.sharpe, 2)} tone={(m.sharpe ?? 0) >= 0 ? "up" : "down"} title="mean(r)/std(r)·√8760, log return" />
                  <Stat label="Sortino" value={fmtNum(m.sortino, 2)} tone={(m.sortino ?? 0) >= 0 ? "up" : "down"} title="Chỉ phạt downside deviation" />
                  <Stat label="Beta" value={fmtNum(m.beta, 2)} title="Cov(rp,rb)/Var(rb) so với benchmark" />
                  <Stat label="Alpha" value={fmtPct(m.alpha, 1)} tone={(m.alpha ?? 0) >= 0 ? "up" : "down"} title="Jensen annualised: (mean(rp)−β·mean(rb))·8760" />
                  <Stat label="Return" value={fmtPct(m.total_return)} tone={(m.total_return ?? 0) >= 0 ? "up" : "down"} />
                  <Stat label="Bench" value={fmtPct(m.bench_return)} tone={(m.bench_return ?? 0) >= 0 ? "up" : "down"} />
                  <Stat label="Max DD" value={fmtPct(m.max_drawdown)} tone="down" />
                  <Stat label="Volatility" value={m.volatility === undefined ? "—" : `${(m.volatility * 100).toFixed(1)}%`} title="std(log return)·√8760" />
                </div>
              </section>

              <section className="rounded-card border border-line bg-panel">
                <header className="border-b border-line px-3 py-2">
                  <h2 className="text-[12px] font-semibold">Phân bổ danh mục</h2>
                  <p className="text-[10px] text-faint">Tỷ trọng theo NAV live · mục tiêu và độ lệch</p>
                </header>
                <div className="space-y-3 p-3">
                  <div className="flex h-3.5 w-full overflow-hidden rounded-pill bg-hover" role="img" aria-label="Phân bổ tài sản">
                    {allocSegments.map((s) => (
                      <span key={s.key} style={{ width: `${Math.max(0, s.weight) * 100}%`, background: s.color }} title={`${s.label}: ${fmtPct(s.weight, 1)}`} />
                    ))}
                  </div>
                  <div className="space-y-1">
                    {allocSegments.map((s) => (
                      <div key={s.key} className="flex items-center gap-2 text-[11px]">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-pill" style={{ background: s.color }} />
                        <span className="min-w-0 flex-1 truncate font-medium">{s.label}</span>
                        <span className="tnum text-dim">{fmtPct(s.weight, 1)}</span>
                        <span className="tnum w-[84px] text-right text-faint">{usd(s.value)}</span>
                      </div>
                    ))}
                  </div>

                  <Divider />

                  <table className="w-full border-collapse text-[11px]">
                    <thead>
                      <tr className="text-[9px] uppercase tracking-wide text-faint">
                        <th className="py-1 text-left font-normal">Symbol</th>
                        <th className="py-1 text-right font-normal">Mục tiêu</th>
                        <th className="py-1 text-right font-normal">Hiện tại</th>
                        <th className="py-1 text-right font-normal">Lệch</th>
                      </tr>
                    </thead>
                    <tbody className="tnum">
                      {live.targets.map((t) => {
                        const over = Math.abs(t.drift) >= 0.005;
                        return (
                          <tr key={t.symbol} className="border-t border-line/50">
                            <td className="py-1 font-medium">{t.symbol === "CASH" ? "Tiền mặt" : t.symbol.split("/")[0]}</td>
                            <td className="py-1 text-right text-dim">{fmtPct(t.target, 1)}</td>
                            <td className="py-1 text-right">{fmtPct(t.current, 1)}</td>
                            <td className={"py-1 text-right font-medium " + (over ? (t.drift > 0 ? "text-warn" : "text-info") : "text-faint")}>
                              {t.drift >= 0 ? "+" : ""}{(t.drift * 100).toFixed(1)}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setRebalanceOpen(true)}
                      className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-card bg-accent px-2 text-[12px] font-semibold text-white hover:opacity-90"
                    >
                      <Icon name="swap" size={14} /> Rebalance
                    </button>
                    <button
                      type="button"
                      onClick={() => setTargetsOpen(true)}
                      className="flex h-8 items-center gap-1.5 rounded-card border border-line px-2.5 text-[12px] hover:bg-hover"
                    >
                      <Icon name="target" size={14} /> Mục tiêu
                    </button>
                  </div>
                </div>
              </section>
            </div>

            {/* Vùng 3 — bảng vị thế / lệnh / sổ tiền mặt */}
            <section className="rounded-card border border-line bg-panel">
              <div className="ml-thin-scroll flex h-9 items-center gap-1 overflow-x-auto border-b border-line px-2">
                {([
                  { id: "positions", label: "Vị thế", icon: "layers", count: live.positions.length },
                  { id: "fills", label: "Lệnh đã khớp", icon: "list", count: fills.data?.length ?? 0 },
                  { id: "cash", label: "Sổ tiền mặt", icon: "database", count: cashLedger.data?.length ?? 0 },
                ] as { id: LedgerTab; label: string; icon: string; count: number }[]).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTab(t.id)}
                    aria-pressed={tab === t.id}
                    className={
                      "flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-card px-2 text-[12px] transition-colors " +
                      (tab === t.id ? "bg-hover font-medium text-ink" : "text-dim hover:bg-hover")
                    }
                  >
                    <Icon name={t.icon} size={13} />
                    {t.label}
                    <span className="tnum rounded-pill bg-bg px-1 text-[10px] text-faint">{t.count}</span>
                  </button>
                ))}
                <span className="ml-auto hidden shrink-0 pl-2 text-[10px] text-faint md:block">
                  {tab === "positions" ? "Break-even = avg×(1+phí)/(1−phí) · RC = đóng góp rủi ro" : tab === "fills" ? "Mỗi lệnh là một event sổ kép, không sửa xoá" : "Số dư chạy suy ra từ posting CASH"}
                </span>
              </div>

              <div className="overflow-x-auto">
                {tab === "positions" && (
                  live.positions.length === 0 ? (
                    <Empty icon="layers" title="Chưa có vị thế nào" hint="Đặt lệnh mua hoặc seed lịch sử để bắt đầu. Tiền mặt đang giữ toàn bộ NAV." />
                  ) : (
                    <table className="w-full border-collapse text-[12px]">
                      <thead>
                        <tr className="border-b border-line text-[10px] uppercase tracking-wide text-faint">
                          <th className="px-3 py-2 text-left font-normal">Symbol</th>
                          <th className="px-3 py-2 text-right font-normal">Khối lượng</th>
                          <th className="px-3 py-2 text-right font-normal">Giá vốn</th>
                          <th className="px-3 py-2 text-right font-normal">Mark</th>
                          <th className="px-3 py-2 text-right font-normal">Giá trị</th>
                          <th className="px-3 py-2 text-right font-normal">Lãi/lỗ chưa chốt</th>
                          <th className="px-3 py-2 text-right font-normal">% NAV</th>
                          <th className="px-3 py-2 text-right font-normal">Break-even</th>
                          <th className="px-3 py-2 text-right font-normal">RC</th>
                          <th className="px-2 py-2 text-right font-normal">Hành động</th>
                        </tr>
                      </thead>
                      <tbody className="tnum">
                        {live.positions.map((p) => {
                          const up = p.unrealized >= 0;
                          const isLive = liveState === "on" && livePrices[p.symbol] !== undefined;
                          return (
                            <tr key={p.symbol} className="border-b border-line/60 last:border-b-0 hover:bg-hover/50">
                              <td className="px-3 py-2">
                                <button type="button" onClick={() => onOpenSymbol(p.symbol)} className="flex items-center gap-2 text-left" title={`Mở chart ${p.symbol}`}>
                                  <CoinBadge symbol={p.symbol} />
                                  <span className="min-w-0">
                                    <span className="flex items-center gap-1.5 font-semibold">{p.symbol.split("/")[0]}{isLive && <span className="rounded-card bg-up/15 px-1 text-[9px] font-medium text-up">LIVE</span>}</span>
                                    <span className="block truncate text-[10px] font-normal text-faint">{p.label ?? p.symbol}</span>
                                  </span>
                                </button>
                              </td>
                              <td className="px-3 py-2 text-right">{qtyFmt(p.qty)}</td>
                              <td className="px-3 py-2 text-right text-dim">{priceFmt(p.avg)}</td>
                              <td className="px-3 py-2 text-right"><Tick value={p.mark} digits={autoDigits(p.mark)} /></td>
                              <td className="px-3 py-2 text-right font-medium">{usd(p.value)}</td>
                              <td className={"px-3 py-2 text-right font-medium " + (up ? "text-up" : "text-down")}>
                                {signedUsd(p.unrealized)}
                                <span className="block text-[10px] font-normal">{fmtPct(p.unrealized_pct)}</span>
                              </td>
                              <td className="px-3 py-2 text-right">
                                {fmtPct(p.weight, 1)}
                                <span className="ml-auto mt-0.5 block h-1 w-12 rounded-pill bg-hover"><span className="block h-1 rounded-pill" style={{ width: `${Math.min(100, p.weight * 100)}%`, background: coinColor(p.symbol) }} /></span>
                              </td>
                              <td className="px-3 py-2 text-right text-dim" title="Giá hoà vốn sau phí hai chiều">{priceFmt(p.breakeven)}</td>
                              <td className="px-3 py-2 text-right text-dim" title="Đóng góp rủi ro: w·Cov(r_i,r_p)/Var(r_p)">{p.risk_contrib === null ? "—" : fmtPct(p.risk_contrib, 1)}</td>
                              <td className="px-2 py-2">
                                <span className="flex justify-end gap-1">
                                  <button type="button" onClick={() => setOrderReq({ symbol: p.symbol, side: "buy" })} className="h-6 rounded-card border border-line px-2 text-[11px] text-up hover:bg-up/10">Mua</button>
                                  <button type="button" onClick={() => setOrderReq({ symbol: p.symbol, side: "sell", qty: p.qty })} className="h-6 rounded-card border border-line px-2 text-[11px] text-down hover:bg-down/10">Đóng</button>
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )
                )}

                {tab === "fills" && (
                  fills.isPending ? (
                    <div className="flex h-32 items-center justify-center text-[12px] text-faint ml-pulse">Đang tải lệnh…</div>
                  ) : (fills.data?.length ?? 0) === 0 ? (
                    <Empty icon="list" title="Chưa có lệnh nào" hint="Lệnh mua/bán sẽ hiện ở đây dưới dạng event sổ kép bất biến." />
                  ) : (
                    <table className="w-full border-collapse text-[12px]">
                      <thead>
                        <tr className="border-b border-line text-[10px] uppercase tracking-wide text-faint">
                          <th className="px-3 py-2 text-left font-normal">Giờ (UTC)</th>
                          <th className="px-3 py-2 text-left font-normal">Lệnh</th>
                          <th className="px-3 py-2 text-left font-normal">Symbol</th>
                          <th className="px-3 py-2 text-right font-normal">Khối lượng</th>
                          <th className="px-3 py-2 text-right font-normal">Giá khớp</th>
                          <th className="px-3 py-2 text-right font-normal">Phí</th>
                          <th className="px-3 py-2 text-right font-normal">Realized</th>
                          <th className="px-3 py-2 text-left font-normal">Nguồn</th>
                          <th className="px-3 py-2 text-left font-normal">Ghi chú</th>
                        </tr>
                      </thead>
                      <tbody className="tnum">
                        {(fills.data ?? []).map((f) => (
                          <tr key={f.id + f.ts} className="border-b border-line/60 last:border-b-0 hover:bg-hover/50">
                            <td className="whitespace-nowrap px-3 py-1.5 text-dim">{fmtTime(f.ts)}</td>
                            <td className="px-3 py-1.5"><span className={"rounded-card px-1.5 py-0.5 text-[11px] font-medium " + (f.kind === "buy" ? "bg-up/15 text-up" : "bg-down/15 text-down")}>{f.kind === "buy" ? "Mua" : "Bán"}</span></td>
                            <td className="px-3 py-1.5 font-medium">{f.symbol.split("/")[0]}</td>
                            <td className="px-3 py-1.5 text-right">{qtyFmt(f.qty)}</td>
                            <td className="px-3 py-1.5 text-right">{priceFmt(f.price)}</td>
                            <td className="px-3 py-1.5 text-right text-dim">{usd(f.fee)}</td>
                            <td className={"px-3 py-1.5 text-right " + (f.realized === null ? "text-faint" : f.realized >= 0 ? "text-up" : "text-down")}>{f.realized === null ? "—" : signedUsd(f.realized)}</td>
                            <td className="px-3 py-1.5"><span className="rounded-card bg-hover px-1.5 py-0.5 text-[10px] text-dim">{sourceLabel(f.source)}</span></td>
                            <td className="max-w-[220px] truncate px-3 py-1.5 text-[11px] text-faint" title={f.note ?? ""}>{f.note ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                )}

                {tab === "cash" && (
                  cashLedger.isPending ? (
                    <div className="flex h-32 items-center justify-center text-[12px] text-faint ml-pulse">Đang tải sổ tiền mặt…</div>
                  ) : (cashLedger.data?.length ?? 0) === 0 ? (
                    <Empty icon="database" title="Chưa có biến động tiền mặt" hint="Mỗi dòng là một posting vào tài khoản CASH, số dư chạy cộng dồn." />
                  ) : (
                    <table className="w-full border-collapse text-[12px]">
                      <thead>
                        <tr className="border-b border-line text-[10px] uppercase tracking-wide text-faint">
                          <th className="px-3 py-2 text-left font-normal">Giờ (UTC)</th>
                          <th className="px-3 py-2 text-left font-normal">Loại</th>
                          <th className="px-3 py-2 text-left font-normal">Symbol</th>
                          <th className="px-3 py-2 text-right font-normal">Biến động</th>
                          <th className="px-3 py-2 text-right font-normal">Số dư</th>
                          <th className="px-3 py-2 text-left font-normal">Nguồn</th>
                          <th className="px-3 py-2 text-left font-normal">Ghi chú</th>
                        </tr>
                      </thead>
                      <tbody className="tnum">
                        {(cashLedger.data ?? []).map((c, i) => (
                          <tr key={c.ts + i} className="border-b border-line/60 last:border-b-0 hover:bg-hover/50">
                            <td className="whitespace-nowrap px-3 py-1.5 text-dim">{fmtTime(c.ts)}</td>
                            <td className="px-3 py-1.5">{kindLabel(c.kind)}</td>
                            <td className="px-3 py-1.5 font-medium">{c.symbol ? c.symbol.split("/")[0] : "—"}</td>
                            <td className={"px-3 py-1.5 text-right font-medium " + (c.amount >= 0 ? "text-up" : "text-down")}>{signedUsd(c.amount)}</td>
                            <td className="px-3 py-1.5 text-right">{usd(c.balance)}</td>
                            <td className="px-3 py-1.5"><span className="rounded-card bg-hover px-1.5 py-0.5 text-[10px] text-dim">{sourceLabel(c.source)}</span></td>
                            <td className="max-w-[220px] truncate px-3 py-1.5 text-[11px] text-faint" title={c.note ?? ""}>{c.note ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                )}
              </div>
            </section>

            {/* Vùng 4 — đối chiếu sổ kép + reset / seed */}
            <section className="rounded-card border border-line bg-panel px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="flex items-center gap-2">
                  <Icon name={reconOk ? "check" : "alert"} size={15} className={reconOk ? "text-up" : "text-down"} />
                  <span className="text-[12px] font-medium">Đối chiếu sổ cái kép</span>
                  <span className={"tnum rounded-card px-1.5 py-0.5 text-[11px] font-semibold " + (reconOk ? "bg-up/15 text-up" : "bg-down/15 text-down")}>
                    {reconOk ? "khớp · 0.00" : `lệch ${signedUsd(recon)}`}
                  </span>
                </div>
                <span className="tnum text-[11px] text-dim">NAV − Vốn = {signedUsd(live.nav - live.capital)} · Realized ròng + Unrealized = {signedUsd(live.realized_net + live.unrealized)}</span>
                <span className="tnum text-[11px] text-faint">Vốn {usd(live.capital)} · Phí luỹ kế {usd(live.fees)}</span>
                <div className="ml-auto flex gap-2">
                  <button type="button" onClick={() => setSeedOpen(true)} className="flex h-7 items-center gap-1.5 rounded-card border border-line px-2.5 text-[12px] hover:bg-hover">
                    <Icon name="database" size={14} /> Seed lịch sử
                  </button>
                  <button type="button" onClick={() => setResetOpen(true)} className="flex h-7 items-center gap-1.5 rounded-card border border-line px-2.5 text-[12px] text-down hover:bg-down/10">
                    <Icon name="undo" size={14} /> Reset về {usd(PAPER_CAPITAL)}
                  </button>
                </div>
              </div>
            </section>

            <p className="pb-2 text-[10px] leading-relaxed text-faint">
              NAV<sub>t</sub> = Tiền mặt + Σ(Khối lượng × giá đóng 1h). Mua dùng giá vốn bình quân gia quyền; bán giữ nguyên giá vốn,
              phần chênh lệch ghi vào realized ròng sau phí. Mọi số dư suy ra từ posting sổ kép (tổng mỗi event = 0 theo từng đơn vị),
              không lưu balance rời nên đối chiếu luôn khớp. Đường vốn replay từ journal trên nến đã đóng nên tái lập được;
              thẻ KPI và cột mark nhảy theo giá live qua SSE. Beta = Cov(r<sub>p</sub>,r<sub>b</sub>)/Var(r<sub>b</sub>); Alpha Jensen annual hoá.
              Đây là paper trading — không dùng tiền thật.
            </p>

            {/* Hộp thoại */}
            <OrderModal
              request={orderReq}
              onClose={() => setOrderReq(null)}
              entries={entries}
              positions={live.positions}
              cash={live.cash}
              livePrices={livePrices}
              liveState={liveState}
              onToast={onToast}
              onLog={onLog}
              onChanged={refresh}
            />
            <RebalanceModal open={rebalanceOpen} onClose={() => setRebalanceOpen(false)} onToast={onToast} onLog={onLog} onChanged={refresh} />
            <TargetsModal open={targetsOpen} onClose={() => setTargetsOpen(false)} targets={live.targets} entries={entries} onToast={onToast} onLog={onLog} onChanged={refresh} />
            <ConfirmModal
              open={resetOpen}
              onClose={() => setResetOpen(false)}
              title="Reset danh mục paper?"
              danger
              busy={resetMut.isPending}
              confirmLabel="Reset về tiền mặt"
              onConfirm={() => resetMut.mutate()}
              message={<>Toàn bộ lệnh và sổ cái hiện tại sẽ bị xoá, thay bằng một khoản nạp {usd(PAPER_CAPITAL)} tiền mặt ở thời điểm hiện tại. Không thể hoàn tác.</>}
            />
            <ConfirmModal
              open={seedOpen}
              onClose={() => setSeedOpen(false)}
              title="Seed lịch sử từ nến thật"
              busy={seedMut.isPending}
              confirmLabel="Seed ngay"
              onConfirm={() => seedMut.mutate()}
              message={<>Replay một chiến lược paper (mở vị thế core, DCA, chốt lời từng phần) qua nến 1h thật trong khoảng dưới đây, đi qua đúng engine phí + trượt giá. Mọi lệnh gắn nhãn <code className="text-ink">source='seed'</code>. Yêu cầu danh mục đang trống (reset trước nếu đã có lệnh).</>}
            >
              <label className="flex items-center gap-2 text-[12px]">
                Số ngày lịch sử
                <input
                  type="number"
                  min={7}
                  max={365}
                  value={seedDays}
                  onChange={(e) => setSeedDays(Math.min(365, Math.max(7, Number(e.target.value) || 60)))}
                  className="tnum h-7 w-20 rounded-card border border-line bg-bg px-2 text-right text-[12px] outline-none focus:border-accent"
                />
                ngày
              </label>
            </ConfirmModal>
          </>
        )}
      </div>
    </div>
  );
}