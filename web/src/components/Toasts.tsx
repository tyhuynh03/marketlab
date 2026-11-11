import { useEffect } from "react";
import { Icon, ToolButton } from "./ui";

export type Toast = {
  id: number;
  text: string;
  tone: "info" | "ok" | "error";
  action?: { label: string; run: () => void };
};

function Item({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), toast.action ? 9000 : 5000);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.action, onDismiss]);

  const color = toast.tone === "error" ? "text-down" : toast.tone === "ok" ? "text-up" : "text-accent";
  return (
    <div className="ml-toast flex w-[330px] items-start gap-2 rounded-card border border-line2 bg-elev px-3 py-2 shadow-[0_8px_24px_rgba(0,0,0,0.4)]">
      <Icon
        name={toast.tone === "error" ? "alert" : toast.tone === "ok" ? "check" : "info"}
        size={14}
        className={`mt-0.5 shrink-0 ${color}`}
      />
      <p className="min-w-0 flex-1 text-[12px] leading-snug">{toast.text}</p>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.run();
            onDismiss(toast.id);
          }}
          className="shrink-0 rounded-card border border-line px-1.5 py-0.5 text-[11px] text-accent hover:bg-hover"
        >
          {toast.action.label}
        </button>
      )}
      <ToolButton icon="close" label="Đóng thông báo" onClick={() => onDismiss(toast.id)} className="h-5 w-5 shrink-0" />
    </div>
  );
}

export default function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-10 right-3 z-[120] flex flex-col items-end gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <Item toast={t} onDismiss={onDismiss} />
        </div>
      ))}
    </div>
  );
}