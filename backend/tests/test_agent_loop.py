"""Agent buoc 2: tool doc-only, vong lap tool-calling, SSE, cancel, endpoint.

Tat ca deu chay tren fake: khong goi mang, khong cham DB that.
"""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from marketlab_web import agent, api, metrics, runs, tools

FAKE_KEY = "gsk_buoc_hai_bi_mat_987"


def make_candles(count: int, start_price: float = 100_000.0) -> list[dict]:
    rows = []
    for i in range(count):
        price = start_price + i * 0.123456789
        rows.append({
            "ts": f"2026-11-{1 + i // 24:02d}T{i % 24:02d}:00:00+00:00",
            "open": price,
            "high": price + 1.25,
            "low": price - 1.25,
            "close": price + 0.5,
            "volume": 1234.5678 + i * 3.75,
        })
    return rows


def settings(**over) -> SimpleNamespace:
    base = dict(
        venue="binance",
        llm_api_key=FAKE_KEY,
        llm_base_url="https://api.groq.com/openai/v1",
        llm_model="qwen/qwen3.8-27b",
        llm_model_tool="openai/gpt-oss-120b",
        llm_timeout_seconds=30.0,
        llm_max_output_tokens=700,
        llm_reasoning_effort="low",
    )
    base.update(over)
    return SimpleNamespace(**base)


# ---------- tool doc-only ----------

def test_tool_specs_are_read_only_and_bounded():
    assert tools.TOOL_NAMES == ("get_watchlist", "get_summary", "get_candles",
                                "get_indicator_series")
    for spec in tools.TOOL_SPECS:
        assert spec["type"] == "function"
        assert spec["function"]["name"] in tools.TOOL_NAMES
    candles = next(s for s in tools.TOOL_SPECS if s["function"]["name"] == "get_candles")
    limit = candles["function"]["parameters"]["properties"]["limit"]
    assert limit["minimum"] == 2 and limit["maximum"] == tools.MAX_CANDLES_PER_CALL == 120


def install_rows(monkeypatch, rows: list[dict], seen: dict) -> None:
    async def fetch_candles(_pool, venue, symbol, timeframe, limit):
        seen["ungrouped"] = (venue, symbol, timeframe, limit)
        return rows[-limit:]

    async def fetch_rollup(_pool, view, venue, symbol, limit):
        seen["rollup"] = (view, venue, symbol, limit)
        return rows[-limit:]

    monkeypatch.setattr(tools.db, "fetch_candles", fetch_candles)
    monkeypatch.setattr(tools.db, "fetch_rollup", fetch_rollup)


@pytest.mark.asyncio
async def test_get_candles_clamps_limit_and_uses_rollup(monkeypatch):
    seen: dict = {}
    install_rows(monkeypatch, make_candles(400), seen)
    result = await tools.execute(object(), settings(), "get_candles",
                                 {"symbol": "btc/usdt", "timeframe": "4h", "limit": 9999})
    assert seen["rollup"] == ("candle_4h", "binance", "BTC/USDT", 120)
    assert result["count"] <= tools.MAX_CANDLES_PER_CALL
    first = result["rows"][0]
    assert len(first) == 6 and isinstance(first[1], float)


@pytest.mark.asyncio
async def test_get_candles_rejects_bad_limit_and_timeframe(monkeypatch):
    install_rows(monkeypatch, make_candles(10), {})
    bad_limit = await tools.execute(object(), settings(), "get_candles",
                                    {"symbol": "BTC/USDT", "timeframe": "1h", "limit": 1})
    assert "limit" in bad_limit["error"]
    bad_tf = await tools.execute(object(), settings(), "get_candles",
                                 {"symbol": "BTC/USDT", "timeframe": "5m"})
    assert "không được hỗ trợ" in bad_tf["error"]


@pytest.mark.asyncio
async def test_get_summary_returns_metrics(monkeypatch):
    seen: dict = {}
    install_rows(monkeypatch, make_candles(80), seen)
    result = await tools.execute(object(), settings(), "get_summary",
                                 {"symbol": "btc/usdt", "timeframe": "1h"})
    assert seen["ungrouped"][3] == tools.SUMMARY_WINDOW == 500
    assert result["summary"]["observations"] == 80
    assert "sharpe" in result["summary"] and "max_drawdown" in result["summary"]


