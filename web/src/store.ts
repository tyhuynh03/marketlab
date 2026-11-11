import { useCallback, useEffect, useState } from "react";
import { makeIndicator, type Indicator } from "./indicators";
import { applyTheme, type Theme } from "./theme";

export type ChartType = "candles" | "hollow" | "heikin" | "bars" | "line" | "area";
export type BottomTab = "metrics" | "data" | "log" | "about";

export const CHART_TYPES: { id: ChartType; label: string; hint: string }[] = [
  { id: "candles", label: "Nến Nhật", hint: "OHLC đặc" },
  { id: "hollow", label: "Nến rỗng", hint: "Nến tăng để rỗng" },
  { id: "heikin", label: "Heikin Ashi", hint: "Làm mượt xu thế" },
  { id: "bars", label: "Thanh OHLC", hint: "Bar chart" },
  { id: "line", label: "Đường", hint: "Chỉ giá đóng" },
  { id: "area", label: "Vùng", hint: "Tô dưới đường giá" },
];

export type Settings = {
  theme: Theme;
  chartType: ChartType;
  grid: boolean;
  logScale: boolean;
  magnet: boolean;
  volume: boolean;
  watermark: boolean;
  upColor: string;
  downColor: string;
  timezone: "utc" | "local";
  live: boolean;
  rightPanel: boolean;
  bottomPanel: boolean;
  bottomHeight: number;
  bottomTab: BottomTab;
  indicators: Indicator[];
};

export function defaultSettings(): Settings {
  return {
    theme: "dark",
    chartType: "candles",
    grid: true,
    logScale: false,
    magnet: false,
    volume: true,
    watermark: true,
    upColor: "",
    downColor: "",
    timezone: "utc",
    live: true,
    rightPanel: true,
    bottomPanel: true,
    bottomHeight: 232,
    bottomTab: "metrics",
    indicators: [makeIndicator("sma", "#f7a600"), { ...makeIndicator("ema", "#2962ff"), period: 50 }],
  };
}

const KEY = "ml.settings.v2";

function load(): Settings {
  const base = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<Settings>;
    const merged = { ...base, ...saved };
    if (!Array.isArray(merged.indicators)) merged.indicators = base.indicators;
    merged.bottomHeight = Math.min(520, Math.max(140, Number(merged.bottomHeight) || base.bottomHeight));
    return merged;
  } catch {
    return base;
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(load);

  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      /* quyền riêng tư chặn storage thì chạy với giá trị trong bộ nhớ */
    }
  }, [settings]);

  const update = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
  }, []);

  const patch = useCallback((partial: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...partial }));
  }, []);

  const reset = useCallback(() => {
    const fresh = defaultSettings();
    setSettings((s) => ({ ...fresh, rightPanel: s.rightPanel, bottomPanel: s.bottomPanel }));
  }, []);

  return { settings, update, patch, reset };
}