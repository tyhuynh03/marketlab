import { fmtTime, type Health } from "../api";
import type { LiveState } from "../live";
import { tzLabel } from "../theme";
import { Icon, ToolButton } from "./ui";

export default function StatusBar({
  health,
  healthError,
  symbol,
  timeframe,
  loaded,
  lastTs,
  shapeCount,
  timezone,
  liveState,
  logScale,
  grid,
  onTimezone,
  onLive,
  onLogScale,
  onGrid,
  onZoom,
  onFit,
}: {
  health: Health | undefined;
  healthError: boolean;
  symbol: string;
  timeframe: string;
  loaded: number;
  lastTs: string | null;
  shapeCount: number;
  timezone: "utc" | "local";
  liveState: LiveState;
  logScale: boolean;
  grid: boolean;
  onTimezone: () => void;
  onLive: () => void;
  onLogScale: () => void;
  onGrid: () => void;
  onZoom: (factor: number) => void;
  onFit: () => void;
}) {
  const dot = healthError ? "bg-down" : health ? "bg-up" : "bg-warn";
  return (
    <footer className="z-30 flex h-7 shrink-0 items-center gap-2 overflow-hidden border-t border-line bg-panel px-2 text-[11px] text-dim">
      <span className="flex shrink-0 items-center gap-1.5" title={healthError ? "Không gọi được backend" : "Backend đang chạy"}>
        <span className={`h-1.5 w-1.5 rounded-pill ${dot} ${healthError ? "" : "ml-pulse"}`} />
        <span className="hidden sm:inline">{healthError ? "mất kết nối backend" : `TimescaleDB ${health?.timescaledb ?? "…"}`}</span>
      </span>
      <span className="hidden h-3 w-px shrink-0 bg-line sm:block" />
      <span className="tnum hidden shrink-0 sm:block">{health ? health.candles.toLocaleString("en-US") : "—"} nến trong kho</span>
      <span className="h-3 w-px shrink-0 bg-line" />
      <span className="tnum min-w-0 truncate">{symbol} · {timeframe} · {loaded} nến đang xem</span>
      <span className="hidden h-3 w-px shrink-0 bg-line md:block" />
      <span className="tnum hidden shrink-0 md:block">nến đóng cuối: {lastTs ? `${fmtTime(lastTs)} UTC` : "—"}</span>
      {shapeCount > 0 && (
        <>
          <span className="hidden h-3 w-px shrink-0 bg-line lg:block" />
          <span className="tnum hidden shrink-0 lg:block">{shapeCount} hình vẽ</span>
        </>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={onLive}
          title="Luồng nến trực tiếp Binance qua backend; chỉ nến đóng mới ghi vào kho"
          className={
            "flex h-5 items-center gap-1 rounded-card px-1.5 text-[10px] font-medium " +
            (liveState === "on" ? "bg-up/15 text-up" : liveState === "error" ? "bg-warn/15 text-warn" : "text-faint hover:bg-hover")
          }
        >
          <span className={`h-1.5 w-1.5 rounded-pill ${liveState === "on" ? "bg-up ml-pulse" : liveState === "error" ? "bg-warn" : "bg-faint"}`} />
          {liveState === "on" ? "LIVE" : liveState === "error" ? "LIVE lỗi" : liveState === "connecting" ? "LIVE…" : "LIVE tắt"}
        </button>
        <button
          type="button"
          onClick={onTimezone}
          title="Đổi múi giờ hiển thị trục thời gian"
          className="tnum h-5 rounded-card px-1.5 hover:bg-hover hover:text-ink"
        >
          {tzLabel(timezone)}
        </button>
        <ToolButton label="Thang log" active={logScale} onClick={onLogScale} className="h-5 px-1.5 text-[10px]">
          log
        </ToolButton>
        <ToolButton icon="table" label="Lưới" active={grid} onClick={onGrid} className="h-5 w-6" />
        <span className="mx-0.5 h-3 w-px bg-line" />
        <ToolButton icon="minus" label="Thu nhỏ" onClick={() => onZoom(1.25)} className="h-5 w-6" />
        <ToolButton icon="plus" label="Phóng to" onClick={() => onZoom(0.8)} className="h-5 w-6" />
        <ToolButton icon="expand" label="Vừa khung dữ liệu" onClick={onFit} className="h-5 w-6" />
        <span className="ml-1 hidden items-center gap-1 text-faint xl:flex">
          <Icon name="clock" size={12} />
          kho chỉ nến đã đóng
        </span>
      </div>
    </footer>
  );
}