@pytest.mark.asyncio
async def test_get_watchlist_caps_entries(monkeypatch):
    entries = [
        {"symbol": f"S{i}/USDT", "timeframe": "1h", "last_close": 1.0,
         "delta": 0.01, "candles": 10}
        for i in range(tools.MAX_WATCHLIST + 5)
    ]

    async def fake_watchlist(_pool):
        return entries

    monkeypatch.setattr(tools.db, "fetch_watchlist", fake_watchlist)
    result = await tools.execute(object(), settings(), "get_watchlist", {})
    assert result["count"] == len(entries)
    assert len(result["entries"]) == tools.MAX_WATCHLIST


@pytest.mark.asyncio
@pytest.mark.parametrize("indicator", list(metrics.INDICATORS))
async def test_indicator_series_reuses_metrics_definitions(monkeypatch, indicator):
    seen: dict = {}
    install_rows(monkeypatch, make_candles(200), seen)
    result = await tools.execute(object(), settings(), "get_indicator_series",
                                 {"symbol": "BTC/USDT", "timeframe": "1h",
                                  "indicator": indicator, "period": 14})
    assert result["indicator"] == indicator and result["period"] == 14
    assert len(result["points"]) == tools.MAX_INDICATOR_POINTS
    assert all(len(point) == 2 for point in result["points"])


@pytest.mark.asyncio
async def test_indicator_series_rejects_unknown_indicator(monkeypatch):
    install_rows(monkeypatch, make_candles(100), {})
    result = await tools.execute(object(), settings(), "get_indicator_series",
                                 {"symbol": "BTC/USDT", "timeframe": "1h", "indicator": "rsi"})
    assert "không hỗ trợ" in result["error"]


@pytest.mark.asyncio
async def test_unknown_tool_and_broken_arguments_stay_inside_run(monkeypatch):
    result = await tools.execute(object(), settings(), "drop_table", {})
    assert "không tồn tại" in result["error"]
    assert tools.parse_args("{hong") == {}
    assert tools.parse_args("[1,2]") == {}
    assert tools.parse_args('{"symbol":"BTC/USDT"}') == {"symbol": "BTC/USDT"}


# ---------- vong lap ----------

def chat_result(text: str = "", calls: tuple = (), model: str = "openai/gpt-oss-120b",
                tokens: tuple[int, int] = (50, 10)) -> agent.ChatResult:
    prompt, completion = tokens
    return agent.ChatResult(text=text, tool_calls=list(calls), model=model,
                            prompt_tokens=prompt, completion_tokens=completion,
                            total_tokens=prompt + completion, latency_ms=11)


def tool_call(name: str, args: dict | None = None, call_id: str = "call_1") -> dict:
    return {"id": call_id, "name": name, "arguments": json.dumps(args or {})}


def install_chat(monkeypatch, script: list[object]) -> list[dict]:
    calls: list[dict] = []

    async def fake_chat(messages, _settings, model=None, tools=None, max_output_tokens=None):
        calls.append({"messages": json.loads(json.dumps(messages)), "model": model,
                      "tools": tools})
        item = script[min(len(calls) - 1, len(script) - 1)]
        if isinstance(item, BaseException):
            raise item
        return item

    monkeypatch.setattr(runs.agent, "chat", fake_chat)
    return calls


def install_complete(monkeypatch, outcomes: list[object]) -> list[dict]:
    calls: list[dict] = []

    async def fake_complete(prompt, _settings, model=None, max_output_tokens=None):
        calls.append({"prompt": prompt, "model": model})
        item = outcomes[min(len(calls) - 1, len(outcomes) - 1)]
        if isinstance(item, BaseException):
            raise item
        return agent.Completion(str(item), model or "m", 80, 40, 120, {})

    monkeypatch.setattr(runs.agent, "complete", fake_complete)
    return calls


