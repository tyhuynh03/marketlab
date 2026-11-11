import type { Candle } from "./api";

export type IndicatorKind = "sma" | "ema" | "bb" | "rsi" | "macd";

export type Indicator = {
  id: string;
  kind: IndicatorKind;
  period: number;
  mult: number;
  fast: number;
  slow: number;
  signal: number;
  color: string;
  visible: boolean;
};

export const INDICATOR_NAMES: Record<IndicatorKind, string> = {
  sma: "Đường trung bình đơn (SMA)",
  ema: "Đường trung bình luỹ thừa (EMA)",
  bb: "Dải Bollinger",
  rsi: "Sức mạnh tương đối (RSI)",
  macd: "MACD",
};

export const INDICATOR_SHORT: Record<IndicatorKind, string> = {
  sma: "SMA",
  ema: "EMA",
  bb: "BB",
  rsi: "RSI",
  macd: "MACD",
};

/** RSI và MACD nằm pane riêng; ba loại còn lại vẽ đè lên giá. */
export const OVERLAY_KINDS: IndicatorKind[] = ["sma", "ema", "bb"];

let seq = 0;
export function makeIndicator(kind: IndicatorKind, color: string): Indicator {
  seq += 1;
  return {
    id: `${kind}-${Date.now().toString(36)}-${seq}`,
    kind,
    period: kind === "rsi" ? 14 : 20,
    mult: 2,
    fast: 12,
    slow: 26,
    signal: 9,
    color,
    visible: true,
  };
}

export function indicatorLabel(ind: Indicator): string {
  switch (ind.kind) {
    case "bb":
      return `BB ${ind.period} ${ind.mult}`;
    case "macd":
      return `MACD ${ind.fast} ${ind.slow} ${ind.signal}`;
    default:
      return `${INDICATOR_SHORT[ind.kind]} ${ind.period}`;
  }
}

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period < 1) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period < 1 || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i]!;
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function bollinger(values: number[], period: number, mult: number) {
  const middle = sma(values, period);
  const upper: (number | null)[] = new Array(values.length).fill(null);
  const lower: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i += 1) {
    const mean = middle[i];
    if (mean === null || mean === undefined) continue;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j += 1) acc += (values[j]! - mean) ** 2;
    const sd = Math.sqrt(acc / period);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { upper, middle, lower };
}

/** RSI theo làm mượt Wilder, không phải SMA của lãi/lỗ. */
export function rsi(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period || period < 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = values[i]! - values[i - 1]!;
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const diff = values[i]! - values[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function macd(values: number[], fast: number, slow: number, signalPeriod: number) {
  const fastLine = ema(values, fast);
  const slowLine = ema(values, slow);
  const line: (number | null)[] = values.map((_, i) =>
    fastLine[i] !== null && slowLine[i] !== null ? (fastLine[i] as number) - (slowLine[i] as number) : null,
  );
  const firstIdx = line.findIndex((v) => v !== null);
  const signal: (number | null)[] = new Array(values.length).fill(null);
  const hist: (number | null)[] = new Array(values.length).fill(null);
  if (firstIdx >= 0) {
    const tail = line.slice(firstIdx) as number[];
    const sig = ema(tail, signalPeriod);
    for (let i = 0; i < sig.length; i += 1) {
      const value = sig[i];
      if (value === null || value === undefined) continue;
      signal[firstIdx + i] = value;
      hist[firstIdx + i] = line[firstIdx + i]! - value;
    }
  }
  return { line, signal, hist };
}

export function heikinAshi(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const close = (c.open + c.high + c.low + c.close) / 4;
    const prev = out[out.length - 1];
    const open = prev ? (prev.open + prev.close) / 2 : (c.open + c.close) / 2;
    out.push({
      ts: c.ts,
      open,
      close,
      high: Math.max(c.high, open, close),
      low: Math.min(c.low, open, close),
      volume: c.volume,
    });
  }
  return out;
}

export function drawdownSeries(closes: number[]): number[] {
  let peak = Number.NEGATIVE_INFINITY;
  return closes.map((c) => {
    peak = Math.max(peak, c);
    return peak > 0 ? c / peak - 1 : 0;
  });
}

export function equitySeries(closes: number[]): number[] {
  const base = closes[0];
  if (!base) return closes.map(() => 1);
  return closes.map((c) => c / base);
}