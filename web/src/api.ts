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

export const fetchCandles = (symbol: string, timeframe: string, limit: number, signal?: AbortSignal) =>
  get<CandlesResponse>(
    `/api/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&limit=${limit}`,
    signal,
  );

export const fetchSummary = (symbol: string, timeframe: string, limit: number, signal?: AbortSignal) =>
  get<Summary>(
    `/api/summary?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&limit=${limit}`,
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

export async function addSymbol(symbol: string, label?: string): Promise<{ entry: WatchEntry; written: number }> {
  const res = await fetch("/api/watchlist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol, label: label ?? null }),
  });
  if (!res.ok) throw new Error(truncate(await res.text().catch(() => `${res.status}`)));
  return (await res.json()) as { entry: WatchEntry; written: number };
}

export async function removeSymbol(symbol: string): Promise<{ removed: string }> {
  const res = await fetch(`/api/watchlist?symbol=${encodeURIComponent(symbol)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(truncate(await res.text().catch(() => `${res.status}`)));
  return (await res.json()) as { removed: string };
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
