import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  TIMEFRAMES,
  TIMEFRAME_SECONDS,
  addSymbol,
  fetchCandles,
  fetchHealth,
  fetchSummary,
  fetchWatchlist,
  removeSymbol,
  triggerIngest,
  type Candle,
  type Timeframe,
} from "./api";
import BottomPanel, { type LogEntry } from "./components/BottomPanel";
import ChartPane, { type ChartHandle } from "./components/ChartPane";
import { IndicatorsDialog, SettingsDialog, ShortcutsDialog } from "./components/Dialogs";
import DrawingRail from "./components/DrawingRail";
import Overview from "./components/Overview";
import Portfolio from "./components/Portfolio";
import RightPanel from "./components/RightPanel";
import StatusBar from "./components/StatusBar";
import SymbolSearch from "./components/SymbolSearch";
import Toasts, { type Toast } from "./components/Toasts";
import TopBar from "./components/TopBar";
import { loadAllShapes, saveAllShapes, type Shape, type ToolId } from "./drawings";
import type { Indicator } from "./indicators";
import { liveKey, useLiveStream } from "./live";
import { useSettings, type ChartType } from "./store";
import { applyTheme, readPalette } from "./theme";

const TOOL_KEYS: Record<string, ToolId> = {
  v: "cursor", t: "trend", r: "ray", h: "hline", b: "rect", f: "fib", m: "measure", e: "eraser",
};

function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => setWide(mq.matches);
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return wide;
}

function loadLimit(): number {
  const raw = Number(localStorage.getItem("ml.limit"));
  return [90, 250, 500, 1000].includes(raw) ? raw : 500;
}

