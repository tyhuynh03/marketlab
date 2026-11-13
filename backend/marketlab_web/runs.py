"""marketlab_web.runs — vong lap agent doc-only chay nen + SSE cho tung run.

Buoc 2 lo trinh agentic: model tool (gpt-oss) duoc goi toi da MAX_TOOL_STEPS lan
voi 4 tool doc du lieu, moi ket qua duoc nen lai truoc khi gui. Sau vong lap la
DUNG MOT call tra loi cuoi bang model qwen tren bang chung da nen (khong do raw
tool output vao prompt cuoi). Run chay background task trong process api, moi
su kien duoc giu lai de client reconnect doc tiep.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from marketlab_web import agent, db, tools

log = logging.getLogger("marketlab.runs")

HEARTBEAT_SECONDS = 15
MAX_EVENTS = 200
MAX_TOOLS_PER_STEP = 3
MAX_TOOL_MESSAGE_CHARS = 1_600
MAX_LOOP_MESSAGE_CHARS = 7_000
MAX_EVIDENCE_NOTES = 4
MAX_EVIDENCE_NOTE_CHARS = 520
MAX_DRAFT_CHARS = 600
MAX_ANSWER_CANDLES = 20
ERROR_CLIP = 300
RETRY_DEFAULT_SECONDS = 8.0
RETRY_MAX_SECONDS = 20.0

TOOL_SYSTEM_PROMPT = (
    "Bạn là agent nghiên cứu thị trường của marketlab. Chỉ được gọi các tool đọc dữ liệu "
    "đã cho; không bịa số, không đặt lệnh. Mỗi bước chỉ gọi tool cần thiết. Khi đã đủ "
    "bằng chứng thì trả lời ngắn gọn bằng tiếng Việt và không gọi tool nữa."
)

ANSWER_RULES = (
    "YÊU CẦU: trả lời bằng tiếng Việt, giọng thông tin, tối đa 220 từ. Nêu ít nhất 2 chỉ số "
    "trong phần summary (Sharpe và max drawdown). Ngày ghi dạng yyyy-mm-dd hh:mm (UTC), symbol "
    "viết hoa. Không khuyến nghị mua/bán, không hứa lợi nhuận, không kết luận ngoài dữ liệu trên."
)


def _event(kind: str, **payload: Any) -> dict[str, Any]:
    return {"type": kind, **payload}


def sse(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"


def _clip(text: str, limit: int = ERROR_CLIP) -> str:
    clean = " ".join(str(text).split())
    return clean if len(clean) <= limit else f"{clean[:limit]}…"


def _dump(value: Any, limit: int | None = None, keep: str = "head") -> str:
    text = json.dumps(value, ensure_ascii=False, default=str, separators=(",", ":"))
    if limit and len(text) > limit:
        return (text[:limit] + "…") if keep == "head" else ("…" + text[-limit:])
    return text


def _assistant_message(text: str, calls: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": text or None,
        "tool_calls": [
            {"id": call["id"], "type": "function",
             "function": {"name": call["name"], "arguments": call["arguments"]}}
            for call in calls
        ],
    }


def _retry_delay(exc: agent.ProviderError) -> float:
    """Cho ngan truoc khi thu lai mot lan: uu tien Retry-After, toi da 20 giay."""
    raw = getattr(exc, "retry_after", None)
    delay = RETRY_DEFAULT_SECONDS if raw is None else float(raw)
    return max(0.5, min(delay, RETRY_MAX_SECONDS))


async def _pause(seconds: float) -> None:
    """Mot cho duy nhat de test thay bang no-op, khong sleep that."""
    await asyncio.sleep(seconds)


def _trim_loop(messages: list[dict[str, Any]]) -> None:
    """Giu [system, user] co dinh; bo luot assistant cu nhat kem tool message cua no."""
    while len(messages) > 3 and len(_dump(messages)) > MAX_LOOP_MESSAGE_CHARS:
        del messages[2]
        while len(messages) > 2 and messages[2].get("role") == "tool":
            del messages[2]


@dataclass
class RunHandle:
    run_id: int
    symbol: str
    timeframe: str
    model_tool: str
    model_answer: str
    status: str = "running"
    steps: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    answer: str | None = None
    error: str | None = None
    started: float = field(default_factory=time.perf_counter)
    events: list[dict[str, Any]] = field(default_factory=list)
    subscribers: set[asyncio.Queue] = field(default_factory=set)
    task: asyncio.Task | None = None
    cancel: asyncio.Event = field(default_factory=asyncio.Event)
    seq: int = 0

    def publish(self, event: dict[str, Any]) -> None:
        self.seq += 1
        event["seq"] = self.seq
        self.events.append(event)
        if len(self.events) > MAX_EVENTS:
            del self.events[:len(self.events) - MAX_EVENTS]
        for queue in list(self.subscribers):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=256)
        self.subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self.subscribers.discard(queue)

    def snapshot(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id, "symbol": self.symbol, "timeframe": self.timeframe,
            "status": self.status, "model_tool": self.model_tool,
            "model_answer": self.model_answer, "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out, "steps": self.steps,
            "answer": self.answer, "error": self.error,
            "elapsed_ms": int((time.perf_counter() - self.started) * 1000),
        }


class RunManager:
    def __init__(self, pool: Any, settings: Any) -> None:
        self.pool = pool
        self.settings = settings
        self.runs: dict[int, RunHandle] = {}

    def get(self, run_id: int) -> RunHandle | None:
        return self.runs.get(run_id)

    async def create(self, symbol: str, timeframe: str) -> RunHandle:
        run_id = await db.create_agent_run(
            self.pool, symbol, timeframe, self.settings.llm_model_tool, self.settings.llm_model)
        handle = RunHandle(run_id=run_id, symbol=symbol, timeframe=timeframe,
                           model_tool=self.settings.llm_model_tool,
                           model_answer=self.settings.llm_model)
        self.runs[run_id] = handle
        handle.task = asyncio.create_task(self._execute(handle), name=f"agent-run-{run_id}")
        return handle

    async def cancel(self, run_id: int) -> str | None:
        handle = self.runs.get(run_id)
        if handle is None:
            return None
        if handle.status == "running":
            # Dat trang thai truoc de endpoint tra ve dung ngay ca khi task chua kip dung.
            handle.status = "cancelled"
            handle.cancel.set()
            if handle.task is not None:
                handle.task.cancel()
        return handle.status

    async def stop(self) -> None:
        for handle in list(self.runs.values()):
            if handle.task is not None and not handle.task.done():
                handle.task.cancel()
        for handle in list(self.runs.values()):
            if handle.task is not None:
                try:
                    await handle.task
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass
        self.runs.clear()

    async def _execute(self, handle: RunHandle) -> None:
        status, error, answer = "running", None, None
        try:
            evidence = await self._evidence(handle)
            await self._loop(handle, evidence)
            answer = await self._final_answer(handle, evidence)
            status = "done"
        except asyncio.CancelledError:
            status = "cancelled"
            handle.publish(_event("error", message="run đã bị hủy"))
        except agent.NoData as exc:
            status, error = "error", str(exc)
            handle.publish(_event("error", message=error))
        except agent.ProviderError as exc:
            status, error = "error", str(exc)
            handle.publish(_event("error", message=error))
        except Exception as exc:  # noqa: BLE001 — mot run loi khong duoc lam sap api
            log.exception("run %s lỗi", handle.run_id)
            status, error = "error", f"lỗi nội bộ khi chạy agent: {_clip(type(exc).__name__)}"
            handle.publish(_event("error", message=error))
        finally:
            handle.status = status
            handle.error = error
            if answer is not None:
                handle.answer = answer
            try:
                if status == "cancelled":
                    await asyncio.shield(self._finish(handle, status, error))
                else:
                    await self._finish(handle, status, error)
            except asyncio.CancelledError:
                pass
            except Exception:  # noqa: BLE001 — khong ghi duoc DB thi van bao cho client
                log.exception("run %s: không ghi được trạng thái cuối", handle.run_id)

    async def _finish(self, handle: RunHandle, status: str, error: str | None) -> None:
        try:
            await db.finish_agent_run(
                self.pool, handle.run_id, status, handle.model_answer,
                handle.tokens_in, handle.tokens_out, error)
        except Exception as exc:  # noqa: BLE001
            log.warning("run %s: không cập nhật agent_run: %s", handle.run_id, exc)
        elapsed_ms = int((time.perf_counter() - handle.started) * 1000)
        if status == "done" and handle.answer is not None:
            handle.publish(_event(
                "answer", text=handle.answer, model_used=handle.model_answer,
                tokens_in=handle.tokens_in, tokens_out=handle.tokens_out,
                steps=handle.steps, elapsed_ms=elapsed_ms))
        handle.publish(_event(
            "done", run_id=handle.run_id, status=status,
            model_used=handle.model_answer, tokens_in=handle.tokens_in,
            tokens_out=handle.tokens_out, steps=handle.steps,
            elapsed_ms=elapsed_ms, error=error))

    async def _evidence(self, handle: RunHandle) -> dict[str, Any]:
        """Nen + summary tai thoi diem chay; cung la buoc kiem tra 404 som."""
        candles, summary = await agent.load_context(
            self.pool, self.settings, handle.symbol, handle.timeframe)
        return {"summary": summary, "candles": candles, "notes": [], "draft": ""}

    async def _loop(self, handle: RunHandle, evidence: dict[str, Any]) -> None:
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": TOOL_SYSTEM_PROMPT},
            {"role": "user", "content": (
                f"Dữ liệu: {handle.symbol} khung {handle.timeframe}. Dùng tool để lấy bằng chứng "
                f"rồi trả lời ngắn. Tối đa {agent.MAX_TOOL_STEPS} bước tool.")},
        ]
        for step_idx in range(1, agent.MAX_TOOL_STEPS + 1):
            if handle.cancel.is_set():
                raise asyncio.CancelledError
            step_started = time.perf_counter()
            try:
                result = await agent.chat(
                    messages, self.settings, model=handle.model_tool, tools=tools.TOOL_SPECS)
            except agent.ProviderError as exc:
                # Mot lan 429 giua vong lap khong duoc giet ca run: cho ngan (Retry-After
                # neu co) roi thu lai dung mot lan. Van loi thi dung lay tool, giu bang
                # chung da co va de cau tra loi cuoi chay tren phan da thu duoc.
                delay = _retry_delay(exc)
                log.warning("run %s bước %s: provider lỗi (%s), thử lại sau %.1fs",
                            handle.run_id, step_idx, _clip(str(exc)), delay)
                await _pause(delay)
                try:
                    result = await agent.chat(
                        messages, self.settings, model=handle.model_tool, tools=tools.TOOL_SPECS)
                except agent.ProviderError as exc2:
                    log.warning("run %s bước %s: provider lỗi lần 2 (%s), dừng lấy tool",
                                handle.run_id, step_idx, _clip(str(exc2)))
                    break
            handle.tokens_in += result.prompt_tokens
            handle.tokens_out += result.completion_tokens
            handle.steps = step_idx
            if not result.tool_calls:
                if result.text:
                    evidence["draft"] = result.text
                handle.publish(_event(
                    "step", step=step_idx, model=result.model, tools=[],
                    tokens=result.total_tokens, latency_ms=result.latency_ms))
                await db.insert_agent_step(
                    self.pool, handle.run_id, step_idx, "tool", None, "{}",
                    _dump({"draft": _clip(result.text, MAX_TOOL_MESSAGE_CHARS)}),
                    result.total_tokens, result.latency_ms)
                break
            calls = result.tool_calls[:MAX_TOOLS_PER_STEP]
            messages.append(_assistant_message(result.text, calls))
            handle.publish(_event(
                "step", step=step_idx, model=result.model,
                tools=[call["name"] for call in calls],
                tokens=result.total_tokens, latency_ms=result.latency_ms))
            results: list[dict[str, Any]] = []
            for call in calls:
                args = tools.parse_args(call["arguments"])
                output = await tools.execute(self.pool, self.settings, call["name"], args)
                results.append({"tool": call["name"], "args": args, "result": output})
                messages.append({
                    "role": "tool", "tool_call_id": call["id"],
                    "content": _dump(output, MAX_TOOL_MESSAGE_CHARS, keep="tail"),
                })
                handle.publish(_event(
                    "tool_result", step=step_idx, tool=call["name"], args=args, result=output))
                if call["name"] != "get_candles":
                    evidence["notes"].append({"tool": call["name"], "args": args, "result": output})
            latency_ms = int((time.perf_counter() - step_started) * 1000)
            await db.insert_agent_step(
                self.pool, handle.run_id, step_idx, "tool",
                calls[0]["name"] if len(calls) == 1 else f"{len(calls)} tools",
                _dump([{"tool": c["name"], "args": tools.parse_args(c["arguments"])} for c in calls]),
                # Khong cat chuoi JSON da serialize: cat truoc ::jsonb se tao JSON hong
                # (get_candles 120 nen ~8 KB, jsonb chiu duoc).
                _dump(results), result.total_tokens, latency_ms)
            _trim_loop(messages)

    async def _final_answer(self, handle: RunHandle, evidence: dict[str, Any]) -> str:
        prompt = build_answer_prompt(
            handle.symbol, handle.timeframe, evidence,
            agent.prompt_char_budget(handle.model_answer,
                                     self.settings.llm_max_output_tokens))
        last: Exception | None = None
        for _attempt in (1, 2):
            try:
                completion = await agent.complete(
                    prompt, self.settings, model=handle.model_answer)
                handle.tokens_in += completion.prompt_tokens
                handle.tokens_out += completion.completion_tokens
                handle.model_answer = completion.model
                await db.insert_agent_step(
                    self.pool, handle.run_id, handle.steps, "answer", None,
                    "{}", _dump({"text": completion.text, "model_used": completion.model})[:4_000],
                    completion.total_tokens, 0)
                return completion.text
            except agent.ProviderError as exc:
                last = exc
                log.warning("run %s: model trả lời lỗi (%s)", handle.run_id, _clip(str(exc)))
        # qwen loi 2 lan: fallback sang model tool, ghi ro model_used.
        completion = await agent.complete(
            prompt, self.settings, model=handle.model_tool)
        handle.tokens_in += completion.prompt_tokens
        handle.tokens_out += completion.completion_tokens
        handle.model_answer = completion.model
        await db.insert_agent_step(
            self.pool, handle.run_id, handle.steps, "answer", None,
            "{}", _dump({"text": completion.text, "model_used": completion.model})[:4_000],
            completion.total_tokens, 0)
        if last is not None:
            log.info("run %s: fallback câu trả lời sang %s", handle.run_id, completion.model)
        return completion.text


def build_answer_prompt(symbol: str, timeframe: str, evidence: dict[str, Any],
                        limit: int | None = None) -> str:
    """Prompt cau tra loi cuoi: summary bat buoc + bang chung tool nen + it nen gan nhat."""
    limit = agent.prompt_char_budget(None) if limit is None else int(limit)
    tail = "\n\n" + ANSWER_RULES
    head = (f"symbol: {symbol} | khung: {timeframe} | "
            f"số bước tool: {len(evidence.get('notes') or [])}\n")
    body = "DỮ LIỆU ĐÃ NÉN\nsummary: " + agent.summary_line(evidence["summary"]) + "\n"
    used = len(head) + len(body) + len(tail)
    draft = (evidence.get("draft") or "").strip()
    if draft:
        line = "\nGHI CHÚ TỪ BƯỚC TOOL\n" + _clip(draft, MAX_DRAFT_CHARS) + "\n"
        if used + len(line) <= limit - 120:
            body += line
            used += len(line)
    notes = (evidence.get("notes") or [])[-MAX_EVIDENCE_NOTES:]
    if notes:
        body += "\nBẰNG CHỨNG TOOL\n"
        used += len("\nBẰNG CHỨNG TOOL\n")
    for note in notes:
        line = f"[{note['tool']}] {_dump(note.get('args') or {})} -> " \
               f"{_dump(note['result'], MAX_EVIDENCE_NOTE_CHARS)}\n"
        if used + len(line) > limit - 120:
            break
        body += line
        used += len(line)
    rows: list[str] = []
    for candle in reversed((evidence.get("candles") or [])[-MAX_ANSWER_CANDLES:]):
        line = agent.candle_table([candle]) + "\n"
        if used + len(line) > limit - len(tail) - 40:
            break
        rows.append(line)
        used += len(line)
    if rows:
        body += "\nNẾN GẦN NHẤT (mới nhất ở cuối)\n" + "".join(reversed(rows))
    return head + body + tail


async def event_stream(manager: RunManager, run_id: int, request: Any) -> Any:
    """SSE: replay su kien da co roi day tiep; duoi 15s khong co gi thi heartbeat."""
    handle = manager.get(run_id)
    queue = handle.subscribe() if handle is not None else None

    async def generate():
        last_seq = 0
        try:
            if handle is None:
                row = await db.fetch_agent_run(manager.pool, run_id)
                if row is None:
                    yield sse(_event("error", message="không tìm thấy run"))
                    return
                yield sse(_event("snapshot", run=row))
                return
            for event in list(handle.events):
                last_seq = max(last_seq, int(event.get("seq", 0)))
                yield sse(event)
            if handle.status != "running":
                return
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
                    continue
                if int(event.get("seq", 0)) <= last_seq:
                    continue
                last_seq = int(event.get("seq", 0))
                yield sse(event)
                if event.get("type") == "done":
                    break
        finally:
            if queue is not None and handle is not None:
                handle.unsubscribe(queue)

    return generate()
