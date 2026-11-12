import { useState } from "react";
import { TIMEFRAMES, venueLabel, type Timeframe } from "../api";
import { CHART_TYPES, type ChartType, type Settings } from "../store";
import { Divider, Icon, MenuItem, Popover, ToolButton } from "./ui";

const CHART_ICON: Record<ChartType, string> = {
  candles: "candles",
  hollow: "hollow",
  heikin: "heikin",
  bars: "bars",
  line: "line",
  area: "area",
};

export default function TopBar({
  symbol,
  venue,
  timeframe,
  settings,
  ingesting,
  fullscreen,
  view,
  onView,
  onTimeframe,
  onChartType,
  onOpenSearch,
  onOpenIndicators,
  onOpenSettings,
  onOpenShortcuts,
  onSnapshot,
  onIngest,
  onToggleTheme,
  onToggleFullscreen,
  onToggleRight,
  onToggleBottom,
}: {
  symbol: string;
  venue: string;
  timeframe: Timeframe;
  settings: Settings;
  ingesting: boolean;
  fullscreen: boolean;
  view: "overview" | "terminal" | "portfolio" | "backtest";
  onView: (v: "overview" | "terminal" | "portfolio" | "backtest") => void;
  onTimeframe: (tf: Timeframe) => void;
  onChartType: (t: ChartType) => void;
  onOpenSearch: () => void;
  onOpenIndicators: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onSnapshot: () => void;
  onIngest: () => void;
  onToggleTheme: () => void;
  onToggleFullscreen: () => void;
  onToggleRight: () => void;
  onToggleBottom: () => void;
}) {
  const [typeOpen, setTypeOpen] = useState(false);

  return (
    <header className="z-40 flex min-h-11 shrink-0 flex-wrap items-center gap-1 border-b border-line bg-panel px-2 py-1">
      <span className="flex items-center gap-1.5 pr-1 text-[13px] font-semibold tracking-tight">
        <span className="flex h-5 w-5 items-center justify-center rounded-card bg-accent text-white">
          <Icon name="bolt" size={13} />
        </span>
        marketlab
      </span>

      <Divider vertical />

      <div className="flex items-center rounded-card border border-line" role="group" aria-label="Màn hình">
        <button
          type="button"
          onClick={() => onView("overview")}
          aria-pressed={view === "overview"}
          className={
            "flex h-7 items-center gap-1.5 rounded-card px-2 text-[12px] transition-colors " +
            (view === "overview" ? "bg-hover font-semibold text-accent" : "text-dim hover:bg-hover hover:text-ink")
          }
        >
          <Icon name="layers" size={14} />
          Tổng quan
        </button>
        <button
          type="button"
          onClick={() => onView("terminal")}
          aria-pressed={view === "terminal"}
          className={
            "flex h-7 items-center gap-1.5 rounded-card px-2 text-[12px] transition-colors " +
            (view === "terminal" ? "bg-hover font-semibold text-accent" : "text-dim hover:bg-hover hover:text-ink")
          }
        >
          <Icon name="candles" size={14} />
          Terminal
        </button>
        <button
          type="button"
          onClick={() => onView("portfolio")}
          aria-pressed={view === "portfolio"}
          className={
            "flex h-7 items-center gap-1.5 rounded-card px-2 text-[12px] transition-colors " +
            (view === "portfolio" ? "bg-hover font-semibold text-accent" : "text-dim hover:bg-hover hover:text-ink")
          }
        >
          <Icon name="wallet" size={14} />
          Tài sản
        </button>
        <button
          type="button"
          onClick={() => onView("backtest")}
          aria-pressed={view === "backtest"}
          className={
            "flex h-7 items-center gap-1.5 rounded-card px-2 text-[12px] transition-colors " +
            (view === "backtest" ? "bg-hover font-semibold text-accent" : "text-dim hover:bg-hover hover:text-ink")
          }
        >
          <Icon name="fx" size={14} />
          Backtest
        </button>
      </div>

      <Divider vertical />

      {view === "terminal" && (
      <>
      <button
        type="button"
        onClick={onOpenSearch}
        title="Đổi symbol (Ctrl+K)"
        className="flex h-7 items-center gap-1.5 rounded-card px-2 text-[13px] font-semibold hover:bg-hover"
      >
        <Icon name="search" size={15} className="text-dim" />
        {symbol}
        <span className="rounded-card border border-line px-1 text-[10px] font-normal uppercase text-faint">{venueLabel(venue)}</span>
      </button>

      <Divider vertical />

      <div className="flex items-center" role="group" aria-label="Khung thời gian">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf}
            type="button"
            onClick={() => onTimeframe(tf)}
            aria-pressed={tf === timeframe}
            className={
              "h-7 rounded-card px-2 text-[12px] transition-colors " +
              (tf === timeframe ? "bg-hover font-semibold text-accent" : "text-dim hover:bg-hover hover:text-ink")
            }
          >
            {tf}
          </button>
        ))}
      </div>

      <Divider vertical />

      <div className="relative">
        <button
          type="button"
          onClick={() => setTypeOpen((v) => !v)}
          title="Kiểu đồ thị"
          aria-haspopup="menu"
          aria-expanded={typeOpen}
          className="flex h-7 items-center gap-1 rounded-card px-1.5 text-dim hover:bg-hover hover:text-ink"
        >
          <Icon name={CHART_ICON[settings.chartType]} />
          <Icon name="chevronDown" size={12} />
        </button>
        <Popover open={typeOpen} onClose={() => setTypeOpen(false)} width={220}>
          {CHART_TYPES.map((t) => (
            <MenuItem
              key={t.id}
              icon={CHART_ICON[t.id]}
              label={t.label}
              hint={t.hint}
              active={t.id === settings.chartType}
              onClick={() => {
                onChartType(t.id);
                setTypeOpen(false);
              }}
            />
          ))}
        </Popover>
      </div>

      <button
        type="button"
        onClick={onOpenIndicators}
        title="Chỉ báo (I)"
        className="flex h-7 items-center gap-1.5 rounded-card px-2 text-[12px] text-dim hover:bg-hover hover:text-ink"
      >
        <Icon name="fx" />
        Chỉ báo
        <span className="tnum rounded-pill bg-hover px-1.5 text-[10px] text-dim">{settings.indicators.length}</span>
      </button>

      <ToolButton icon="camera" label="Chụp ảnh chart (PNG)" onClick={onSnapshot} />
      </>
      )}
      <ToolButton icon="gear" label="Tuỳ chọn chart (S)" onClick={onOpenSettings} />
      <ToolButton icon="keyboard" label="Phím tắt (?)" onClick={onOpenShortcuts} />

      <div className="ml-auto flex items-center gap-1">
        <ToolButton
          icon={settings.theme === "dark" ? "sun" : "moon"}
          label={settings.theme === "dark" ? "Chuyển nền sáng" : "Chuyển nền tối"}
          onClick={onToggleTheme}
        />
        {view === "terminal" && (
        <>
        <ToolButton
          icon="list"
          label="Bảng theo dõi bên phải"
          active={settings.rightPanel}
          onClick={onToggleRight}
        />
        <ToolButton
          icon="table"
          label="Bảng dữ liệu bên dưới"
          active={settings.bottomPanel}
          onClick={onToggleBottom}
        />
        <ToolButton
          icon={fullscreen ? "collapse" : "expand"}
          label={fullscreen ? "Thoát toàn màn hình chart (F)" : "Toàn màn hình chart (F)"}
          active={fullscreen}
          onClick={onToggleFullscreen}
        />
        </>
        )}
        <Divider vertical />
        <button
          type="button"
          onClick={onIngest}
          disabled={ingesting}
          className="flex h-7 items-center gap-1.5 rounded-card bg-accent px-2.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Icon name="refresh" size={14} className={ingesting ? "ml-pulse" : ""} />
          {ingesting ? "Đang nạp…" : "Nạp dữ liệu"}
        </button>
      </div>
    </header>
  );
}