DB_CALLS: dict = {}


def install_db(monkeypatch, run_id: int = 7) -> dict:
    calls: dict = {"steps": [], "finished": [], "created": []}
    DB_CALLS.clear()
    DB_CALLS.update(calls)

    async def create(_pool, symbol, timeframe, model_tool, model_answer):
        calls["created"].append((symbol, timeframe, model_tool, model_answer))
        return run_id

    async def finish(_pool, rid, status, model_answer, tokens_in, tokens_out, error):
        calls["finished"].append({"run_id": rid, "status": status,
                                  "model_answer": model_answer, "tokens_in": tokens_in,
                                  "tokens_out": tokens_out, "error": error})

    async def insert(_pool, rid, step_idx, kind, tool_name, args_json, result_json,
                     tokens, latency_ms):
        calls["steps"].append({"run_id": rid, "step_idx": step_idx, "kind": kind,
                               "tool_name": tool_name, "args": args_json,
                               "result": result_json, "tokens": tokens})

    monkeypatch.setattr(runs.db, "create_agent_run", create)
    monkeypatch.setattr(runs.db, "finish_agent_run", finish)
    monkeypatch.setattr(runs.db, "insert_agent_step", insert)
    return calls


def make_manager(monkeypatch) -> runs.RunManager:
    async def fake_load(_pool, _settings, symbol, timeframe):
        rows = make_candles(60)
        return rows, metrics.summary(rows, timeframe)

    monkeypatch.setattr(runs.agent, "load_context", fake_load)
    install_db(monkeypatch)
    return runs.RunManager(object(), settings())


def install_execute(monkeypatch) -> list[tuple[str, dict]]:
    executed: list[tuple[str, dict]] = []

    async def fake_execute(_pool, _settings, name, args):
        executed.append((name, args))
        return {"tool": name, "ok": True}

    monkeypatch.setattr(runs.tools, "execute", fake_execute)
    return executed


@pytest.mark.asyncio
async def test_loop_calls_tools_in_order_then_final_answer(monkeypatch):
    manager = make_manager(monkeypatch)
    executed = install_execute(monkeypatch)
    chat_calls = install_chat(monkeypatch, [
        chat_result(calls=(tool_call("get_summary",
                                     {"symbol": "BTC/USDT", "timeframe": "1h"}, "c1"),)),
        chat_result(calls=(tool_call("get_candles",
                                     {"symbol": "BTC/USDT", "timeframe": "1h", "limit": 20},
                                     "c2"),)),
        chat_result(text="Đủ dữ liệu để trả lời."),
    ])
    complete_calls = install_complete(monkeypatch, ["Câu trả lời cuối."])

    handle = await manager.create("BTC/USDT", "1h")
    await handle.task

    assert handle.status == "done"
    assert [name for name, _ in executed] == ["get_summary", "get_candles"]
    assert [call["model"] for call in chat_calls] == ["openai/gpt-oss-120b"] * 3
    assert chat_calls[0]["tools"] is tools.TOOL_SPECS
    second = chat_calls[1]["messages"]
    assert second[-2]["role"] == "assistant"
    assert second[-2]["tool_calls"][0]["id"] == "c1"
    assert second[-1]["role"] == "tool" and second[-1]["tool_call_id"] == "c1"

    assert [event["type"] for event in handle.events] == [
        "step", "tool_result", "step", "tool_result", "step", "answer", "done"]
    assert [event["seq"] for event in handle.events] == list(range(1, 8))
    assert handle.events[0]["tools"] == ["get_summary"]
    assert handle.events[1]["result"] == {"tool": "get_summary", "ok": True}

    assert complete_calls[0]["model"] == "qwen/qwen3.8-27b"
    prompt = complete_calls[0]["prompt"]
    assert "total_return=" in prompt and "sharpe=" in prompt and "max_drawdown=" in prompt
    assert "GHI CHÚ TỪ BƯỚC TOOL" in prompt
    assert handle.answer == "Câu trả lời cuối."
    assert DB_CALLS["created"] == [("BTC/USDT", "1h", "openai/gpt-oss-120b",
                                    "qwen/qwen3.8-27b")]
    assert [step["kind"] for step in DB_CALLS["steps"]] == ["tool", "tool", "tool", "answer"]
    assert DB_CALLS["finished"][-1]["status"] == "done"
    assert DB_CALLS["finished"][-1]["tokens_in"] > 0


