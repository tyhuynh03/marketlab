import { withAlpha, type Palette } from "./theme";

export type ToolId = "cursor" | "trend" | "ray" | "hline" | "rect" | "fib" | "measure" | "eraser";
export type ShapeKind = Exclude<ToolId, "cursor" | "eraser">;

/** time lưu theo giây UTC để hình vẽ không lệch khi đổi múi giờ hiển thị. */
export type Anchor = { time: number; price: number };

export type Shape = {
  id: string;
  kind: ShapeKind;
  a: Anchor;
  b: Anchor;
  color: string;
};

export type Projector = {
  x(timeUtc: number): number | null;
  y(price: number): number | null;
  time(x: number): number | null;
  price(y: number): number | null;
  width: number;
  height: number;
  /** Độ dài một nến tính bằng giây, để công cụ đo đếm đúng số nến. */
  step: number;
};

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

export const TOOL_LABELS: Record<ToolId, string> = {
  cursor: "Con trỏ",
  trend: "Đường xu thế",
  ray: "Tia",
  hline: "Đường ngang",
  rect: "Hình chữ nhật",
  fib: "Fibonacci thoái lui",
  measure: "Đo lường",
  eraser: "Xoá hình",
};

let seq = 0;
export function newShapeId(): string {
  seq += 1;
  return `s${Date.now().toString(36)}${seq}`;
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function handle(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, bg: string) {
  ctx.fillStyle = bg;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.rect(x - 3.5, y - 3.5, 7, 7);
  ctx.fill();
  ctx.stroke();
}

function chip(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  p: Palette,
  color: string,
  bounds: number,
) {
  ctx.font = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  const w = ctx.measureText(text).width + 10;
  const left = Math.min(Math.max(x, 2), Math.max(2, bounds - w - 2));
  ctx.fillStyle = withAlpha(p.bg, 0.86);
  ctx.strokeStyle = withAlpha(color, 0.6);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(left, y - 8, w, 16);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, left + 5, y);
}

function fmt(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

export type RenderState = {
  shapes: Shape[];
  selectedId: string | null;
  hoverId: string | null;
  palette: Palette;
  hidden: boolean;
  draft: Shape | null;
};

export function renderShapes(ctx: CanvasRenderingContext2D, proj: Projector, state: RenderState): void {
  ctx.clearRect(0, 0, proj.width, proj.height);
  if (state.hidden) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, proj.width, proj.height);
  ctx.clip();

  const all = state.draft ? [...state.shapes, state.draft] : state.shapes;
  for (const shape of all) {
    const active = shape.id === state.selectedId;
    const hovered = shape.id === state.hoverId;
    drawShape(ctx, proj, shape, state.palette, active || hovered);
  }
  ctx.restore();
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  proj: Projector,
  shape: Shape,
  p: Palette,
  active: boolean,
): void {
  const ax = proj.x(shape.a.time);
  const ay = proj.y(shape.a.price);
  const bx = proj.x(shape.b.time);
  const by = proj.y(shape.b.price);
  if (ax === null || ay === null) return;

  ctx.lineWidth = active ? 2 : 1.5;
  ctx.strokeStyle = shape.color;
  ctx.setLineDash([]);

  if (shape.kind === "hline") {
    line(ctx, 0, ay, proj.width, ay);
    chip(ctx, fmt(shape.a.price), proj.width - 78, ay - 12, p, shape.color, proj.width);
    if (active) handle(ctx, Math.min(60, proj.width / 2), ay, shape.color, p.bg);
    return;
  }

  if (bx === null || by === null) return;

  switch (shape.kind) {
    case "trend":
      line(ctx, ax, ay, bx, by);
      break;
    case "ray": {
      const dx = bx - ax;
      const dy = by - ay;
      const scale = dx === 0 ? 1 : Math.max(1, (proj.width * 2 - ax) / dx);
      line(ctx, ax, ay, ax + dx * scale, ay + dy * scale);
      break;
    }
    case "rect":
      ctx.fillStyle = withAlpha(shape.color, 0.1);
      ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      break;
    case "fib": {
      const left = Math.min(ax, bx);
      const span = shape.b.price - shape.a.price;
      for (let i = 0; i < FIB_LEVELS.length; i += 1) {
        const level = FIB_LEVELS[i]!;
        const price = shape.a.price + span * level;
        const y = proj.y(price);
        if (y === null) continue;
        const next = FIB_LEVELS[i + 1];
        if (next !== undefined) {
          const y2 = proj.y(shape.a.price + span * next);
          if (y2 !== null) {
            ctx.fillStyle = withAlpha(shape.color, i % 2 === 0 ? 0.07 : 0.03);
            ctx.fillRect(left, Math.min(y, y2), proj.width - left, Math.abs(y2 - y));
          }
        }
        ctx.strokeStyle = withAlpha(shape.color, level === 0 || level === 1 ? 1 : 0.75);
        line(ctx, left, y, proj.width, y);
        chip(ctx, `${level} (${fmt(price)})`, left + 4, y - 10, p, shape.color, proj.width);
      }
      ctx.strokeStyle = withAlpha(shape.color, 0.5);
      ctx.setLineDash([4, 4]);
      line(ctx, ax, ay, bx, by);
      ctx.setLineDash([]);
      break;
    }
    case "measure": {
      const up = shape.b.price >= shape.a.price;
      const color = up ? p.up : p.down;
      ctx.strokeStyle = color;
      ctx.fillStyle = withAlpha(color, 0.12);
      ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      const diff = shape.b.price - shape.a.price;
      const pct = shape.a.price !== 0 ? (diff / shape.a.price) * 100 : 0;
      const bars = Math.round((shape.b.time - shape.a.time) / (proj.step || 3600));
      const text = `${up ? "+" : ""}${fmt(diff)}  ${up ? "+" : ""}${pct.toFixed(2)}%  ${bars} nến`;
      chip(ctx, text, (ax + bx) / 2 - 60, Math.max(ay, by) + 14, p, color, proj.width);
      break;
    }
  }

  if (active && shape.kind !== "fib") {
    handle(ctx, ax, ay, shape.color, p.bg);
    handle(ctx, bx, by, shape.color, p.bg);
  }
}

