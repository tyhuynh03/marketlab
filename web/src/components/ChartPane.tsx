import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createTextWatermark,
  type HistogramData,
  type IChartApi,
  type IPaneApi,
  type ISeriesApi,
  type ITextWatermarkPluginApi,
  type LineData,
  type Logical,
  type SeriesType,
  type Time,
  type UTCTimestamp,
  type WhitespaceData,
} from "lightweight-charts";
import { autoDigits, fmtCompact, fmtPrice, type Candle } from "../api";
import {
  hitHandle,
  hitTest,
  newShapeId,
  renderShapes,
  type Anchor,
  type Projector,
  type Shape,
  type ToolId,
} from "../drawings";
import { bollinger, ema, heikinAshi, indicatorLabel, macd, rsi, sma } from "../indicators";
import type { Settings } from "../store";
import { chartOptions, formatCrosshairTime, tzOffsetSeconds, withAlpha, type Palette } from "../theme";
import { Icon, ToolButton } from "./ui";

type Point = LineData<Time> | WhitespaceData<Time>;
type Bar = HistogramData<Time> | WhitespaceData<Time>;

type Prepared = {
  key: string;
  type: "line" | "histogram";
  pane: number;
  color: string;
  dashed: boolean;
  data: Point[] | Bar[];
};

type PreparedIndicator = {
  id: string;
  label: string;
  color: string;
  visible: boolean;
  pane: number;
  legend: (number | null)[];
  extra: { label: string; color: string; values: (number | null)[] }[];
  series: Prepared[];
};

export type ChartHandle = {
  screenshot(): HTMLCanvasElement | null;
  fitAll(): void;
  zoom(factor: number): void;
  scrollToLatest(): void;
};

export type ChartPaneProps = {
  symbol: string;
  venue: string;
  timeframe: string;
  stepSeconds: number;
  candles: Candle[];
  forming: boolean;
  settings: Settings;
  palette: Palette;
  tool: ToolId;
  drawColor: string;
  locked: boolean;
  hidden: boolean;
  shapes: Shape[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  onToolChange: (tool: ToolId) => void;
  onShapesChange: (shapes: Shape[]) => void;
  onSelect: (id: string | null) => void;
  onHover: (candle: Candle | null) => void;
  onLog: (text: string) => void;
  onToggleIndicator: (id: string) => void;
  onRemoveIndicator: (id: string) => void;
};

function ascending(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const t = Date.parse(c.ts);
    if (Number.isNaN(t)) continue;
    const prev = out[out.length - 1];
    if (!prev) out.push(c);
    else if (t > Date.parse(prev.ts)) out.push(c);
    else if (t === Date.parse(prev.ts)) out[out.length - 1] = c;
  }
  return out;
}

function LegendLine({
  label, color, visible, value, onToggle, onRemove,
}: {
  label: string;
  color: string;
  visible: boolean;
  value: string;
  onToggle: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="group flex items-center gap-1.5">
      <span className="tnum" style={{ color: visible ? color : "var(--c-faint)" }}>
        {label} {value}
      </span>
      <span className="pointer-events-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <ToolButton
          icon={visible ? "eye" : "eyeOff"}
          label={visible ? `Ẩn ${label}` : `Hiện ${label}`}
          onClick={onToggle}
          className="h-5 w-5"
        />
        <ToolButton icon="close" label={`Bỏ ${label}`} onClick={onRemove} className="h-5 w-5" />
      </span>
    </div>
  );
}