@pytest.mark.asyncio
async def test_get_candles_step_is_stored_as_valid_json(monkeypatch):
    """Khong cat chuoi JSON da serialize: 60 nen (~5 KB) phai parse lai duoc tu cot jsonb."""
    manager = make_manager(monkeypatch)
    rows = make_candles(60)
    payload = {
        "count": len(rows),
        "rows": [[c["ts"], c["open"], c["high"], c["low"], c["close"], c["volume"]]
                 for c in rows],
    }

    async def fake_execute(_pool, _settings, name, args):
        return payload

    monkeypatch.setattr(runs.tools, "execute", fake_execute)
    install_chat(monkeypatch, [
        chat_result(calls=(tool_call("get_candles",
                                     {"symbol": "BTC/USDT", "timeframe": "1h"}, "c1"),)),
        chat_result(text="draft"),
    ])
    install_complete(monkeypatch, ["ok"])

    handle = await manager.create("BTC/USDT", "1h")
    await handle.task

    assert handle.status == "done"
    step = next(item for item in DB_CALLS["steps"]
                if item["kind"] == "tool" and item["tool_name"] == "get_candles")
    stored = json.loads(step["result"])  # truoc day cat [:4_000] lam JSON hong
    assert len(step["result"]) > 4_000
    assert stored[0]["tool"] == "get_candles"
    assert len(stored[0]["result"]["rows"]) == 60


def test_trim_loop_keeps_user_message_and_never_orphans_tools():
    user = {"role": "user",
            "content": "Dữ liệu: BTC/USDT khung 1h. Tối đa 6 bước tool."}
    messages: list[dict] = [{"role": "system", "content": "sys"}, user]
    for step in range(1, 7):
        messages.append(runs._assistant_message(
            "", [tool_call("get_summary", {"symbol": "BTC/USDT"}, f"c{step}")]))
        messages.append({"role": "tool", "tool_call_id": f"c{step}",
                         "content": "x" * runs.MAX_TOOL_MESSAGE_CHARS})
        runs._trim_loop(messages)
        assert messages[0]["role"] == "system"
        assert messages[1] == user  # symbol/khung/buoc tool khong bi xoa
        assert len(messages) < 14   # da thuc su cat bot luot cu
        if len(messages) > 2:
            assert messages[2]["role"] == "assistant"
        open_ids: set[str] = set()
        for message in messages[2:]:
            if message["role"] == "assistant":
                open_ids = {call["id"] for call in message["tool_calls"]}
            else:
                assert message["tool_call_id"] in open_ids
    assert len(runs._dump(messages)) <= runs.MAX_LOOP_MESSAGE_CHARS


def test_retry_delay_uses_retry_after_and_caps():
    assert runs._retry_delay(agent.ProviderError("429")) == runs.RETRY_DEFAULT_SECONDS
    assert runs._retry_delay(
        agent.ProviderError("429", retry_after=3.0)) == 3.0
    assert runs._retry_delay(
        agent.ProviderError("429", retry_after=120.0)) == runs.RETRY_MAX_SECONDS


def test_answer_rules_use_iso_dates_matching_data():
    assert "yyyy-mm-dd hh:mm (UTC)" in runs.ANSWER_RULES
    assert "dd-mm hh:mm" not in runs.ANSWER_RULES