export default function App() {
  const client = useQueryClient();
  const { settings, update, patch, reset } = useSettings();
  const wide = useWide();

  const [symbol, setSymbol] = useState("BTC/USDT");
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [limit, setLimit] = useState(loadLimit);
  const [fullscreen, setFullscreen] = useState(false);
  const [rightDrawer, setRightDrawer] = useState(false);
  const [view, setView] = useState<"overview" | "terminal" | "portfolio">("overview");

  const [tool, setTool] = useState<ToolId>("cursor");
  const [drawColor, setDrawColor] = useState("#2962ff");
  const [locked, setLocked] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [allShapes, setAllShapes] = useState<Record<string, Shape[]>>(loadAllShapes);
  const [hovered, setHovered] = useState<Candle | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [indicatorsOpen, setIndicatorsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const [log, setLog] = useState<LogEntry[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [lastIngest, setLastIngest] = useState<string | null>(null);

  const chartRef = useRef<ChartHandle>(null);
  const seq = useRef(0);

  // Áp theme ngay trong memo: readPalette đọc biến CSS nên phải thấy theme mới, không phải theme cũ.
  const palette = useMemo(() => {
    applyTheme(settings.theme);
    return readPalette();
  }, [settings.theme]);

  const drawingKey = `${symbol}|${timeframe}`;
  const shapes = allShapes[drawingKey] ?? [];

  useEffect(() => {
    saveAllShapes(allShapes);
  }, [allShapes]);

  useEffect(() => {
    setSelectedId(null);
  }, [drawingKey]);

  useEffect(() => {
    localStorage.setItem("ml.limit", String(limit));
  }, [limit]);

  const pushLog = useCallback((text: string, tone: LogEntry["tone"] = "info") => {
    seq.current += 1;
    const entry: LogEntry = { id: seq.current, at: new Date().toISOString().slice(11, 19), text, tone };
    setLog((prev) => [...prev.slice(-199), entry]);
  }, []);

  const pushToast = useCallback((text: string, tone: Toast["tone"] = "info", action?: Toast["action"]) => {
    seq.current += 1;
    const toast: Toast = { id: seq.current, text, tone, action };
    setToasts((prev) => [...prev.slice(-3), toast]);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  /* ---------- dữ liệu ---------- */
  const watchlist = useQuery({
    queryKey: ["watchlist"],
    queryFn: ({ signal }) => fetchWatchlist(signal),
    staleTime: 15_000,
  });
  const candles = useQuery({
    queryKey: ["candles", symbol, timeframe, limit],
    queryFn: ({ signal }) => fetchCandles(symbol, timeframe, limit, signal),
  });
  const summary = useQuery({
    queryKey: ["summary", symbol, timeframe, limit],
    queryFn: ({ signal }) => fetchSummary(symbol, timeframe, limit, signal),
  });
  const health = useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => fetchHealth(signal),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const entries = watchlist.data ?? [];
  const sparkQueries = useQueries({
    queries: entries.map((e) => ({
      queryKey: ["spark", e.symbol, e.timeframe],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchCandles(e.symbol, e.timeframe, 60, signal),
      staleTime: 60_000,
    })),
  });
  const sparks = useMemo(() => {
    const out: Record<string, number[]> = {};
    entries.forEach((e, i) => {
      const data = sparkQueries[i]?.data;
      if (data) out[e.symbol] = data.candles.map((c) => c.close);
    });
    return out;
  }, [entries, sparkQueries]);

  useEffect(() => {
    const list = watchlist.data;
    if (!list || list.length === 0) return;
    if (list.some((e) => e.symbol === symbol)) return;
    const first = list[0];
    if (first) setSymbol(first.symbol);
  }, [watchlist.data, symbol]);

  const rows = candles.data?.candles ?? [];
  const last = rows.length > 0 ? rows[rows.length - 1] : undefined;
  const selectedEntry = entries.find((e) => e.symbol === symbol);
  const venue = selectedEntry?.venue ?? "binance";

  /* ---------- realtime: nến đang chạy từ hub backend, kho vẫn chỉ nến đã đóng ---------- */
  const onLiveClosed = useCallback((symbols: string[]) => {
    void client.invalidateQueries({ queryKey: ["candles"] });
    void client.invalidateQueries({ queryKey: ["summary"] });
    void client.invalidateQueries({ queryKey: ["watchlist"] });
    void client.invalidateQueries({ queryKey: ["spark"] });
    pushLog(`Nến đóng mới từ luồng trực tiếp: ${symbols.join(", ")}`, "ok");
  }, [client, pushLog]);

  const live = useLiveStream(settings.live, onLiveClosed);
  const activeBar = live.bars[liveKey(symbol, timeframe)];

  const chartRows = useMemo(() => {
    const closed = candles.data?.candles ?? [];
    const lastClosed = closed[closed.length - 1];
    if (!activeBar || !lastClosed) return closed;
    const t = Date.parse(activeBar.ts);
    const lastT = Date.parse(lastClosed.ts);
    if (t < lastT) return closed;
    if (t === lastT) return [...closed.slice(0, -1), activeBar];
    return [...closed, activeBar];
  }, [candles.data, activeBar]);

  const forming = Boolean(
    activeBar && !activeBar.closed && chartRows[chartRows.length - 1]?.ts === activeBar.ts,
  );
  const livePrice = activeBar?.close ?? null;
  const livePrices = useMemo(() => {
    const out: Record<string, number> = {};
    for (const e of entries) {
      const bar = live.bars[liveKey(e.symbol, e.timeframe)];
      if (bar) out[e.symbol] = bar.close;
    }
    return out;
  }, [entries, live.bars]);

  /* ---------- thao tác ghi ---------- */
  const ingest = useMutation({
    mutationFn: () => triggerIngest(),
    onSuccess: (result) => {
      void client.invalidateQueries();
      const parts = Object.entries(result).map(([s, n]) => `${s}: ${n}`);
      setLastIngest(`${new Date().toISOString().slice(11, 19)} UTC`);
      pushLog(`Nạp xong — ${parts.join(" · ")}`, "ok");
      pushToast(`Đã nạp ${parts.length} symbol từ Binance.`, "ok");
    },
    onError: (error: Error) => {
      pushLog(`Nạp dữ liệu thất bại: ${error.message}`, "error");
      pushToast(`Không nạp được dữ liệu: ${error.message}`, "error");
    },
  });

  const runIngest = useCallback(() => {
    if (ingest.isPending) return;
    pushLog("Bắt đầu nạp lại toàn bộ watchlist từ Binance");
    ingest.mutate();
  }, [ingest, pushLog]);

  const add = useMutation({
    mutationFn: ({ symbol: next, label }: { symbol: string; label: string }) => addSymbol(next, label),
    onMutate: ({ symbol: next }) => {
      setAdding(next);
      setAddError(null);
    },
    onSuccess: async (data, variables) => {
      // Đợi watchlist nạp lại rồi mới đổi symbol: effect tự chọn symbol đầu danh sách sẽ kéo về
      // symbol cũ nếu đổi lúc danh sách chưa có symbol vừa thêm.
      await client.invalidateQueries();
      setAdding(null);
      setSymbol(variables.symbol);
      setSearchOpen(false);
      pushLog(`Thêm ${variables.symbol} — nạp ${data.written} nến 1h`, "ok");
      pushToast(`${variables.symbol} đã vào danh sách (${data.written} nến).`, "ok");
    },
    onError: (error: Error, variables) => {
      setAdding(null);
      setAddError(`${variables.symbol}: ${error.message}`);
      pushLog(`Không thêm được ${variables.symbol}: ${error.message}`, "error");
    },
  });

  const remove = useMutation({
    mutationFn: (target: string) => removeSymbol(target),
    onSuccess: (data, target) => {
      const label = entries.find((e) => e.symbol === target)?.label ?? null;
      void client.invalidateQueries({ queryKey: ["watchlist"] });
      pushLog(`Bỏ ${data.removed} khỏi danh sách theo dõi`);
      pushToast(`Đã bỏ ${data.removed}. Nến đã nạp vẫn còn trong kho.`, "info", {
        label: "Hoàn tác",
        run: () => {
          addSymbol(data.removed, label ?? undefined)
            .then(() => client.invalidateQueries({ queryKey: ["watchlist"] }))
            .then(() => pushLog(`Đã đưa ${data.removed} trở lại danh sách`, "ok"))
            .catch((error: Error) => pushToast(`Không khôi phục được: ${error.message}`, "error"));
        },
      });
    },
    onError: (error: Error) => pushToast(`Không bỏ được symbol: ${error.message}`, "error"),
  });

  const onAdd = useCallback((next: string, label: string) => {
    if (adding) return;
    add.mutate({ symbol: next, label });
  }, [add, adding]);

  const onRemove = useCallback((target: string) => {
    if (remove.isPending) return;
    remove.mutate(target);
  }, [remove]);

  /* ---------- chart ---------- */
  const onHover = useCallback((candle: Candle | null) => setHovered(candle), []);
  const onSelectShape = useCallback((id: string | null) => setSelectedId(id), []);
  const onToolChange = useCallback((next: ToolId) => setTool(next), []);
  const onShapesChange = useCallback((next: Shape[]) => {
    setAllShapes((prev) => ({ ...prev, [drawingKey]: next }));
  }, [drawingKey]);

  const setIndicators = useCallback((next: Indicator[]) => {
    update("indicators", next);
  }, [update]);

  const onToggleIndicator = useCallback((id: string) => {
    setIndicators(settings.indicators.map((i) => (i.id === id ? { ...i, visible: !i.visible } : i)));
  }, [settings.indicators, setIndicators]);

  const onRemoveIndicator = useCallback((id: string) => {
    const gone = settings.indicators.find((i) => i.id === id);
    setIndicators(settings.indicators.filter((i) => i.id !== id));
    if (gone) pushLog(`Bỏ chỉ báo ${gone.kind.toUpperCase()}`);
  }, [settings.indicators, setIndicators, pushLog]);

  const clearShapes = useCallback(() => {
    if (shapes.length === 0) return;
    const before = shapes;
    setAllShapes((prev) => ({ ...prev, [drawingKey]: [] }));
    setSelectedId(null);
    pushLog(`Xoá ${before.length} hình vẽ của ${symbol} ${timeframe}`);
    pushToast(`Đã xoá ${before.length} hình vẽ.`, "info", {
      label: "Hoàn tác",
      run: () => setAllShapes((prev) => ({ ...prev, [drawingKey]: before })),
    });
  }, [shapes, drawingKey, symbol, timeframe, pushLog, pushToast]);

  const snapshot = useCallback(() => {
    const canvas = chartRef.current?.screenshot();
    if (!canvas) {
      pushToast("Chart chưa sẵn sàng để chụp.", "error");
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${symbol.replace("/", "-")}-${timeframe}.png`;
      a.click();
      // Thu hồi ngay sẽ cắt kết nối blob trước khi trình duyệt kịp đọc, sinh ERR_FILE_NOT_FOUND.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      pushLog(`Xuất ảnh chart ${symbol} ${timeframe}`, "ok");
    }, "image/png");
  }, [symbol, timeframe, pushLog, pushToast]);

  const onTimeframe = useCallback((tf: Timeframe) => setTimeframe(tf), []);
  const onChartType = useCallback((t: ChartType) => update("chartType", t), [update]);
  const onSelectSymbol = useCallback((next: string) => setSymbol(next), []);
  const onOpenSymbol = useCallback((next: string, tf?: Timeframe) => {
    setSymbol(next);
    if (tf) setTimeframe(tf);
    setView("terminal");
  }, []);
  const onView = useCallback((v: "overview" | "terminal" | "portfolio") => setView(v), []);
  const toggleRight = useCallback(() => {
    if (wide) update("rightPanel", !settings.rightPanel);
    else setRightDrawer((v) => !v);
  }, [wide, update, settings.rightPanel]);

  /* ---------- phím tắt ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === "k") {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (e.ctrlKey || e.metaKey) return;
      if (e.altKey) {
        const next = TOOL_KEYS[key];
        if (next) {
          e.preventDefault();
          setTool(next);
        }
        return;
      }
      if (key === "o") {
        setView("overview");
      } else if (key === "c") {
        setView("terminal");
      } else if (key === "p") {
        setView("portfolio");
      } else if (e.key === "/") {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      } else if (key === "i") {
        setIndicatorsOpen((v) => !v);
      } else if (key === "s") {
        setSettingsOpen((v) => !v);
      } else if (key === "f") {
        setFullscreen((v) => !v);
      } else if (key === "1" || key === "2" || key === "3") {
        const tf = TIMEFRAMES[Number(key) - 1];
        if (tf) setTimeframe(tf);
      } else if (e.key === "Escape") {
        setSearchOpen(false);
        setIndicatorsOpen(false);
        setSettingsOpen(false);
        setShortcutsOpen(false);
        setRightDrawer(false);
        setTool("cursor");
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const showRight = !fullscreen && (wide ? settings.rightPanel : rightDrawer);
  const showBottom = settings.bottomPanel && !fullscreen;
  const candleError = candles.isError ? (candles.error as Error).message : null;

  const rightPanel = showRight ? (
    <RightPanel
      entries={entries}
      selected={symbol}
      sparks={sparks}
      hovered={hovered}
      last={chartRows[chartRows.length - 1]}
      candles={chartRows}
      summary={summary.data}
      timeframe={timeframe}
      venue={venue}
      livePrice={livePrice}
      livePrices={livePrices}
      liveState={live.state}
      forming={forming}
      onSelect={(next) => {
        setSymbol(next);
        if (!wide) setRightDrawer(false);
      }}
      onRemove={onRemove}
      onOpenSearch={() => setSearchOpen(true)}
    />
  ) : null;

  return (
    <div className="flex h-full flex-col bg-bg text-ink">
      <TopBar
        symbol={symbol}
        venue={venue}
        timeframe={timeframe}
        settings={settings}
        ingesting={ingest.isPending}
        fullscreen={fullscreen}
        view={view}
        onView={onView}
        onTimeframe={onTimeframe}
        onChartType={onChartType}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenIndicators={() => setIndicatorsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onSnapshot={snapshot}
        onIngest={runIngest}
        onToggleTheme={() => update("theme", settings.theme === "dark" ? "light" : "dark")}
        onToggleFullscreen={() => setFullscreen((v) => !v)}
        onToggleRight={toggleRight}
        onToggleBottom={() => update("bottomPanel", !settings.bottomPanel)}
      />

      <div className="relative flex min-h-0 flex-1">
        {view === "overview" ? (
          <Overview
            entries={entries}
            livePrices={livePrices}
            liveState={live.state}
            health={health.data}
            palette={palette}
            ingesting={ingest.isPending}
            onOpenSymbol={onOpenSymbol}
            onRemove={onRemove}
            onOpenSearch={() => setSearchOpen(true)}
            onIngest={runIngest}
            onToggleLive={() => update("live", !settings.live)}
            liveEnabled={settings.live}
          />
        ) : view === "portfolio" ? (
          <Portfolio
            entries={entries}
            livePrices={livePrices}
            liveState={live.state}
            palette={palette}
            onToast={pushToast}
            onLog={pushLog}
            onToggleLive={() => update("live", !settings.live)}
            liveEnabled={settings.live}
            onOpenSymbol={onOpenSymbol}
          />
        ) : (
          <>
        <DrawingRail
          tool={tool}
          locked={locked}
          hidden={hidden}
          magnet={settings.magnet}
          shapeCount={shapes.length}
          drawColor={drawColor}
          onToolChange={onToolChange}
          onToggleLock={() => setLocked((v) => !v)}
          onToggleHidden={() => setHidden((v) => !v)}
          onToggleMagnet={() => update("magnet", !settings.magnet)}
          onColorChange={setDrawColor}
          onClear={clearShapes}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <ChartPane
            ref={chartRef}
            symbol={symbol}
            venue={venue}
            timeframe={timeframe}
            stepSeconds={TIMEFRAME_SECONDS[timeframe] ?? 3600}
            candles={chartRows}
            forming={forming}
            settings={settings}
            palette={palette}
            tool={tool}
            drawColor={drawColor}
            locked={locked}
            hidden={hidden}
            shapes={shapes}
            selectedId={selectedId}
            loading={candles.isPending}
            error={candleError}
            onToolChange={onToolChange}
            onShapesChange={onShapesChange}
            onSelect={onSelectShape}
            onHover={onHover}
            onLog={pushLog}
            onToggleIndicator={onToggleIndicator}
            onRemoveIndicator={onRemoveIndicator}
          />
          {showBottom && (
            <BottomPanel
              tab={settings.bottomTab}
              height={settings.bottomHeight}
              candles={rows}
              summary={summary.data}
              log={log}
              symbol={symbol}
              timeframe={timeframe}
              venue={venue}
              loading={candles.isPending}
              ingesting={ingest.isPending}
              lastIngest={lastIngest}
              onTab={(tab) => update("bottomTab", tab)}
              onHeight={(h) => update("bottomHeight", h)}
              onCollapse={() => update("bottomPanel", false)}
              onIngest={runIngest}
            />
          )}
        </main>

        {wide && rightPanel}

        {!wide && rightPanel && (
          <>
            <div className="absolute inset-0 z-40 bg-black/50" onClick={() => setRightDrawer(false)} aria-hidden="true" />
            <div className="absolute inset-y-0 right-0 z-50 flex max-w-full">{rightPanel}</div>
          </>
        )}
          </>
        )}
      </div>

      <StatusBar
        health={health.data}
        healthError={health.isError}
        symbol={symbol}
        timeframe={timeframe}
        loaded={chartRows.length}
        lastTs={last?.ts ?? null}
        shapeCount={shapes.length}
        timezone={settings.timezone}
        liveState={live.state}
        logScale={settings.logScale}
        grid={settings.grid}
        onTimezone={() => update("timezone", settings.timezone === "utc" ? "local" : "utc")}
        onLive={() => update("live", !settings.live)}
        onLogScale={() => update("logScale", !settings.logScale)}
        onGrid={() => update("grid", !settings.grid)}
        onZoom={(factor) => chartRef.current?.zoom(factor)}
        onFit={() => chartRef.current?.fitAll()}
      />

      <SymbolSearch
        open={searchOpen}
        entries={entries}
        selected={symbol}
        adding={adding}
        error={addError}
        onClose={() => setSearchOpen(false)}
        onSelect={onSelectSymbol}
        onAdd={onAdd}
        onRemove={onRemove}
      />
      <IndicatorsDialog
        open={indicatorsOpen}
        indicators={settings.indicators}
        onClose={() => setIndicatorsOpen(false)}
        onChange={(next) => {
          setIndicators(next);
          pushLog(`Cập nhật danh sách chỉ báo: ${next.length} chỉ báo`);
        }}
      />
      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        limit={limit}
        paletteUp={palette.up}
        paletteDown={palette.down}
        onClose={() => setSettingsOpen(false)}
        onPatch={patch}
        onLimit={setLimit}
        onReset={() => {
          reset();
          pushLog("Đặt lại tuỳ chọn chart về mặc định");
        }}
      />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}