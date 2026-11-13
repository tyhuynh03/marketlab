import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelAgentRun,
  startAgentRun,
  type AgentRunDetail,
  type AgentRunStatus,
} from "./api";

/**
 * Mot run agent doc-only: tao run roi theo doi SSE. Su kien duoc backend giu lai
 * nen khi EventSource tu noi lai, client bo qua seq da thay thay vi ve lap.
 */

const TIMEOUT_MS = 90_000;
const MAX_TRACE = 40;

type LogTone = "info" | "ok" | "error";

export type AgentStatus = "idle" | "starting" | "running" | "done" | "error" | "cancelled";

export type AgentTraceEntry =
  | { kind: "step"; seq: number; step: number; model: string; tools: string[]; tokens: number; latencyMs: number }
  | { kind: "tool"; seq: number; step: number; tool: string; detail: string };

export type AgentMeta = {
  modelUsed: string;
  tokensIn: number;
  tokensOut: number;
  steps: number;
  elapsedMs: number;
};

export type AgentAnswer = AgentMeta & { text: string };

export type AgentRunState = {
  status: AgentStatus;
  runId: number | null;
  trace: AgentTraceEntry[];
  answer: AgentAnswer | null;
  meta: AgentMeta | null;
  error: string | null;
  /** Server da bao xong (done/snapshot) hoac run khong ton tai nua: khong huy duoc. */
  finished: boolean;
};

export const EMPTY_AGENT_RUN: AgentRunState = {
  status: "idle",
  runId: null,
  trace: [],
  answer: null,
  meta: null,
  error: null,
  finished: false,
};

type ServerEvent =
  | { type: "step"; seq?: number; step: number; model: string; tools: string[]; tokens: number; latency_ms: number }
  | { type: "tool_result"; seq?: number; step: number; tool: string; result: unknown }
  | { type: "answer"; seq?: number; text: string; model_used: string; tokens_in: number; tokens_out: number; steps: number; elapsed_ms: number }
  | {
      type: "done";
      seq?: number;
      run_id: number;
      status: AgentRunStatus;
      model_used: string;
      tokens_in: number;
      tokens_out: number;
      steps: number;
      elapsed_ms: number;
      error: string | null;
    }
  | { type: "error"; seq?: number; message: string }
  | { type: "snapshot"; seq?: number; run: AgentRunDetail };