@pytest.mark.asyncio
async def test_loop_retries_rate_limit_once_then_continues(monkeypatch):
    manager = make_manager(monkeypatch)
    install_execute(monkeypatch)
    delays: list[float] = []

    async def fake_pause(seconds):
        delays.append(seconds)

    monkeypatch.setattr(runs, "_pause", fake_pause)
    chat_calls = install_chat(monkeypatch, [
        agent.ProviderError("nhà cung cấp báo vượt hạn mức (429)", retry_after=3.0),
        chat_result(calls=(tool_call("get_summary",
                                     {"symbol": "BTC/USDT", "timeframe": "1h"}, "c1"),)),
        chat_result(text="draft"),
    ])
    install_complete(monkeypatch, ["ok"])

    handle = await manager.create("BTC/USDT", "1h")
    await handle.task

    assert delays == [3.0]
    assert len(chat_calls) == 3
    assert handle.status == "done"
    assert handle.steps == 2
    assert [event["type"] for event in handle.events] == [
        "step", "tool_result", "step", "answer", "done"]


@pytest.mark.asyncio
async def test_loop_rate_limit_twice_answers_from_existing_evidence(monkeypatch):
    manager = make_manager(monkeypatch)
    install_execute(monkeypatch)
    delays: list[float] = []

    async def fake_pause(seconds):
        delays.append(seconds)

    monkeypatch.setattr(runs, "_pause", fake_pause)
    rate = agent.ProviderError("nhà cung cấp báo vượt hạn mức (429)")
    chat_calls = install_chat(monkeypatch, [rate, rate])
    complete_calls = install_complete(monkeypatch, ["Trả lời trên dữ liệu đã có."])

    handle = await manager.create("BTC/USDT", "1h")
    await handle.task

    assert delays == [runs.RETRY_DEFAULT_SECONDS]
    assert len(chat_calls) == 2  # dung mot lan thu lai, khong quay vong
    assert handle.status == "done"
    assert handle.steps == 0
    assert "summary: " in complete_calls[0]["prompt"]
    assert handle.answer == "Trả lời trên dữ liệu đã có."
    assert DB_CALLS["finished"][-1]["status"] == "done"


@pytest.mark.asyncio
async def test_loop_stops_after_max_steps(monkeypatch):
    manager = make_manager(monkeypatch)
    install_execute(monkeypatch)
    chat_calls = install_chat(monkeypatch, [
        chat_result(calls=(tool_call("get_summary",
                                     {"symbol": "BTC/USDT", "timeframe": "1h"}),)),
    ])
    install_complete(monkeypatch, ["Tổng hợp sau 6 bước."])

    handle = await manager.create("BTC/USDT", "1h")
    await handle.task

    assert len(chat_calls) == agent.MAX_TOOL_STEPS == 6
    assert handle.steps == 6
    assert handle.status == "done"
    assert sum(1 for event in handle.events if event["type"] == "step") == 6
    assert [event["type"] for event in handle.events][-2:] == ["answer", "done"]


@pytest.mark.asyncio
async def test_loop_breaks_early_when_model_answers(monkeypatch):
    manager = make_manager(monkeypatch)
    install_execute(monkeypatch)
    chat_calls = install_chat(monkeypatch, [chat_result(text="Nhận định sơ bộ từ tool.")])
    complete_calls = install_complete(monkeypatch, ["Câu trả lời cuối."])

    handle = await manager.create("BTC/USDT", "1h")
    await handle.task

    assert len(chat_calls) == 1 and handle.steps == 1
    assert "Nhận định sơ bộ từ tool." in complete_calls[0]["prompt"]
    assert [event["type"] for event in handle.events] == ["step", "answer", "done"]
    assert [step["kind"] for step in DB_CALLS["steps"]] == ["tool", "answer"]


@pytest.mark.asyncio
async def test_final_answer_falls_back_to_tool_model(monkeypatch):
    manager = make_manager(monkeypatch)
    install_execute(monkeypatch)
    install_chat(monkeypatch, [chat_result(text="draft")])
    complete_calls = install_complete(monkeypatch, [
        agent.ProviderError("429"),
        agent.ProviderError("429"),
        "Câu trả lời từ model tool.",
    ])

    handle = await manager.create("BTC/USDT", "1h")
    await handle.task

    assert [call["model"] for call in complete_calls] == [
        "qwen/qwen3.8-27b", "qwen/qwen3.8-27b", "openai/gpt-oss-120b"]
    assert handle.model_answer == "openai/gpt-oss-120b"
    answer = next(event for event in handle.events if event["type"] == "answer")
    assert answer["model_used"] == "openai/gpt-oss-120b"
    assert answer["text"] == "Câu trả lời từ model tool."
    assert DB_CALLS["finished"][-1]["model_answer"] == "openai/gpt-oss-120b"


