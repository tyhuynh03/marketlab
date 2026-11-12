export type Candle = {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type CandlesResponse = {
  symbol: string;
  timeframe: string;
  venue: string;
  candles: Candle[];
};

export type WatchEntry = {
  venue: string;
  symbol: string;
  timeframe: string;
  label: string | null;
  candles: number;
  last_ts: string | null;
  last_close: number | null;
  prev_close: number | null;
  delta: number | null;
};

export type Summary = {
  symbol: string;
  timeframe: string;
  observations: number;
  error?: string;
  first_close?: number;
  last_close?: number;
  total_return?: number;
  annualized_return?: number;
  max_drawdown?: number;
  volatility?: number;
  sharpe?: number;
  sortino?: number;
  calmar?: number;
};

export type Health = {
  status: string;
  timescaledb: string | null;
  candles: number;
};

/** Các timeframe backend thật sự có dữ liệu: nến gốc + continuous aggregate. */
export const TIMEFRAMES = ["1h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const LIMITS = [90, 250, 500, 1000] as const;

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} — ${truncate(detail)}`);
  }
  return (await res.json()) as T;
}

function truncate(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 180 ? `${clean.slice(0, 180)}…` : clean;
}

export const fetchHealth = (signal?: AbortSignal) => get<Health>("/health", signal);

export const fetchWatchlist = (signal?: AbortSignal) =>
  get<WatchEntry[]>("/api/watchlist", signal);

export const fetchCandles = (
  symbol: string, timeframe: string, limit: number, venue: string, signal?: AbortSignal,
) =>
  get<CandlesResponse>(
    `/api/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&limit=${limit}&venue=${encodeURIComponent(venue)}`,
    signal,
  );

export const fetchSummary = (
  symbol: string, timeframe: string, limit: number, venue: string, signal?: AbortSignal,
) =>
  get<Summary>(
    `/api/summary?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&limit=${limit}&venue=${encodeURIComponent(venue)}`,
    signal,
  );

export async function triggerIngest(symbol?: string, days?: number): Promise<Record<string, number>> {
  const params = new URLSearchParams();
  if (symbol) params.set("symbol", symbol);
  if (days) params.set("days", String(days));
  const query = params.toString();
  const res = await fetch(`/api/ingest${query ? `?${query}` : ""}`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`${res.status} — ${truncate(await res.text().catch(() => ""))}`);
  }
  return (await res.json()) as Record<string, number>;
}

export async function addSymbol(
  symbol: string, label?: string, venue?: string,
): Promise<{ entry: WatchEntry; written: number }> {
  const res = await fetch("/api/watchlist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol, label: label ?? null, venue: venue ?? null }),
  });
  if (!res.ok) throw new Error(truncate(await res.text().catch(() => `${res.status}`)));
  return (await res.json()) as { entry: WatchEntry; written: number };
}

export async function removeSymbol(symbol: string, venue?: string): Promise<{ removed: string }> {
  const query = venue ? `&venue=${encodeURIComponent(venue)}` : "";
  const res = await fetch(`/api/watchlist?symbol=${encodeURIComponent(symbol)}${query}`, { method: "DELETE" });
  if (!res.ok) throw new Error(truncate(await res.text().catch(() => `${res.status}`)));
  return (await res.json()) as { removed: string };
}

/** nhãn venue trên UI: cổ phiếu Mỹ hiện là "US", crypto giữ tên sàn. */
export function venueLabel(venue: string): string {
  return venue === "yahoo" ? "US" : venue;
}

/** Số chữ số thập phân vừa đủ đọc: SHIB cần 8, BTC chỉ cần 2. */
export function autoDigits(price: number | null | undefined): number {
  const abs = Math.abs(price ?? 0);
  if (abs >= 100) return 2;
  if (abs >= 1) return 3;
  if (abs >= 0.01) return 5;
  return 8;
}

export function fmtCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toFixed(2);
}

export const TIMEFRAME_SECONDS: Record<string, number> = {
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

export function fmtPct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
}

export function fmtNum(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toFixed(digits);
}

export function fmtPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().slice(0, 16).replace("T", " ");
}

/* ---------- Paper trading / Portfolio ---------- */

/** Khớp đúng backend portfolio.py: phí taker 0.1%, trượt giá 0.05% chiều bất lợi. */
export const PAPER_FEE_RATE = 0.001;
export const PAPER_SLIPPAGE = 0.0005;
export const PAPER_CAPITAL = 1000;

export type Benchmark = "btc" | "8020";

export type Position = {
  symbol: string;
  label: string | null;
  qty: number;
  avg: number;
  mark: number;
  mark_source: "live" | "closed";
  value: number;
  unrealized: number;
  unrealized_pct: number;
  weight: number;
  breakeven: number;
  risk_contrib: number | null;
};

export type TargetDrift = { symbol: string; target: number; current: number; drift: number };

export type PortfolioSnapshot = {
  inception: string | null;
  capital: number;
  cash: number;
  holdings: number;
  nav: number;
  nav_pct: number;
  unrealized: number;
  unrealized_pct: number;
  realized_net: number;
  fees: number;
  positions: Position[];
  targets: TargetDrift[];
  reconciliation: number;
};

export type EquityPoint = { ts: string; nav: number; bench: number; dd: number; dd_bench: number };

export type EquityMetrics = {
  sharpe?: number;
  sortino?: number;
  max_drawdown?: number;
  volatility?: number;
  total_return?: number;
  bench_return?: number;
  beta?: number | null;
  alpha?: number | null;
};

export type EquityResponse = {
  inception: string | null;
  benchmark?: string;
  points: EquityPoint[];
  metrics: EquityMetrics;
};

export type FillRow = {
  ts: string;
  kind: "buy" | "sell";
  symbol: string;
  qty: number;
  price: number;
  fee: number;
  realized: number | null;
  source: string;
  id: string;
  note: string | null;
};

export type CashRow = {
  ts: string;
  kind: string;
  symbol: string | null;
  source: string;
  note: string | null;
  amount: number;
  balance: number;
};

export type RebalanceItem = {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  est_price: number;
  est_fee: number;
  current: number;
  target: number;
  drift: number;
};

export type OrderResult = {
  duplicate?: boolean;
  id?: string;
  mark_source?: string;
  ts?: string;
  kind?: string;
  symbol?: string;
  qty?: number;
  price?: number;
  fee?: number;
  realized?: number | null;
  source?: string;
};

async function errorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    if (parsed && typeof parsed.detail === "string") return parsed.detail;
  } catch {
    /* không phải JSON */
  }
  return `${res.status} — ${truncate(text)}`;
}

async function send<T>(path: string, method: "POST" | "PUT", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorDetail(res));
  return (await res.json()) as T;
}

export const fetchPortfolio = (signal?: AbortSignal) => get<PortfolioSnapshot>("/api/portfolio", signal);

export const fetchEquity = (benchmark: Benchmark, signal?: AbortSignal) =>
  get<EquityResponse>(`/api/portfolio/equity?benchmark=${benchmark}`, signal);

export const fetchFills = (limit = 200, signal?: AbortSignal) =>
  get<FillRow[]>(`/api/portfolio/ledger?tab=fills&limit=${limit}`, signal);

export const fetchCashLedger = (limit = 200, signal?: AbortSignal) =>
  get<CashRow[]>(`/api/portfolio/ledger?tab=cash&limit=${limit}`, signal);

export const fetchRebalancePlan = () =>
  send<{ plan: RebalanceItem[] }>("/api/portfolio/rebalance", "POST", { execute: false });

export const executeRebalance = (idemKey?: string) =>
  send<{ executed: FillRow[] }>("/api/portfolio/rebalance", "POST", { execute: true, idem_key: idemKey });

export const placeOrder = (body: { symbol: string; side: "buy" | "sell"; qty: number; idem_key?: string }) =>
  send<OrderResult>("/api/portfolio/order", "POST", body);

export const setTargets = (weights: Record<string, number>) =>
  send<{ weights: Record<string, number> }>("/api/portfolio/targets", "PUT", { weights });

export const resetPortfolio = () => send<{ reset: string }>("/api/portfolio/reset", "POST");

export const seedPortfolio = (days = 60) =>
  send<{ seeded_orders: number }>("/api/portfolio/seed", "POST", { days });

/* ---------- Backtest (engine thuần, hợp đồng docs/strategy-contract.md) ---------- */

export type BacktestStrategy = "sma_cross" | "buy_hold";

export type BacktestMetrics = {
  total_return: number;
  annualized_return: number;
  max_drawdown: number;
  volatility: number;
  sharpe: number;
  sortino: number;
  calmar: number;
};

export type BacktestEquityPoint = { ts: string; equity: number; weight: number; dd: number };

export type BacktestFill = {
  signal_ts: string;
  fill_ts: string;
  side: "buy" | "sell";
  raw_open: number;
  exec_price: number;
  qty: number;
  fee: number;
  notional: number;
};

export type BacktestFinal = { cash: number; qty: number; equity: number; position_weight: number };

/** Một cửa sổ holdout: chỉ số chiến lược + benchmark, đếm lệnh khớp trong cửa sổ. */
export type BacktestWindow = {
  observations: number;
  metrics: BacktestMetrics;
  benchmark_metrics: BacktestMetrics;
  n_fills: number;
};

export type BacktestHoldout = {
  oos_fraction: number;
  train_bars: number;
  test_bars: number;
  boundary_ts: string;
  train_start_ts: string;
  test_end_ts: string;
  in_sample: BacktestWindow;
  out_of_sample: BacktestWindow;
};

export type BacktestResponse = {
  strategy: string;
  symbol: string;
  venue: string;
  timeframe: string;
  ppy: number;
  initial_capital: number;
  observations: number;
  equity: BacktestEquityPoint[];
  metrics: BacktestMetrics;
  fills: BacktestFill[];
  dropped_signals: { ts: string; weight: number; reason: string }[];
  clamped_weights: { ts: string; raw_weight: number; weight: number }[];
  final: BacktestFinal;
  benchmark: { strategy: string; metrics: BacktestMetrics; equity: BacktestEquityPoint[]; final: BacktestFinal };
  holdout: BacktestHoldout;
};

export type BacktestParams = {
  symbol: string;
  timeframe: string;
  limit: number;
  venue: string;
  strategy: BacktestStrategy;
  fast: number;
  slow: number;
  oos: number;
};

export const fetchBacktest = (p: BacktestParams, signal?: AbortSignal) =>
  get<BacktestResponse>(
    `/api/backtest?symbol=${encodeURIComponent(p.symbol)}&timeframe=${encodeURIComponent(p.timeframe)}` +
    `&limit=${p.limit}&venue=${encodeURIComponent(p.venue)}&strategy=${p.strategy}` +
    `&fast=${p.fast}&slow=${p.slow}&oos=${p.oos}`,
    signal,
  );
