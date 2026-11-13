import { useEffect, useId, useRef, type ReactNode } from "react";

const PATHS: Record<string, ReactNode> = {
  search: <><circle cx="7.5" cy="7.5" r="4.5" /><path d="M11 11l4 4" /></>,
  candles: <><path d="M5 3v3M5 12v3M11 2v4M11 13v3" /><rect x="3" y="6" width="4" height="6" rx="0.5" /><rect x="9" y="6" width="4" height="7" rx="0.5" /></>,
  hollow: <><path d="M5 3v3M5 12v3M11 2v4M11 13v3" /><rect x="3" y="6" width="4" height="6" rx="0.5" /><rect x="9" y="6" width="4" height="7" rx="0.5" fill="currentColor" stroke="none" /></>,
  heikin: <><path d="M2 12c3 0 3-6 6-6s3 6 6 6" /><path d="M5 4v2M5 13v2M11 3v2M11 12v2" /></>,
  bars: <><path d="M5 3v12M3 6h2M5 11h2M11 2v12M9 5h2M11 10h2" /></>,
  line: <path d="M2 12l4-4 3 3 5-6" />,
  area: <><path d="M2 12l4-4 3 3 5-6" /><path d="M2 12l4-4 3 3 5-6v9H2z" fill="currentColor" fillOpacity="0.18" stroke="none" /></>,
  fx: <><path d="M3 13c2.5 0 2-9 4.5-9" /><path d="M3.5 8h5" /><path d="M10 8l4 5M14 8l-4 5" /></>,
  gear: <><circle cx="8" cy="8" r="2.4" /><path d="M8 1.6v1.8M8 12.6v1.8M14.4 8h-1.8M3.4 8H1.6M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3M12.5 12.5l-1.3-1.3M4.8 4.8L3.5 3.5" /></>,
  camera: <><path d="M2 5.5h2.5L5.5 4h5l1 1.5H14v8H2z" /><circle cx="8" cy="9" r="2.4" /></>,
  expand: <path d="M6 2H2v4M10 2h4v4M14 10v4h-4M2 10v4h4" />,
  collapse: <path d="M2 6h4V2M14 6h-4V2M10 14v-4h4M6 14v-4H2" />,
  chevronDown: <path d="M4 6l4 4 4-4" />,
  chevronRight: <path d="M6 4l4 4-4 4" />,
  chevronLeft: <path d="M10 4l-4 4 4 4" />,
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  trash: <><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" /><path d="M6.5 7v4M9.5 7v4" /></>,
  eye: <><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="1.8" /></>,
  eyeOff: <><path d="M2.5 2.5l11 11" /><path d="M6.2 4c.6-.2 1.2-.3 1.8-.3 4 0 6.5 4.3 6.5 4.3s-.8 1.4-2.2 2.6M4.3 5.6C2.6 6.9 1.5 8 1.5 8s2.5 4.3 6.5 4.3c.9 0 1.7-.2 2.4-.5" /></>,
  lock: <><rect x="3.5" y="7" width="9" height="6.5" rx="1" /><path d="M5.5 7V5a2.5 2.5 0 015 0v2" /></>,
  unlock: <><rect x="3.5" y="7" width="9" height="6.5" rx="1" /><path d="M5.5 7V5a2.5 2.5 0 014.9-.6" /></>,
  magnet: <><path d="M4 3v6a4 4 0 008 0V3" /><path d="M4 7h3M9 7h3" /></>,
  cursor: <path d="M3.5 2.5l9 5.2-4 1.1-1.6 4z" />,
  trend: <><path d="M3 13L13 3" /><circle cx="3" cy="13" r="1.6" /><circle cx="13" cy="3" r="1.6" /></>,
  ray: <><path d="M3 13L14 2" /><circle cx="3" cy="13" r="1.6" /><path d="M11 2h3v3" /></>,
  hline: <><path d="M2 8h12" /><circle cx="8" cy="8" r="1.6" /></>,
  rect: <rect x="2.5" y="4" width="11" height="8" rx="0.5" />,
  fib: <><path d="M2 3.5h12M2 7h12M2 10.5h12M2 14h12" /><path d="M2 3.5l12 10.5" strokeOpacity="0.45" /></>,
  ruler: <><rect x="1.5" y="5.5" width="13" height="5" rx="0.5" transform="rotate(-20 8 8)" /><path d="M5 6.5l.8 1.6M7.5 5.5l.8 1.6M10 4.5l.8 1.6" /></>,
  eraser: <><path d="M6 13h7" /><path d="M3.5 10.5l5-5 4 4-5 5H5z" /></>,
  refresh: <><path d="M13.5 8a5.5 5.5 0 11-1.7-4" /><path d="M13.5 2v3.5H10" /></>,
  sun: <><circle cx="8" cy="8" r="3" /><path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2L3.1 3.1" /></>,
  moon: <path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  check: <path d="M3 8.5l3.2 3.2L13 5" />,
  alert: <><path d="M8 2.5l6 11H2z" /><path d="M8 6.5v3.2M8 11.6v.4" /></>,
  clock: <><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.4 1.6" /></>,
  database: <><ellipse cx="8" cy="4" rx="5.5" ry="2.2" /><path d="M2.5 4v8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2V4" /><path d="M2.5 8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2" /></>,
  list: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
  table: <><rect x="2" y="3" width="12" height="10" rx="1" /><path d="M2 6.5h12M6.5 6.5V13" /></>,
  info: <><circle cx="8" cy="8" r="6" /><path d="M8 7.2v4M8 4.8v.4" /></>,
  undo: <><path d="M3 7h7a3.5 3.5 0 010 7H6" /><path d="M5.5 4.5L3 7l2.5 2.5" /></>,
  star: <path d="M8 2.2l1.8 3.7 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4L2.2 6.5l4-.6z" />,
  bolt: <path d="M9 1.5L3.5 9H7l-.8 5.5L12.5 7H9z" />,
  spark: <><path d="M7 1.8l1.3 3.9L12.2 7l-3.9 1.3L7 12.2 5.7 8.3 1.8 7l3.9-1.3z" /><path d="M12.2 10.6l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z" /></>,
  layers: <><path d="M8 2l6 3-6 3-6-3z" /><path d="M2 8l6 3 6-3M2 11l6 3 6-3" /></>,
  keyboard: <><rect x="1.5" y="4" width="13" height="8" rx="1" /><path d="M4 6.5h.5M6.5 6.5h.5M9 6.5h.5M11.5 6.5h.5M4.5 9.5h7" /></>,
  drag: <path d="M2 6h12M2 10h12" />,
};