@pytest.mark.asyncio
async def test_final_answer_uses_qwen_within_budget(monkeypatch):
    manager = make_manager(monkeypatch)
    install_execute(monkeypatch)
    install_chat(monkeypatch, [chat_result(text="draft " * 200)])
    complete_calls = install_complete(monkeypatch, ["ok"])

    handle = await manager.create("BTC/USDT", "1h")
    await handle.task

    prompt = complete_calls[0]["prompt"]
    assert len(prompt) <= agent.prompt_char_budget("qwen/qwen3.8-27b")
    assert agent.worst_case_tokens(prompt, "qwen/qwen3.8-27b") <= agent.TPM_CEILING
    assert prompt.rstrip().endswith(runs.ANSWER_RULES.strip())
    assert "YÊU CẦU" in prompt
    assert "yyyy-mm-dd hh:mm (UTC)" in prompt


def test_answer_prompt_fits_both_models():
    evidence = {
        "summary": metrics.summary(make_candles(60), "1h"),
        "candles": make_candles(60),
        "notes": [{"tool": "get_summary", "args": {"symbol": "BTC/USDT"},
                   "result": {"summary": {"sharpe": 1.2}}}],
        "draft": "nhận định " * 300,
    }
    for model in ("qwen/qwen3.8-27b", "openai/gpt-oss-120b"):
        limit = agent.prompt_char_budget(model)
        prompt = runs.build_answer_prompt("BTC/USDT", "1h", evidence, limit=limit)
        assert len(prompt) <= limit
        assert agent.worst_case_tokens(prompt, model) <= agent.TPM_CEILING
        assert "summary: " in prompt and "max_drawdown=" in prompt


@pytest.mark.asyncio
async def test_events_and_steps_never_contain_api_key(monkeypatch):
    manager = make_manager(monkeypatch)
    install_execute(monkeypatch)
    install_chat(monkeypatch, [chat_result(text="draft")])
    install_complete(monkeypatch, ["ok"])

    handle = await manager.create("BTC/USDT", "1h")
    await handle.task

    blob = json.dumps(handle.events, default=str) + json.dumps(DB_CALLS, default=str)
    assert FAKE_KEY not in blob
    assert "[redacted]" not in blob


@pytest.mark.asyncio
async def test_cancel_marks_run_cancelled_and_publishes_done(monkeypatch):
    manager = make_manager(monkeypatch)
    started = asyncio.Event()

    async def blocking(*_args, **_kwargs):
        started.set()
        await asyncio.sleep(30)

    monkeypatch.setattr(runs.agent, "chat", blocking)
    install_complete(monkeypatch, ["khong bao gio toi day"])

    handle = await manager.create("BTC/USDT", "1h")
    await asyncio.wait_for(started.wait(), timeout=2)
    status = await manager.cancel(handle.run_id)
    assert status == "cancelled"
    await handle.task

    assert handle.status == "cancelled"
    assert handle.events[-1]["type"] == "done"
    assert handle.events[-1]["status"] == "cancelled"
    assert DB_CALLS["finished"][-1]["status"] == "cancelled"


@pytest.mark.asyncio
async def test_run_without_data_finishes_as_error(monkeypatch):
    manager = make_manager(monkeypatch)

    async def empty(_pool, _settings, symbol, timeframe):
        raise agent.NoData(f"thiếu dữ liệu cho {symbol} {timeframe}")

    monkeypatch.setattr(runs.agent, "load_context", empty)
    handle = await manager.create("BTC/USDT", "1h")
    await handle.task

    assert handle.status == "error"
    assert handle.events[-1]["type"] == "done"
    assert "thiếu dữ liệu" in handle.events[-1]["error"]


