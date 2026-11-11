import { useEffect, useRef, useState } from "react";
import type { Candle } from "./api";

export type LiveBar = Candle & { closed: boolean };
export type LiveState = "on" | "off" | "error" | "connecting";

type LiveEvent =
  | { type: "state"; state: LiveState }
  | { type: "closed"; symbol: string; timeframe: string }
  | (LiveBar & { type: "bar"; symbol: string; timeframe: string });

export const liveKey = (symbol: string, timeframe: string) => `${symbol}|${timeframe}`;

/** Một kết nối SSE cho cả terminal; sàn đẩy nhiều stream nên gom nhịp trước khi render. */
export function useLiveStream(enabled: boolean, onClosed: (symbols: string[]) => void) {
  const [bars, setBars] = useState<Record<string, LiveBar>>({});
  const [state, setState] = useState<LiveState>("off");
  const pending = useRef(new Map<string, LiveBar>());
  const closed = useRef(new Set<string>());
  const callback = useRef(onClosed);
  callback.current = onClosed;

  useEffect(() => {
    if (!enabled) {
      setState("off");
      setBars({});
      pending.current.clear();
      closed.current.clear();
      return;
    }
    setState("connecting");
    const source = new EventSource("/api/live");
    source.onopen = () => setState("on");
    source.onerror = () => setState("error");
    source.onmessage = (event) => {
      let message: LiveEvent;
      try {
        message = JSON.parse(event.data as string) as LiveEvent;
      } catch {
        return;
      }
      if (message.type === "state") setState(message.state);
      else if (message.type === "closed") closed.current.add(message.symbol);
      else pending.current.set(liveKey(message.symbol, message.timeframe), message);
    };

    const timer = window.setInterval(() => {
      if (pending.current.size > 0) {
        const batch = new Map(pending.current);
        pending.current.clear();
        setBars((prev) => {
          const next = { ...prev };
          for (const [key, bar] of batch) next[key] = bar;
          return next;
        });
      }
      if (closed.current.size > 0) {
        const symbols = [...closed.current];
        closed.current.clear();
        callback.current(symbols);
      }
    }, 400);

    return () => {
      window.clearInterval(timer);
      source.close();
    };
  }, [enabled]);

  return { bars, state };
}