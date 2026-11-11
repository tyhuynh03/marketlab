import { TOOL_LABELS, type ToolId } from "../drawings";
import { Icon, ToolButton } from "./ui";

const TOOLS: { id: ToolId; icon: string; key: string }[] = [
  { id: "cursor", icon: "cursor", key: "V" },
  { id: "trend", icon: "trend", key: "T" },
  { id: "ray", icon: "ray", key: "R" },
  { id: "hline", icon: "hline", key: "H" },
  { id: "rect", icon: "rect", key: "B" },
  { id: "fib", icon: "fib", key: "F" },
  { id: "measure", icon: "ruler", key: "M" },
  { id: "eraser", icon: "eraser", key: "E" },
];

export default function DrawingRail({
  tool,
  locked,
  hidden,
  magnet,
  shapeCount,
  drawColor,
  onToolChange,
  onToggleLock,
  onToggleHidden,
  onToggleMagnet,
  onColorChange,
  onClear,
}: {
  tool: ToolId;
  locked: boolean;
  hidden: boolean;
  magnet: boolean;
  shapeCount: number;
  drawColor: string;
  onToolChange: (tool: ToolId) => void;
  onToggleLock: () => void;
  onToggleHidden: () => void;
  onToggleMagnet: () => void;
  onColorChange: (color: string) => void;
  onClear: () => void;
}) {
  return (
    <nav
      aria-label="Công cụ vẽ"
      className="z-30 flex w-11 shrink-0 flex-col items-center gap-0.5 border-r border-line bg-panel py-1.5"
    >
      {TOOLS.map((t) => (
        <ToolButton
          key={t.id}
          icon={t.icon}
          label={`${TOOL_LABELS[t.id]} (Alt+${t.key})`}
          active={tool === t.id}
          onClick={() => onToolChange(t.id)}
          className="w-8"
        />
      ))}

      <span className="my-1 h-px w-6 bg-line" aria-hidden="true" />

      <ToolButton icon="magnet" label={`Hút vào OHLC: ${magnet ? "bật" : "tắt"}`} active={magnet} onClick={onToggleMagnet} className="w-8" />
      <ToolButton
        icon={locked ? "lock" : "unlock"}
        label={locked ? "Mở khoá hình vẽ" : "Khoá hình vẽ"}
        active={locked}
        onClick={onToggleLock}
        className="w-8"
      />
      <ToolButton
        icon={hidden ? "eyeOff" : "eye"}
        label={hidden ? "Hiện hình vẽ" : "Ẩn hình vẽ"}
        active={hidden}
        onClick={onToggleHidden}
        className="w-8"
      />

      <label className="mt-0.5 flex h-8 w-8 cursor-pointer items-center justify-center rounded-card hover:bg-hover" title="Màu nét vẽ">
        <span className="relative flex h-4 w-4 items-center justify-center rounded-[3px] border border-line2" style={{ background: drawColor }}>
          <input
            type="color"
            value={drawColor}
            onChange={(e) => onColorChange(e.target.value)}
            aria-label="Màu nét vẽ"
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </span>
      </label>

      <span className="my-1 h-px w-6 bg-line" aria-hidden="true" />

      <ToolButton
        icon="trash"
        label={shapeCount > 0 ? `Xoá ${shapeCount} hình vẽ của symbol này` : "Chưa có hình vẽ để xoá"}
        danger
        disabled={shapeCount === 0}
        onClick={onClear}
        className="w-8"
      />
      <span className="tnum mt-0.5 text-[10px] text-faint" title="Số hình vẽ đang lưu cho symbol này">{shapeCount}</span>
      <span className="mt-auto pb-1 text-faint" title="Kéo trên chart để vẽ, Delete để xoá hình đang chọn">
        <Icon name="info" size={13} />
      </span>
    </nav>
  );
}