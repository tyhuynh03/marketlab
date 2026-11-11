import {
  ColorType,
  CrosshairMode,
  LineStyle,
  PriceScaleMode,
  TickMarkType,
  type BusinessDay,
  type ChartOptions,
  type DeepPartial,
} from "lightweight-charts";

export type Theme = "dark" | "light";

export type Palette = {
  bg: string;
  panel: string;
  elev: string;
  line: string;
  line2: string;
  text: string;
  dim: string;
  faint: string;
  accent: string;
  up: string;
  down: string;
  warn: string;
  info: string;
  violet: string;
};

const FALLBACK: Palette = {
  bg: "#131722",
  panel: "#1e222d",
  elev: "#262b3e",
  line: "#2a2e39",
  line2: "#363a45",
  text: "#d1d4dc",
  dim: "#787b86",
  faint: "#5d606b",
  accent: "#2962ff",
  up: "#26a69a",
  down: "#ef5350",
  warn: "#ff9800",
  info: "#2196f3",
  violet: "#9c27b0",
};

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/** Canvas không đọc được class Tailwind nên lấy màu thẳng từ biến CSS. */
export function readPalette(): Palette {
  if (typeof window === "undefined") return FALLBACK;
  const style = getComputedStyle(document.documentElement);
  const read = (key: keyof Palette, cssVar: string) =>
    style.getPropertyValue(cssVar).trim() || FALLBACK[key];
  return {
    bg: read("bg", "--c-bg"),
    panel: read("panel", "--c-panel"),
    elev: read("elev", "--c-elev"),
    line: read("line", "--c-line"),
    line2: read("line2", "--c-line2"),
    text: read("text", "--c-text"),
    dim: read("dim", "--c-dim"),
    faint: read("faint", "--c-faint"),
    accent: read("accent", "--c-accent"),
    up: read("up", "--c-up"),
    down: read("down", "--c-down"),
    warn: read("warn", "--c-warn"),
    info: read("info", "--c-info"),
    violet: read("violet", "--c-violet"),
  };
}

export function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const n = Number.parseInt(full.slice(0, 6), 16);
  if (Number.isNaN(n)) return hex;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export type ChartLook = {
  grid: boolean;
  logScale: boolean;
  magnet: boolean;
};

export function chartOptions(p: Palette, look: ChartLook): DeepPartial<ChartOptions> {
  const gridColor = look.grid ? p.line : "rgba(0,0,0,0)";
  return {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: p.bg },
      textColor: p.dim,
      fontSize: 11,
      fontFamily: getComputedStyle(document.body).fontFamily,
      attributionLogo: false,
      panes: { separatorColor: p.line2, separatorHoverColor: withAlpha(p.dim, 0.25), enableResize: true },
    },
    grid: { vertLines: { color: gridColor }, horzLines: { color: gridColor } },
    crosshair: {
      mode: look.magnet ? CrosshairMode.Magnet : CrosshairMode.Normal,
      vertLine: { color: p.dim, width: 1, style: LineStyle.Dashed, labelBackgroundColor: p.line2 },
      horzLine: { color: p.dim, width: 1, style: LineStyle.Dashed, labelBackgroundColor: p.line2 },
    },
    rightPriceScale: {
      borderColor: p.line,
      mode: look.logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
      entireTextOnly: true,
      scaleMargins: { top: 0.12, bottom: 0.08 },
    },
    timeScale: {
      borderColor: p.line,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 6,
      barSpacing: 8,
      minBarSpacing: 1.5,
      fixLeftEdge: false,
      lockVisibleTimeRangeOnResize: true,
      tickMarkFormatter,
    },
    localization: {
      locale: "en-US",
      timeFormatter: (time: number) => formatCrosshairTime(time),
    },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true },
  };
}

/** lightweight-charts chỉ hiểu UTC; đổi múi giờ bằng cách tịnh tiến chính mốc thời gian. */
export function tzOffsetSeconds(timezone: "utc" | "local"): number {
  return timezone === "local" ? -new Date().getTimezoneOffset() * 60 : 0;
}

export function tzLabel(timezone: "utc" | "local"): string {
  if (timezone === "utc") return "UTC";
  const minutes = -new Date().getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, "0")}` : ""}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Nhận mốc đã tịnh tiến nên luôn đọc bằng getter UTC. */
export function formatCrosshairTime(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function tickMarkFormatter(time: unknown, type: TickMarkType): string {
  const seconds = typeof time === "number"
    ? time
    : typeof time === "object" && time !== null && "year" in time
      ? Date.UTC((time as BusinessDay).year, (time as BusinessDay).month - 1, (time as BusinessDay).day) / 1000
      : Number(time);
  const d = new Date(seconds * 1000);
  if (Number.isNaN(d.getTime())) return "";
  switch (type) {
    case TickMarkType.Year:
      return String(d.getUTCFullYear());
    case TickMarkType.Month:
      return d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
    case TickMarkType.DayOfMonth:
      return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}`;
    default:
      return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
}