# ---------- SSE ----------

class FakeRequest:
    async def is_disconnected(self) -> bool:
        return False


def parse_chunks(chunks: list[str]) -> list[dict]:
    out = []
    for chunk in chunks:
        assert chunk.startswith("data: ")
        out.append(json.loads(chunk[len("data: "):]))
    return out


@pytest.mark.asyncio
async def test_stream_replays_events_in_order(monkeypatch):
    manager = make_manager(monkeypatch)
    install_execute(monkeypatch)
    install_chat(monkeypatch, [chat_result(text="draft")])
    install_complete(monkeypatch, ["ok"])

    handle = await manager.create("BTC/USDT", "1h")
    await handle.task

    stream = await runs.event_stream(manager, handle.run_id, FakeRequest())
    payloads = parse_chunks([chunk async for chunk in stream])
    assert [payload["type"] for payload in payloads] == [
        event["type"] for event in handle.events]
    assert [payload["seq"] for payload in payloads] == list(range(1, len(payloads) + 1))


@pytest.mark.asyncio
async def test_stream_unknown_run_sends_error(monkeypatch):
    manager = make_manager(monkeypatch)

    async def missing(_pool, _run_id):
        return None

    monkeypatch.setattr(runs.db, "fetch_agent_run", missing)
    stream = await runs.event_stream(manager, 999, FakeRequest())
    payloads = parse_chunks([chunk async for chunk in stream])
    assert payloads == [{"type": "error", "message": "không tìm thấy run"}]


@pytest.mark.asyncio
async def test_stream_db_only_run_sends_snapshot(monkeypatch):
    manager = make_manager(monkeypatch)
    row = {"run_id": 5, "symbol": "BTC/USDT", "timeframe": "1h", "status": "done",
           "model_tool": "openai/gpt-oss-120b", "model_answer": "qwen/qwen3.8-27b",
           "tokens_in": 10, "tokens_out": 2, "steps": 1, "answer": "xong",
           "error": None}

    async def stored(_pool, _run_id):
        return row

    monkeypatch.setattr(runs.db, "fetch_agent_run", stored)
    stream = await runs.event_stream(manager, 5, FakeRequest())
    payloads = parse_chunks([chunk async for chunk in stream])
    assert payloads == [{"type": "snapshot", "run": row}]


# ---------- endpoint ----------

class FakeRuns:
    def __init__(self) -> None:
        self.created: list[tuple[str, str]] = []

    async def create(self, symbol: str, timeframe: str):
        self.created.append((symbol, timeframe))
        return SimpleNamespace(run_id=11)


def install_api_state(monkeypatch, **over):
    monkeypatch.setattr(api.app.state, "settings", settings(**over), raising=False)
    manager = FakeRuns()
    monkeypatch.setattr(api.app.state, "runs", manager, raising=False)
    return manager


@pytest.mark.asyncio
async def test_route_creates_run_with_202(monkeypatch):
    manager = install_api_state(monkeypatch)
    monkeypatch.setattr(api.app.state, "pool", object(), raising=False)

    async def probe(*_args):
        return 2

    monkeypatch.setattr(api, "_probe_agent_data", probe)
    result = await api.create_agent_run(api.AnalyzeIn(symbol="btc/usdt", timeframe="4h"))
    assert result == {"run_id": 11, "symbol": "BTC/USDT", "timeframe": "4h"}
    assert manager.created == [("BTC/USDT", "4h")]

    route = next(
        route for route in api.app.routes
        if getattr(route, "path", "") == "/api/agent/runs"
        and "POST" in getattr(route, "methods", set()))
    assert route.status_code == 202


@pytest.mark.asyncio
async def test_route_rejects_bad_symbol_before_touching_pool(monkeypatch):
    install_api_state(monkeypatch)
    monkeypatch.delattr(api.app.state, "pool", raising=False)
    with pytest.raises(HTTPException) as exc:
        await api.create_agent_run(api.AnalyzeIn(symbol="BTC-USD"))
    assert exc.value.status_code == 422