const ChartPane = forwardRef<ChartHandle, ChartPaneProps>(function ChartPane(props, ref) {
  const {
    symbol, venue, timeframe, stepSeconds, candles, forming, settings, palette, tool, drawColor,
    locked, hidden, shapes, selectedId, loading, error,
    onToolChange, onShapesChange, onSelect, onHover, onLog, onToggleIndicator, onRemoveIndicator,
  } = props;

  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const indicatorRef = useRef(new Map<string, ISeriesApi<SeriesType>[]>());
  const watermarkRef = useRef<ITextWatermarkPluginApi<Time> | null>(null);
  const structureRef = useRef("");
  const identityRef = useRef("");
  const lookupRef = useRef(new Map<number, Candle>());
  const versionRef = useRef(0);
  const lengthRef = useRef(0);
  const draftRef = useRef<Shape | null>(null);
  const hoverShapeRef = useRef<string | null>(null);
  const dragRef = useRef<
    | { mode: "create" }
    | { mode: "handle"; id: string; which: "a" | "b" }
    | { mode: "move"; id: string; from: Anchor; original: Shape }
    | null
  >(null);

  const [hovered, setHovered] = useState<Candle | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [paneTops, setPaneTops] = useState<number[]>([]);
  const paneKeyRef = useRef("");

  const offset = tzOffsetSeconds(settings.timezone);
  const upColor = settings.upColor || palette.up;
  const downColor = settings.downColor || palette.down;

  const view = useMemo(() => {
    const base = settings.chartType === "heikin" ? heikinAshi(ascending(candles)) : ascending(candles);
    return base.map((c) => ({ ...c, t: (Math.floor(Date.parse(c.ts) / 1000) + offset) as UTCTimestamp }));
  }, [candles, settings.chartType, offset]);

  const closes = useMemo(() => view.map((c) => c.close), [view]);
  const precision = autoDigits(closes[closes.length - 1]);

  const prepared = useMemo<PreparedIndicator[]>(() => {
    let pane = 0;
    return settings.indicators.map((ind) => {
      const overlay = ind.kind === "sma" || ind.kind === "ema" || ind.kind === "bb";
      if (!overlay) pane += 1;
      const times = view.map((c) => c.t);
      const toPoints = (values: (number | null)[]): Point[] =>
        values.map((v, i) => (v === null ? { time: times[i]! } : { time: times[i]!, value: v }));
      const label = indicatorLabel(ind);
      const base = { pane, color: ind.color, visible: ind.visible, id: ind.id, label, extra: [] as PreparedIndicator["extra"] };

      if (ind.kind === "sma" || ind.kind === "ema") {
        const values = ind.kind === "sma" ? sma(closes, ind.period) : ema(closes, ind.period);
        return {
          ...base,
          legend: values,
          series: [{ key: `${ind.id}-main`, type: "line", pane, color: ind.color, dashed: false, data: toPoints(values) }],
        };
      }
      if (ind.kind === "bb") {
        const { upper, middle, lower } = bollinger(closes, ind.period, ind.mult);
        return {
          ...base,
          legend: middle,
          series: [
            { key: `${ind.id}-u`, type: "line", pane, color: ind.color, dashed: false, data: toPoints(upper) },
            { key: `${ind.id}-m`, type: "line", pane, color: withAlpha(ind.color, 0.7), dashed: true, data: toPoints(middle) },
            { key: `${ind.id}-l`, type: "line", pane, color: ind.color, dashed: false, data: toPoints(lower) },
          ],
        };
      }
      if (ind.kind === "rsi") {
        const values = rsi(closes, ind.period);
        return {
          ...base,
          legend: values,
          series: [{ key: `${ind.id}-main`, type: "line", pane, color: ind.color, dashed: false, data: toPoints(values) }],
        };
      }
      const { line, signal, hist } = macd(closes, ind.fast, ind.slow, ind.signal);
      const bars: Bar[] = hist.map((v, i) =>
        v === null
          ? { time: times[i]! }
          : { time: times[i]!, value: v, color: withAlpha(v >= 0 ? palette.up : palette.down, 0.65) },
      );
      return {
        ...base,
        legend: line,
        extra: [
          { label: "Tín hiệu", color: palette.warn, values: signal },
          { label: "Hist", color: palette.dim, values: hist },
        ],
        series: [
          { key: `${ind.id}-hist`, type: "histogram", pane, color: palette.dim, dashed: false, data: bars },
          { key: `${ind.id}-macd`, type: "line", pane, color: ind.color, dashed: false, data: toPoints(line) },
          { key: `${ind.id}-signal`, type: "line", pane, color: palette.warn, dashed: false, data: toPoints(signal) },
        ],
      };
    });
  }, [closes, view, settings.indicators, palette.up, palette.down, palette.dim, palette.warn]);

  const structureKey = useMemo(
    () => [
      settings.chartType,
      settings.volume ? "v" : "-",
      ...settings.indicators.map((i) => `${i.id}:${i.kind}:${i.period}:${i.mult}:${i.fast}:${i.slow}:${i.signal}`),
    ].join("|"),
    [settings.chartType, settings.volume, settings.indicators],
  );

  // Con trỏ chuột và lớp vẽ đọc giá trị mới qua ref để vòng lặp không phải tạo lại.
  const live = useRef({
    view, prepared, palette, tool, drawColor, locked, hidden, shapes, selectedId, offset, stepSeconds,
    magnet: settings.magnet, grid: settings.grid, logScale: settings.logScale, onHover,
  });
  live.current = {
    view, prepared, palette, tool, drawColor, locked, hidden, shapes, selectedId, offset, stepSeconds,
    magnet: settings.magnet, grid: settings.grid, logScale: settings.logScale, onHover,
  };

  const bump = useCallback(() => {
    versionRef.current += 1;
  }, []);

  const projector = useCallback((): Projector | null => {
    const chart = chartRef.current;
    const main = mainRef.current;
    const holder = holderRef.current;
    const data = live.current.view;
    if (!chart || !main || !holder || data.length === 0) return null;
    const scale = chart.timeScale();
    const first = data[0]!.t as number;
    const step = live.current.stepSeconds;
    const shift = live.current.offset;
    const panes = chart.panes();
    const width = Math.max(0, holder.clientWidth - chart.priceScale("right").width());
    const height = panes[0]?.getHeight() ?? holder.clientHeight;
    return {
      width,
      height,
      step,
      x: (timeUtc) => scale.logicalToCoordinate(((timeUtc + shift - first) / step) as Logical),
      y: (price) => main.priceToCoordinate(price),
      time: (x) => {
        const logical = scale.coordinateToLogical(x);
        return logical === null ? null : first + logical * step - shift;
      },
      price: (y) => main.coordinateToPrice(y),
    };
  }, []);

  const anchorAt = useCallback((proj: Projector, x: number, y: number): Anchor | null => {
    const time = proj.time(x);
    const price = proj.price(y);
    if (time === null || price === null) return null;
    if (!live.current.magnet) return { time, price };
    const data = live.current.view;
    const head = data[0];
    if (!head) return { time, price };
    const first = head.t as number;
    const idx = Math.round((time + live.current.offset - first) / live.current.stepSeconds);
    const bar = data[Math.min(data.length - 1, Math.max(0, idx))];
    if (!bar) return { time, price };
    const options = [bar.open, bar.high, bar.low, bar.close];
    const snapped = options.reduce((best, v) => (Math.abs(v - price) < Math.abs(best - price) ? v : best), options[0]!);
    return { time: (bar.t as number) - live.current.offset, price: snapped };
  }, []);

  /* ---------- vòng đời chart ---------- */
  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    const state = live.current;
    const chart = createChart(el, chartOptions(state.palette, {
      grid: state.grid,
      logScale: state.logScale,
      magnet: state.magnet,
    }));
    chartRef.current = chart;

    let lastTime: number | null = null;
    chart.subscribeCrosshairMove((param) => {
      const time = typeof param.time === "number" ? param.time : null;
      if (time === lastTime) return;
      lastTime = time;
      const data = live.current.view;
      const head = data[0];
      const candle = time === null ? null : (lookupRef.current.get(time) ?? null);
      setHovered(candle);
      setHoverIndex(candle && head && time !== null
        ? Math.round((time - (head.t as number)) / live.current.stepSeconds)
        : null);
      live.current.onHover(candle);
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      mainRef.current = null;
      volumeRef.current = null;
      indicatorRef.current.clear();
      watermarkRef.current = null;
      structureRef.current = "";
      identityRef.current = "";
    };
    // Chart chỉ tạo một lần; mọi thay đổi khác đi qua applyOptions.
  }, []);

  /* ---------- tuỳ chọn giao diện ---------- */
  useEffect(() => {
    chartRef.current?.applyOptions(chartOptions(palette, {
      grid: settings.grid,
      logScale: settings.logScale,
      magnet: settings.magnet,
    }));
    bump();
  }, [palette, settings.grid, settings.logScale, settings.magnet, bump]);

  /* ---------- dựng series + nạp dữ liệu ---------- */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (view.length === 0) {
      mainRef.current?.setData([]);
      volumeRef.current?.setData([]);
      for (const list of indicatorRef.current.values()) {
        for (const series of list) series.setData([]);
      }
      lookupRef.current.clear();
      return;
    }

    const mainOptions = {
      priceFormat: { type: "price" as const, precision, minMove: 1 / 10 ** precision },
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineColor: palette.dim,
      priceLineStyle: LineStyle.Dashed,
      priceLineWidth: 1 as const,
    };

    if (structureRef.current !== structureKey) {
      for (const list of indicatorRef.current.values()) {
        for (const series of list) chart.removeSeries(series);
      }
      indicatorRef.current.clear();
      if (mainRef.current) chart.removeSeries(mainRef.current);
      if (volumeRef.current) chart.removeSeries(volumeRef.current);
      mainRef.current = null;
      volumeRef.current = null;

      switch (settings.chartType) {
        case "bars":
          mainRef.current = chart.addSeries(BarSeries, { ...mainOptions, upColor, downColor, openVisible: true, thinBars: true });
          break;
        case "line":
          mainRef.current = chart.addSeries(LineSeries, { ...mainOptions, color: palette.accent, lineWidth: 2 });
          break;
        case "area":
          mainRef.current = chart.addSeries(AreaSeries, {
            ...mainOptions,
            lineColor: palette.accent,
            lineWidth: 2,
            topColor: withAlpha(palette.accent, 0.3),
            bottomColor: withAlpha(palette.accent, 0.02),
          });
          break;
        case "hollow":
          mainRef.current = chart.addSeries(CandlestickSeries, {
            ...mainOptions,
            upColor: "rgba(0,0,0,0)",
            downColor,
            borderVisible: true,
            borderUpColor: upColor,
            borderDownColor: downColor,
            wickUpColor: upColor,
            wickDownColor: downColor,
          });
          break;
        default:
          mainRef.current = chart.addSeries(CandlestickSeries, {
            ...mainOptions,
            upColor,
            downColor,
            borderVisible: false,
            wickUpColor: upColor,
            wickDownColor: downColor,
          });
      }

      if (settings.volume) {
        volumeRef.current = chart.addSeries(HistogramSeries, {
          priceFormat: { type: "volume" },
          priceScaleId: "ml-volume",
          lastValueVisible: false,
          priceLineVisible: false,
        });
        volumeRef.current.priceScale().applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
      }

      for (const ind of prepared) {
        const list: ISeriesApi<SeriesType>[] = [];
        for (const spec of ind.series) {
          if (spec.type === "histogram") {
            list.push(chart.addSeries(HistogramSeries, {
              color: spec.color,
              visible: ind.visible,
              lastValueVisible: false,
              priceLineVisible: false,
            }, spec.pane));
          } else {
            const series = chart.addSeries(LineSeries, {
              color: spec.color,
              lineWidth: 1,
              lineStyle: spec.dashed ? LineStyle.Dashed : LineStyle.Solid,
              visible: ind.visible,
              lastValueVisible: false,
              priceLineVisible: false,
              crosshairMarkerVisible: false,
            }, spec.pane);
            if (ind.label.startsWith("RSI")) {
              for (const level of [30, 70]) {
                series.createPriceLine({
                  price: level,
                  color: withAlpha(palette.dim, 0.5),
                  lineWidth: 1,
                  lineStyle: LineStyle.Dashed,
                  axisLabelVisible: true,
                  // title khác rỗng sẽ vẽ thêm nhãn trong pane, trùng với nhãn trên trục giá.
                  title: "",
                  axisLabelColor: palette.dim,
                });
              }
              series.applyOptions({
                autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
              });
            }
            list.push(series);
          }
        }
        indicatorRef.current.set(ind.id, list);
      }

      // setHeight chia lại phần chênh cho MỌI pane khác nên gọi lần lượt sẽ bóp pane đặt trước.
      // Stretch factor là tỉ lệ độc lập, giữ đúng bố cục dù thêm bao nhiêu pane.
      const applyHeights = () => {
        const panes: IPaneApi<Time>[] = chart.panes();
        panes[0]?.setStretchFactor(100);
        for (const ind of prepared) {
          if (ind.pane === 0) continue;
          panes[ind.pane]?.setStretchFactor(ind.label.startsWith("MACD") ? 34 : 30);
        }
      };
      applyHeights();
      structureRef.current = structureKey;
    }

    const main = mainRef.current;
    if (!main) return;

    if (settings.chartType === "line" || settings.chartType === "area") {
      main.applyOptions({ color: palette.accent, lineColor: palette.accent });
      main.setData(view.map((c) => ({ time: c.t, value: c.close })));
    } else {
      main.applyOptions({
        upColor: settings.chartType === "hollow" ? "rgba(0,0,0,0)" : upColor,
        downColor,
        borderUpColor: upColor,
        borderDownColor: downColor,
        wickUpColor: upColor,
        wickDownColor: downColor,
      });
      main.setData(view.map((c) => ({ time: c.t, open: c.open, high: c.high, low: c.low, close: c.close })));
    }

    volumeRef.current?.setData(
      view.map((c) => ({
        time: c.t,
        value: c.volume,
        color: withAlpha(c.close >= c.open ? upColor : downColor, 0.45),
      })),
    );

    for (const ind of prepared) {
      const list = indicatorRef.current.get(ind.id);
      if (!list) continue;
      ind.series.forEach((spec, i) => {
        const series = list[i];
        if (!series) return;
        series.applyOptions({ visible: ind.visible, color: spec.color });
        series.setData(spec.data);
      });
    }

    lookupRef.current = new Map(view.map((c) => [c.t as number, c]));

    const identity = `${symbol}|${timeframe}|${settings.chartType}|${settings.timezone}`;
    if (identityRef.current !== identity) {
      identityRef.current = identity;
      const to = view.length + 6;
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, to - 170), to });
      lengthRef.current = view.length;
    } else if (view.length > lengthRef.current) {
      // Nến mới nối thêm: chỉ kéo khung khi người dùng đang ở mép phải, đừng giật màn hình khi họ đang xem quá khứ.
      const scale = chart.timeScale();
      const range = scale.getVisibleLogicalRange();
      const shift = view.length - lengthRef.current;
      if (range && range.to >= lengthRef.current - 1) {
        scale.setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift });
      }
      lengthRef.current = view.length;
    } else {
      lengthRef.current = view.length;
    }
    bump();
  }, [view, prepared, structureKey, settings.chartType, settings.volume, settings.timezone, palette, precision, symbol, timeframe, upColor, downColor, bump]);

  /* ---------- watermark ---------- */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const panes = chart.panes();
    const pane = panes[0];
    if (!pane) return;
    const options = {
      visible: settings.watermark,
      horzAlign: "center" as const,
      vertAlign: "center" as const,
      lines: [
        { text: symbol, color: withAlpha(palette.text, 0.07), fontSize: 46, fontStyle: "bold" },
        { text: `${venue.toUpperCase()} · ${timeframe}`, color: withAlpha(palette.text, 0.06), fontSize: 17 },
      ],
    };
    if (watermarkRef.current) watermarkRef.current.applyOptions(options);
    else watermarkRef.current = createTextWatermark(pane, options);
  }, [symbol, venue, timeframe, palette, settings.watermark, structureKey]);

  /* ---------- lớp vẽ: vòng lặp dựng hình ---------- */
  useEffect(() => {
    let raf = 0;
    let signature = "";
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const canvas = canvasRef.current;
      const proj = projector();
      if (!canvas || !proj) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(proj.width));
      const h = Math.max(1, Math.round(proj.height));
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        signature = "";
      }
      const data = live.current.view;
      const last = data[data.length - 1];
      const next = [
        w, h, versionRef.current,
        last ? proj.x((last.t as number) - live.current.offset) : 0,
        last ? proj.y(last.close) : 0,
      ].join("|");
      if (next === signature) return;
      signature = next;
      const chart = chartRef.current;
      if (chart) {
        const base = canvas.getBoundingClientRect().top;
        const tops = chart.panes().map((p) => Math.round((p.getHTMLElement()?.getBoundingClientRect().top ?? base) - base));
        const key = tops.join(",");
        if (key !== paneKeyRef.current) {
          paneKeyRef.current = key;
          setPaneTops(tops);
        }
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderShapes(ctx, proj, {
        shapes: live.current.shapes,
        draft: draftRef.current,
        selectedId: live.current.selectedId,
        hoverId: hoverShapeRef.current,
        palette: live.current.palette,
        hidden: live.current.hidden,
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [projector]);

  useEffect(() => {
    bump();
  }, [shapes, selectedId, hidden, palette, bump]);

  /* ---------- lớp vẽ: chuột ---------- */
  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;

    const at = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const block = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const proj = projector();
      if (!proj) return;
      const { x, y } = at(e);
      if (x < 0 || y < 0 || x > proj.width || y > proj.height) return;
      const state = live.current;

      if (state.tool === "eraser") {
        const id = hitTest(state.shapes, proj, x, y);
        if (id) {
          onShapesChange(state.shapes.filter((s) => s.id !== id));
          onLog("Đã xoá một hình vẽ");
          block(e);
          bump();
        }
        return;
      }

      if (state.tool !== "cursor") {
        if (state.locked) return;
        const anchor = anchorAt(proj, x, y);
        if (!anchor) return;
        draftRef.current = { id: newShapeId(), kind: state.tool, a: anchor, b: anchor, color: state.drawColor };
        dragRef.current = { mode: "create" };
        block(e);
        bump();
        return;
      }

      const selected = state.shapes.find((s) => s.id === state.selectedId);
      if (selected && !state.locked) {
        const which = hitHandle(selected, proj, x, y);
        if (which) {
          dragRef.current = { mode: "handle", id: selected.id, which };
          block(e);
          return;
        }
      }
      const id = hitTest(state.shapes, proj, x, y);
      if (id) {
        onSelect(id);
        const shape = state.shapes.find((s) => s.id === id);
        const from = anchorAt(proj, x, y);
        if (shape && from && !state.locked) {
          dragRef.current = { mode: "move", id, from, original: shape };
        }
        block(e);
      } else if (state.selectedId) {
        onSelect(null);
      }
    };

    const onMove = (e: MouseEvent) => {
      const proj = projector();
      if (!proj) return;
      const { x, y } = at(e);
      const drag = dragRef.current;
      const state = live.current;

      if (drag) {
        const anchor = anchorAt(proj, x, y);
        if (!anchor) return;
        if (drag.mode === "create" && draftRef.current) {
          draftRef.current = { ...draftRef.current, b: anchor };
        } else if (drag.mode === "handle") {
          onShapesChange(state.shapes.map((s) => (s.id === drag.id ? { ...s, [drag.which]: anchor } : s)));
        } else if (drag.mode === "move") {
          const dt = anchor.time - drag.from.time;
          const dp = anchor.price - drag.from.price;
          onShapesChange(state.shapes.map((s) => (s.id === drag.id
            ? {
                ...s,
                a: { time: drag.original.a.time + dt, price: drag.original.a.price + dp },
                b: { time: drag.original.b.time + dt, price: drag.original.b.price + dp },
              }
            : s)));
        }
        block(e);
        bump();
        return;
      }

      const id = state.tool === "cursor" && !state.hidden ? hitTest(state.shapes, proj, x, y) : null;
      if (id !== hoverShapeRef.current) {
        hoverShapeRef.current = id;
        bump();
      }
      el.style.cursor = state.tool !== "cursor" ? "crosshair" : id ? "move" : "";
    };

    const onUp = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      if (drag.mode === "create" && draftRef.current) {
        const draft = draftRef.current;
        draftRef.current = null;
        const proj = projector();
        const moved = proj
          ? Math.hypot((proj.x(draft.b.time) ?? 0) - (proj.x(draft.a.time) ?? 0), (proj.y(draft.b.price) ?? 0) - (proj.y(draft.a.price) ?? 0))
          : 0;
        if (draft.kind === "hline" || moved > 4) {
          onShapesChange([...live.current.shapes, draft]);
          onSelect(draft.id);
          onLog(`Thêm ${draft.kind === "hline" ? "đường ngang" : draft.kind} tại ${fmtPrice(draft.a.price)}`);
        }
        onToolChange("cursor");
      }
      block(e);
      bump();
    };

    el.addEventListener("mousedown", onDown, true);
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    return () => {
      el.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
    };
  }, [projector, anchorAt, onShapesChange, onSelect, onToolChange, onLog, bump]);

  /* ---------- phím tắt riêng của lớp vẽ ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId && !locked) {
        e.preventDefault();
        onShapesChange(shapes.filter((s) => s.id !== selectedId));
        onSelect(null);
        onLog("Đã xoá hình vẽ đang chọn");
      }
      if (e.key === "Escape" && draftRef.current) {
        draftRef.current = null;
        dragRef.current = null;
        bump();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, shapes, locked, onShapesChange, onSelect, onLog, bump]);

  useImperativeHandle(ref, () => ({
    screenshot: () => {
      const base = chartRef.current?.takeScreenshot() ?? null;
      const overlay = canvasRef.current;
      const holder = holderRef.current;
      if (!base || !overlay || !holder || holder.clientWidth === 0) return base;
      const out = document.createElement("canvas");
      out.width = base.width;
      out.height = base.height;
      const ctx = out.getContext("2d");
      if (!ctx) return base;
      ctx.drawImage(base, 0, 0);
      // takeScreenshot chỉ chụp canvas của chart; ghép thêm lớp vẽ theo đúng tỉ lệ ảnh.
      const scale = base.width / holder.clientWidth;
      ctx.drawImage(overlay, 0, 0, overlay.width, overlay.height, 0, 0, overlay.clientWidth * scale, overlay.clientHeight * scale);
      return out;
    },
    fitAll: () => chartRef.current?.timeScale().fitContent(),
    scrollToLatest: () => chartRef.current?.timeScale().scrollToRealTime(),
    zoom: (factor: number) => {
      const chart = chartRef.current;
      if (!chart) return;
      const scale = chart.timeScale();
      const range = scale.getVisibleLogicalRange();
      if (!range) return;
      const mid = (range.from + range.to) / 2;
      const half = ((range.to - range.from) / 2) * factor;
      scale.setVisibleLogicalRange({ from: mid - half, to: mid + half });
    },
  }), []);

  const shown = hovered ?? view[view.length - 1] ?? null;
  const shownIndex = hoverIndex ?? (view.length > 0 ? view.length - 1 : null);
  const shownIsForming = forming && shownIndex === view.length - 1;
  const change = shown && shown.open !== 0 ? shown.close / shown.open - 1 : null;
  const digits = precision;
  const money = (v: number | null | undefined) =>
    v === null || v === undefined ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

  return (
    <div className="relative min-h-0 flex-1 bg-bg">
      <div ref={holderRef} className="absolute inset-0" />
      {/* Canvas của chart là layer compositor riêng, đè lên sibling z-index:auto — lớp vẽ phải có z-index thật. */}
      <canvas ref={canvasRef} className="pointer-events-none absolute left-0 top-0 z-[5]" />

      {/* Chú giải nổi trên chart, chỉ các nút mới nhận chuột */}
      <div className="pointer-events-none absolute left-2 top-1.5 z-10 flex max-w-[calc(100%-90px)] flex-col gap-0.5 text-[11px]">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[12px] font-semibold text-ink">{symbol}</span>
          <span className="text-dim">·</span>
          <span className="text-dim">{timeframe}</span>
          <span className="text-dim">·</span>
          <span className="uppercase text-dim">{venue}</span>
          <span
            className={
              "flex items-center gap-1 rounded-card border px-1 text-[10px] " +
              (shownIsForming ? "border-up/40 text-up" : "border-line text-faint")
            }
          >
            {shownIsForming && <span className="ml-pulse h-1 w-1 rounded-pill bg-up" />}
            {shownIsForming ? "nến đang chạy" : "nến đã đóng"}
          </span>
        </div>
        {shown && (
          <div className="tnum flex flex-wrap items-center gap-x-2 text-dim">
            <span>O <span className={shown.close >= shown.open ? "text-up" : "text-down"}>{money(shown.open)}</span></span>
            <span>H <span className={shown.close >= shown.open ? "text-up" : "text-down"}>{money(shown.high)}</span></span>
            <span>L <span className={shown.close >= shown.open ? "text-up" : "text-down"}>{money(shown.low)}</span></span>
            <span>C <span className={shown.close >= shown.open ? "text-up" : "text-down"}>{money(shown.close)}</span></span>
            <span className={shown.close >= shown.open ? "text-up" : "text-down"}>
              {change === null ? "" : `${change >= 0 ? "+" : ""}${(change * 100).toFixed(2)}%`}
            </span>
            <span className="text-faint">Vol {fmtCompact(shown.volume)}</span>
          </div>
        )}
        {prepared.filter((ind) => ind.pane === 0).map((ind) => (
          <LegendLine
            key={ind.id}
            label={ind.label}
            color={ind.color}
            visible={ind.visible}
            value={money(shownIndex === null ? null : ind.legend[shownIndex])}
            onToggle={() => onToggleIndicator(ind.id)}
            onRemove={() => onRemoveIndicator(ind.id)}
          />
        ))}
        {shown && (
          <span className="text-[10px] text-faint">{formatCrosshairTime(Math.floor(Date.parse(shown.ts) / 1000) + offset)}</span>
        )}
      </div>

      {/* Chú giải riêng cho từng pane chỉ báo, đặt đúng mép trên pane đó */}
      {prepared.filter((ind) => ind.pane > 0).map((ind) => {
        const top = paneTops[ind.pane];
        if (top === undefined) return null;
        return (
          <div
            key={ind.id}
            className="pointer-events-none absolute left-2 z-10 flex max-w-[calc(100%-90px)] flex-wrap items-center gap-x-2.5 text-[11px]"
            style={{ top: top + 4 }}
          >
            <LegendLine
              label={ind.label}
              color={ind.color}
              visible={ind.visible}
              value={money(shownIndex === null ? null : ind.legend[shownIndex])}
              onToggle={() => onToggleIndicator(ind.id)}
              onRemove={() => onRemoveIndicator(ind.id)}
            />
            {ind.extra.map((part) => {
              const value = shownIndex === null ? null : part.values[shownIndex];
              return (
                <span key={part.label} className="tnum" style={{ color: ind.visible ? part.color : "var(--c-faint)" }}>
                  {part.label} {money(value)}
                </span>
              );
            })}
          </div>
        );
      })}

      {/* Thanh điều hướng nổi, nép sang trái trục giá để không che chữ số */}
      <div className="absolute bottom-7 right-[78px] z-10 flex items-center gap-0.5 rounded-card border border-line bg-panel/90 px-1 py-0.5">
        <ToolButton
          icon="chevronLeft"
          label="Xem thêm nến cũ"
          onClick={() => chartRef.current?.timeScale().scrollToPosition(-5, false)}
        />
        <ToolButton
          icon="refresh"
          label="Về nến mới nhất"
          onClick={() => {
            const chart = chartRef.current;
            if (!chart) return;
            const to = live.current.view.length + 6;
            chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, to - 170), to });
          }}
        />
        <ToolButton
          icon="expand"
          label="Xem toàn bộ dữ liệu"
          onClick={() => chartRef.current?.timeScale().fitContent()}
        />
      </div>

      {loading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-bg/70">
          <span className="flex items-center gap-2 text-[12px] text-dim">
            <Icon name="refresh" className="ml-pulse" /> đang tải nến…
          </span>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-bg/85 p-6">
          <div className="max-w-[420px] rounded-card border border-down/50 bg-panel p-4">
            <p className="mb-1 flex items-center gap-2 text-[12px] font-semibold text-down">
              <Icon name="alert" /> Không tải được dữ liệu
            </p>
            <p className="text-[11px] leading-relaxed text-dim">{error}</p>
          </div>
        </div>
      )}
      {!loading && !error && view.length === 0 && (
        <div className="absolute inset-0 z-20 flex items-center justify-center">
          <p className="text-[12px] text-dim">Chưa có nến cho {symbol} {timeframe}</p>
        </div>
      )}
    </div>
  );
});

export default ChartPane;