import { useEffect, useMemo, useRef, useState } from "react";
import { fmtPct, fmtPrice, venueLabel, type WatchEntry } from "../api";
import { CATALOG } from "../catalog";
import { Empty, Icon, Modal, ToolButton } from "./ui";

type Row = { symbol: string; name: string; venue: string; watched: boolean; entry?: WatchEntry };

export default function SymbolSearch({
  open,
  entries,
  selected,
  adding,
  error,
  onClose,
  onSelect,
  onAdd,
  onRemove,
}: {
  open: boolean;
  entries: WatchEntry[];
  selected: string;
  adding: string | null;
  error: string | null;
  onClose: () => void;
  onSelect: (symbol: string) => void;
  onAdd: (symbol: string, name: string, venue: string) => void;
  onRemove: (symbol: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
    }
  }, [open]);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase().replace(/\s+/g, "");
    const match = (symbol: string, name: string) =>
      !q || symbol.toLowerCase().replace("/", "").includes(q.replace("/", "")) || name.toLowerCase().includes(q);
    const watched: Row[] = entries
      .filter((e) => match(e.symbol, e.label ?? ""))
      .map((e) => ({ symbol: e.symbol, name: e.label ?? e.symbol, venue: e.venue, watched: true, entry: e }));
    const known = new Set(entries.map((e) => e.symbol));
    const rest: Row[] = CATALOG
      .filter((c) => !known.has(c.symbol) && match(c.symbol, c.name))
      .map((c) => ({ symbol: c.symbol, name: c.name, venue: c.venue ?? "binance", watched: false }));
    return [...watched, ...rest];
  }, [query, entries]);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const commit = (row: Row | undefined) => {
    if (!row) return;
    if (row.watched) {
      onSelect(row.symbol);
      onClose();
    } else {
      onAdd(row.symbol, row.name, row.venue);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Tìm symbol"
      subtitle="Gõ tên hoặc mã. Symbol mới được nạp lịch sử trước khi vào danh sách — crypto từ Binance, cổ phiếu Mỹ từ Yahoo."
      width={620}
    >
      <div
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setCursor((c) => Math.min(rows.length - 1, c + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor((c) => Math.max(0, c - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            commit(rows[cursor]);
          }
        }}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <Icon name="search" className="text-dim" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="BTC, Solana, SOL/USDT…"
            aria-label="Từ khoá tìm symbol"
            className="w-full bg-transparent text-[13px] outline-none placeholder:text-faint"
          />
          <span className="tnum shrink-0 text-[11px] text-faint">{rows.length} kết quả</span>
        </div>

        {error && (
          <p className="flex items-start gap-2 border-b border-line bg-down/10 px-4 py-2 text-[11px] text-down">
            <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
            {error}
          </p>
        )}

        <div ref={listRef} className="max-h-[46vh] overflow-y-auto py-1">
          {rows.length === 0 && <Empty icon="search" title="Không khớp symbol nào" hint="Thử mã khác, ví dụ BTC, ETH, SOL." />}
          {rows.map((row, i) => (
            <div
              key={row.symbol}
              data-index={i}
              onMouseEnter={() => setCursor(i)}
              className={
                "flex items-center gap-3 px-4 py-1.5 text-[12px] " +
                (i === cursor ? "bg-hover" : "")
              }
            >
              <button
                type="button"
                onClick={() => commit(row)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <span className="flex w-[104px] shrink-0 items-center gap-1 overflow-hidden font-semibold">
                  <span className="truncate">{row.symbol}</span>
                  {row.venue !== "binance" && (
                    <span className="shrink-0 rounded-card border border-line px-1 text-[9px] font-normal text-faint">
                      {venueLabel(row.venue)}
                    </span>
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-dim">{row.name}</span>
                {row.entry && (
                  <>
                    <span className="tnum shrink-0">{fmtPrice(row.entry.last_close)}</span>
                    <span className={"tnum w-[62px] shrink-0 text-right " + ((row.entry.delta ?? 0) >= 0 ? "text-up" : "text-down")}>
                      {fmtPct(row.entry.delta)}
                    </span>
                  </>
                )}
                {!row.watched && (
                  <span className="shrink-0 rounded-card border border-line px-1.5 text-[10px] text-faint">
                    {adding === row.symbol ? "đang nạp…" : "thêm"}
                  </span>
                )}
                {row.symbol === selected && <Icon name="check" size={14} className="shrink-0 text-accent" />}
              </button>
              {row.watched && (
                <ToolButton
                  icon="trash"
                  label={`Bỏ ${row.symbol} khỏi danh sách`}
                  danger
                  onClick={() => onRemove(row.symbol)}
                  className="h-6 w-6 shrink-0"
                />
              )}
            </div>
          ))}
        </div>

        <p className="border-t border-line px-4 py-2 text-[11px] text-faint">
          ↑ ↓ để chọn · Enter để mở hoặc thêm · Esc để đóng. Gợi ý crypto đã đối chiếu với cặp spot đang giao dịch trên Binance; cổ phiếu Mỹ chỉ xem, không vào sổ paper.
        </p>
      </div>
    </Modal>
  );
}