function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function hitTest(shapes: Shape[], proj: Projector, x: number, y: number): string | null {
  for (let i = shapes.length - 1; i >= 0; i -= 1) {
    const s = shapes[i]!;
    const ax = proj.x(s.a.time);
    const ay = proj.y(s.a.price);
    if (ax === null || ay === null) continue;
    if (s.kind === "hline") {
      if (Math.abs(y - ay) <= 5) return s.id;
      continue;
    }
    const bx = proj.x(s.b.time);
    const by = proj.y(s.b.price);
    if (bx === null || by === null) continue;
    switch (s.kind) {
      case "trend":
        if (distanceToSegment(x, y, ax, ay, bx, by) <= 6) return s.id;
        break;
      case "ray":
        if (distanceToSegment(x, y, ax, ay, bx + (bx - ax) * 50, by + (by - ay) * 50) <= 6) return s.id;
        break;
      case "rect":
      case "measure": {
        const inside = x >= Math.min(ax, bx) - 4 && x <= Math.max(ax, bx) + 4 &&
          y >= Math.min(ay, by) - 4 && y <= Math.max(ay, by) + 4;
        if (inside) return s.id;
        break;
      }
      case "fib": {
        const left = Math.min(ax, bx);
        if (x < left - 4) break;
        const span = s.b.price - s.a.price;
        for (const level of FIB_LEVELS) {
          const ly = proj.y(s.a.price + span * level);
          if (ly !== null && Math.abs(y - ly) <= 5) return s.id;
        }
        break;
      }
    }
  }
  return null;
}

export function hitHandle(shape: Shape, proj: Projector, x: number, y: number): "a" | "b" | null {
  const points: ("a" | "b")[] = shape.kind === "hline" ? ["a"] : ["a", "b"];
  for (const key of points) {
    const anchor = shape[key];
    const px = proj.x(anchor.time);
    const py = proj.y(anchor.price);
    if (px === null || py === null) continue;
    if (Math.abs(x - px) <= 6 && Math.abs(y - py) <= 6) return key;
  }
  return null;
}

export function loadShapes(key: string): Shape[] {
  try {
    const raw = localStorage.getItem(`ml.drawings.${key}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Shape[]) : [];
  } catch {
    return [];
  }
}

export function saveShapes(key: string, shapes: Shape[]): void {
  try {
    localStorage.setItem(`ml.drawings.${key}`, JSON.stringify(shapes));
  } catch {
    /* hết hạn mức localStorage thì bỏ qua, hình vẫn nằm trong phiên */
  }
}

const PREFIX = "ml.drawings.";

export function loadAllShapes(): Record<string, Shape[]> {
  const out: Record<string, Shape[]> = {};
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const full = localStorage.key(i);
      if (!full || !full.startsWith(PREFIX)) continue;
      const key = full.slice(PREFIX.length);
      out[key] = loadShapes(key);
    }
  } catch {
    /* trình duyệt chặn storage thì bắt đầu với danh sách rỗng */
  }
  return out;
}

export function saveAllShapes(all: Record<string, Shape[]>): void {
  for (const [key, shapes] of Object.entries(all)) saveShapes(key, shapes);
}