@pytest.mark.asyncio
async def test_route_rejects_unsupported_timeframe(monkeypatch):
    install_api_state(monkeypatch)
    monkeypatch.delattr(api.app.state, "pool", raising=False)
    with pytest.raises(HTTPException) as exc:
        await api.create_agent_run(api.AnalyzeIn(symbol="BTC/USDT", timeframe="5m"))
    assert exc.value.status_code == 422
    assert "không được hỗ trợ" in exc.value.detail


@pytest.mark.asyncio
async def test_route_503_without_key_before_pool(monkeypatch):
    install_api_state(monkeypatch, llm_api_key="")
    monkeypatch.delattr(api.app.state, "pool", raising=False)
    with pytest.raises(HTTPException) as exc:
        await api.create_agent_run(api.AnalyzeIn(symbol="BTC/USDT"))
    assert exc.value.status_code == 503
    assert "LLM_API_KEY" in exc.value.detail


@pytest.mark.asyncio
async def test_route_404_when_warehouse_has_no_data(monkeypatch):
    manager = install_api_state(monkeypatch)
    monkeypatch.setattr(api.app.state, "pool", object(), raising=False)

    async def probe(*_args):
        return 1

    monkeypatch.setattr(api, "_probe_agent_data", probe)
    with pytest.raises(HTTPException) as exc:
        await api.create_agent_run(api.AnalyzeIn(symbol="BTC/USDT"))
    assert exc.value.status_code == 404
    assert "thiếu dữ liệu" in exc.value.detail
    assert manager.created == []


@pytest.mark.asyncio
async def test_get_unknown_run_returns_404(monkeypatch):
    monkeypatch.setattr(api.app.state, "pool", object(), raising=False)
    monkeypatch.delattr(api.app.state, "runs", raising=False)

    async def missing(_pool, _run_id):
        return None

    monkeypatch.setattr(api.db, "fetch_agent_run", missing)
    with pytest.raises(HTTPException) as exc:
        await api.get_agent_run(999)
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_stream_route_503_without_manager(monkeypatch):
    monkeypatch.delattr(api.app.state, "runs", raising=False)
    with pytest.raises(HTTPException) as exc:
        await api.stream_agent_run(1, FakeRequest())
    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_stream_route_404_for_unknown_run(monkeypatch):
    monkeypatch.setattr(api.app.state, "runs",
                        SimpleNamespace(get=lambda _run_id: None), raising=False)
    monkeypatch.setattr(api.app.state, "pool", object(), raising=False)

    async def missing(_pool, _run_id):
        return None

    monkeypatch.setattr(api.db, "fetch_agent_run", missing)
    with pytest.raises(HTTPException) as exc:
        await api.stream_agent_run(42, FakeRequest())
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_cancel_returns_status_and_finished_run_is_not_cancellable(monkeypatch):
    class Manager:
        async def cancel(self, _run_id):
            return "cancelled"

    monkeypatch.setattr(api.app.state, "runs", Manager(), raising=False)
    result = await api.cancel_agent_run(3)
    assert result == {"run_id": 3, "status": "cancelled", "cancelled": True}

    monkeypatch.delattr(api.app.state, "runs", raising=False)
    monkeypatch.setattr(api.app.state, "pool", object(), raising=False)

    async def stored(_pool, _run_id):
        return {"run_id": 3, "status": "done"}

    monkeypatch.setattr(api.db, "fetch_agent_run", stored)
    result = await api.cancel_agent_run(3)
    assert result == {"run_id": 3, "status": "done", "cancelled": False}


@pytest.mark.asyncio
async def test_cancel_unknown_run_returns_404(monkeypatch):
    monkeypatch.delattr(api.app.state, "runs", raising=False)
    monkeypatch.setattr(api.app.state, "pool", object(), raising=False)

    async def missing(_pool, _run_id):
        return None

    monkeypatch.setattr(api.db, "fetch_agent_run", missing)
    with pytest.raises(HTTPException) as exc:
        await api.cancel_agent_run(404)
    assert exc.value.status_code == 404