export function Icon({ name, size = 16, className = "" }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name] ?? PATHS.info}
    </svg>
  );
}

export function ToolButton({
  icon,
  label,
  active,
  onClick,
  disabled,
  danger,
  children,
  className = "",
}: {
  icon?: string;
  label: string;
  active?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={
        "flex h-7 items-center justify-center gap-1.5 rounded-card px-1.5 text-[12px] transition-colors " +
        "disabled:cursor-not-allowed disabled:opacity-40 " +
        (active
          ? "bg-hover text-accent"
          : danger
            ? "text-dim hover:bg-hover hover:text-down"
            : "text-dim hover:bg-hover hover:text-ink") +
        " " + className
      }
    >
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

export function Divider({ vertical }: { vertical?: boolean }) {
  return vertical
    ? <span className="mx-1 h-4 w-px shrink-0 bg-line" aria-hidden="true" />
    : <span className="my-1 h-px w-full bg-line" aria-hidden="true" />;
}

export function Popover({
  open,
  onClose,
  children,
  align = "left",
  width = 240,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: "left" | "right";
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      style={{ width }}
      className={`ml-pop absolute top-[calc(100%+4px)] z-50 overflow-hidden rounded-card border border-line2 bg-elev py-1 shadow-[0_8px_24px_rgba(0,0,0,0.35)] ${
        align === "right" ? "right-0" : "left-0"
      }`}
      role="menu"
    >
      {children}
    </div>
  );
}

export function MenuItem({
  icon,
  label,
  hint,
  active,
  onClick,
}: {
  icon?: string;
  label: string;
  hint?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={
        "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-hover " +
        (active ? "text-accent" : "text-ink")
      }
    >
      {icon && <Icon name={icon} className="shrink-0 text-dim" />}
      <span className="flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-[11px] text-faint">{hint}</span>}
      {active && <Icon name="check" size={14} className="shrink-0" />}
    </button>
  );
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  width = 560,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  width?: number;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    // Ô nhập phải thắng nút Đóng ở header, nếu không gõ ngay sau khi mở hộp thoại sẽ không vào đâu.
    const focusable = ref.current?.querySelector<HTMLElement>("input, textarea, select") ??
      ref.current?.querySelector<HTMLElement>("button");
    focusable?.focus();
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-[rgba(0,0,0,0.55)] p-4 pt-[8vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ width, maxWidth: "100%" }}
        className="ml-pop flex max-h-[80vh] flex-col overflow-hidden rounded-card border border-line2 bg-panel shadow-[0_16px_48px_rgba(0,0,0,0.5)]"
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-[13px] font-semibold">{title}</h2>
            {subtitle && <p className="truncate text-[11px] text-dim">{subtitle}</p>}
          </div>
          <ToolButton icon="close" label="Đóng" onClick={onClose} />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <footer className="border-t border-line px-4 py-2.5">{footer}</footer>}
      </div>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 px-4 py-2 hover:bg-hover">
      <span className="min-w-0">
        <span className="block text-[12px]">{label}</span>
        {hint && <span className="block text-[11px] text-dim">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={
          "relative h-[18px] w-8 shrink-0 rounded-pill border transition-colors " +
          (checked ? "border-accent bg-accent" : "border-line2 bg-bg")
        }
      >
        <span
          className={
            "absolute top-[2px] h-[12px] w-[12px] rounded-pill bg-white transition-all " +
            (checked ? "left-[16px]" : "left-[2px]")
          }
        />
      </button>
    </label>
  );
}

export function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-[12px]">
      <span className="text-dim">{label}</span>
      <span className="flex items-center gap-1">
        <ToolButton
          icon="minus"
          label={`Giảm ${label}`}
          onClick={() => onChange(Math.max(min, Number((value - step).toFixed(4))))}
          className="h-6 w-6 border border-line"
        />
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
          }}
          className="tnum h-6 w-14 rounded-card border border-line bg-bg px-1.5 text-center text-[12px] outline-none focus:border-accent"
        />
        <ToolButton
          icon="plus"
          label={`Tăng ${label}`}
          onClick={() => onChange(Math.min(max, Number((value + step).toFixed(4))))}
          className="h-6 w-6 border border-line"
        />
      </span>
    </label>
  );
}

export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center justify-between gap-2 text-[12px]">
      <span className="text-dim">{label}</span>
      <span className="flex items-center gap-2">
        <span className="tnum text-[11px] text-faint">{value.toUpperCase()}</span>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          className="h-6 w-8 cursor-pointer rounded-card border border-line bg-bg p-0.5"
        />
      </span>
    </label>
  );
}

export function Empty({ icon = "info", title, hint }: { icon?: string; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <Icon name={icon} size={22} className="text-faint" />
      <p className="text-[12px] text-dim">{title}</p>
      {hint && <p className="max-w-[280px] text-[11px] leading-relaxed text-faint">{hint}</p>}
    </div>
  );
}