function preview(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  } catch {
    text = String(value);
  }
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 120 ? `${clean.slice(0, 120)}…` : clean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useAgentRun({
  symbol,
  timeframe,
  onLog,
}: {
  symbol: string;
  timeframe: string;
  onLog: (text: string, tone?: LogTone) => void;
}) {
  const [state, setState] = useState<AgentRunState>(EMPTY_AGENT_RUN);
  const stateRef = useRef(state);
  stateRef.current = state;

  const targetRef = useRef({ symbol, timeframe });
  targetRef.current = { symbol, timeframe };
  const logRef = useRef(onLog);
  logRef.current = onLog;

  const sourceRef = useRef<EventSource | null>(null);
  const timerRef = useRef<number | null>(null);
  const seenRef = useRef<Set<number>>(new Set());

  const closeStream = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
  }, []);

  useEffect(() => closeStream, [closeStream]);

  const handle = useCallback((event: ServerEvent) => {
    const seq = typeof event.seq === "number" ? event.seq : 0;
    const { symbol: pair, timeframe: tf } = targetRef.current;

    if (event.type === "step") {
      const entry: AgentTraceEntry = {
        kind: "step", seq, step: event.step, model: event.model,
        tools: event.tools ?? [], tokens: event.tokens, latencyMs: event.latency_ms,
      };
      setState((s) => ({ ...s, trace: [...s.trace, entry].slice(-MAX_TRACE) }));
      const took = `${(event.latency_ms / 1000).toFixed(1)}s`;
      logRef.current(
        event.tools.length > 0
          ? `Agent ${pair} ${tf} · bước ${event.step}: ${event.tools.join(", ")} (${event.tokens} token, ${took})`
          : `Agent ${pair} ${tf} · bước ${event.step}: chốt câu trả lời (${event.tokens} token, ${took})`,
      );
      return;
    }

    if (event.type === "tool_result") {
      const entry: AgentTraceEntry = {
        kind: "tool", seq, step: event.step, tool: event.tool, detail: preview(event.result),
      };
      setState((s) => ({ ...s, trace: [...s.trace, entry].slice(-MAX_TRACE) }));
      return;
    }

    if (event.type === "answer") {
      const meta: AgentMeta = {
        modelUsed: event.model_used, tokensIn: event.tokens_in, tokensOut: event.tokens_out,
        steps: event.steps, elapsedMs: event.elapsed_ms,
      };
      setState((s) => ({ ...s, status: "done", meta, answer: { ...meta, text: event.text } }));
      return;
    }

    if (event.type === "done") {
      const meta: AgentMeta = {
        modelUsed: event.model_used, tokensIn: event.tokens_in, tokensOut: event.tokens_out,
        steps: event.steps, elapsedMs: event.elapsed_ms,
      };
      setState((s) => ({
        ...s,
        status: event.status,
        meta,
        error: event.error ?? null,
        finished: true,
      }));
      closeStream();
      const tokens = event.tokens_in + event.tokens_out;
      if (event.status === "done") {
        logRef.current(
          `Agent ${pair} ${tf} xong — ${event.steps} bước, ${tokens} token, ${(event.elapsed_ms / 1000).toFixed(1)}s`,
          "ok",
        );
      } else if (event.status === "cancelled") {
        logRef.current(`Agent ${pair} ${tf} đã hủy sau ${event.steps} bước`, "info");
      } else {
        logRef.current(`Agent ${pair} ${tf} lỗi: ${event.error ?? "không rõ nguyên nhân"}`, "error");
      }
      return;
    }

    if (event.type === "error") {
      // Loi giua run: su kien done ngay sau do mang trang thai cuoi va thong diep.
      setState((s) => ({ ...s, error: event.message }));
      return;
    }

    // snapshot: run khong con trong bo nho api (api restart) — doc lai tu DB, khong stream tiep.
    const row = event.run;
    const meta: AgentMeta = {
      modelUsed: row.model_answer, tokensIn: row.tokens_in, tokensOut: row.tokens_out,
      steps: row.steps, elapsedMs: row.elapsed_ms ?? 0,
    };
    setState({
      status: row.status,
      runId: row.run_id,
      trace: [],
      answer: row.answer ? { ...meta, text: row.answer } : null,
      meta,
      error: row.error,
      finished: true,
    });
    closeStream();
    logRef.current(`Agent run #${row.run_id}: đọc lại từ DB — trạng thái ${row.status}`);
  }, [closeStream]);

  const open = useCallback((runId: number) => {
    const source = new EventSource(`/api/agent/runs/${runId}/stream`);
    sourceRef.current = source;
    seenRef.current = new Set();
    timerRef.current = window.setTimeout(() => {
      closeStream();
      const { symbol: pair, timeframe: tf } = targetRef.current;
      setState((s) => s.status === "running"
        ? {
            ...s,
            status: "error",
            error: `Agent không phản hồi sau ${TIMEOUT_MS / 1000} giây. Run vẫn có thể đang chạy trên server — bấm Hủy hoặc thử lại.`,
          }
        : s);
      logRef.current(`Agent ${pair} ${tf}: quá ${TIMEOUT_MS / 1000}s không có phản hồi, đã đóng stream`, "error");
    }, TIMEOUT_MS);

    source.onmessage = (message) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(message.data as string) as ServerEvent;
      } catch {
        return;
      }
      if (typeof event.seq === "number") {
        if (seenRef.current.has(event.seq)) return;
        seenRef.current.add(event.seq);
      }
      handle(event);
    };
    source.onerror = () => {
      // EventSource tu noi lai khi dut mang (backend replay su kien, seq chan ve lap);
      // chi bao loi khi trinh duyet da bo cuoc han.
      if (source.readyState === EventSource.CLOSED && stateRef.current.status === "running") {
        closeStream();
        setState((s) => ({
          ...s,
          status: "error",
          error: "Mất kết nối tới stream của agent. Thử lại hoặc bấm Hủy để đóng run.",
        }));
        logRef.current("Agent: mất kết nối stream", "error");
      }
    };
  }, [closeStream, handle]);

  const start = useCallback(async () => {
    const current = stateRef.current;
    if (current.status === "starting" || (current.runId !== null && !current.finished)) return;
    closeStream();
    const { symbol: pair, timeframe: tf } = targetRef.current;
    setState({ ...EMPTY_AGENT_RUN, status: "starting" });
    logRef.current(`Agent bắt đầu ${pair} ${tf}`, "info");
    try {
      const created = await startAgentRun(pair, tf);
      setState((s) => ({ ...s, status: "running", runId: created.run_id }));
      open(created.run_id);
    } catch (error) {
      const message = messageOf(error);
      setState((s) => ({ ...s, status: "error", error: message, finished: true }));
      logRef.current(`Agent không tạo được run: ${message}`, "error");
    }
  }, [closeStream, open]);

  const cancel = useCallback(async () => {
    const { runId, finished } = stateRef.current;
    if (runId === null || finished) return;
    try {
      const result = await cancelAgentRun(runId);
      if (result.status !== "running") {
        closeStream();
        setState((s) => ({ ...s, status: result.status, finished: true }));
      }
      logRef.current(
        `Đã hủy agent run #${runId}` + (result.cancelled ? "" : ` (server đã ở trạng thái ${result.status})`),
        "info",
      );
    } catch (error) {
      const message = messageOf(error);
      setState((s) => ({ ...s, error: message }));
      logRef.current(`Không hủy được agent run #${runId}: ${message}`, "error");
    }
  }, [closeStream]);

  const reset = useCallback(() => {
    closeStream();
    setState(EMPTY_AGENT_RUN);
  }, [closeStream]);

  return { state, start, cancel, reset };
}
