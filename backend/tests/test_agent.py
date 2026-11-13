"""Agent buoc 1: nen prompt, tran token va cac duong loi (khong goi mang that)."""
from __future__ import annotations

import json
from types import SimpleNamespace

import openai
import pytest
from fastapi import HTTPException
from openai._base_client import httpx2

from marketlab_web import agent, api, metrics

FAKE_KEY = "gsk_gia_khoa_bi_mat_123"
PROVIDER_URL = "https://api.groq.com/openai/v1/chat/completions"


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
        llm_api_key="khoa-gia-test",
        llm_base_url="https://api.groq.com/openai/v1",
        llm_model="openai/gpt-oss-20b",
        llm_model_tool="openai/gpt-oss-120b",
        llm_timeout_seconds=30.0,
        llm_max_output_tokens=700,
        llm_reasoning_effort="low",
    )
    base.update(over)
    return SimpleNamespace(**base)


# ---------- nen prompt ----------

@pytest.mark.parametrize("model", [None, "qwen/qwen3.8-27b", "openai/gpt-oss-120b"])
def test_prompt_fits_token_budget_with_full_window(model):
    candles = make_candles(500)
    summary = metrics.summary(candles, "1h")
    prompt, used = agent.build_prompt("BTC/USDT", "1h", candles, summary, model=model)
    assert used == agent.MAX_PROMPT_CANDLES == 40
    assert len(prompt) <= agent.prompt_char_budget(model)
    assert agent.worst_case_tokens(prompt, model) <= agent.TPM_CEILING
    assert "BTC/USDT" in prompt
    assert "total_return=" in prompt


def test_prompt_keeps_only_recent_candles():
    candles = make_candles(120)
    summary = metrics.summary(candles, "1h")
    prompt, used = agent.build_prompt("BTC/USDT", "1h", candles, summary)
    assert used == 40
    newest_line = agent.candle_table(candles[-40:]).splitlines()[0]
    dropped_line = agent.candle_table(candles[:80]).splitlines()[0]
    assert newest_line in prompt
    assert dropped_line not in prompt


def test_prompt_drops_oldest_rows_when_budget_is_tight():
    candles = make_candles(40)
    summary = metrics.summary(candles, "1h")
    full, _ = agent.build_prompt("BTC/USDT", "1h", candles, summary)
    line_len = len(agent.candle_table(candles[-1:]))
    tight, used = agent.build_prompt("BTC/USDT", "1h", candles, summary,
                                     max_chars=len(full) - 2 * line_len - 10)
    assert 2 <= used < 40
    assert len(tight) <= len(full)
    assert agent.estimate_tokens(tight) < agent.estimate_tokens(full)


def test_prompt_needs_at_least_two_candles():
    candles = make_candles(1)
    with pytest.raises(agent.NoData):
        agent.build_prompt("BTC/USDT", "1h", candles, {"observations": 1})


def test_estimate_tokens_uses_model_profile():
    assert agent.estimate_tokens("") == 0
    # qwen: 1,30 ky tu/token; gpt-oss: 1,80.
    assert agent.estimate_tokens("abc", "qwen/qwen3.8-27b") == 3
    assert agent.estimate_tokens("abc", "openai/gpt-oss-120b") == 2
    assert agent.estimate_tokens("a" * 1_300, "qwen/qwen3.8-27b") == 1_000
    assert agent.estimate_tokens("a" * 1_800, "openai/gpt-oss-120b") == 1_000


# ---------- goi nha cung cap ----------

class FakeRaw:
    headers = {"x-ratelimit-limit-tokens": "8000", "x-ratelimit-remaining-tokens": "7999"}

    def parse(self):
        return SimpleNamespace(
            model="openai/gpt-oss-20b",
            choices=[SimpleNamespace(message=SimpleNamespace(
                content="  Nhan dinh ngan  ", tool_calls=None))],
            usage=SimpleNamespace(prompt_tokens=321, completion_tokens=45, total_tokens=366),
        )


class BrokenRaw:
    """200 nhung body khong doc duoc / thieu truong bat buoc."""
    headers: dict = {}

    def __init__(self, exc: BaseException):
        self.exc = exc

    def parse(self):
        raise self.exc


class IncompleteRaw:
    headers: dict = {}

    def parse(self):
        return SimpleNamespace(choices=None)  # thieu model va usage


class FakeCompletions:
    def __init__(self, captured, outcome=None):
        self.captured = captured
        self.outcome = outcome

    @property
    def with_raw_response(self):
        return self

    async def create(self, **kwargs):
        self.captured.update(kwargs)
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome or FakeRaw()


class FakeClient:
    def __init__(self, captured, outcome=None, **kwargs):
        captured["client"] = kwargs
        self.chat = SimpleNamespace(completions=FakeCompletions(captured, outcome))

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


def provider_response(status: int, message: str,
                      headers: dict | None = None) -> httpx2.Response:
    request = httpx2.Request("POST", PROVIDER_URL)
    return httpx2.Response(status, request=request, json={"error": {"message": message}},
                           headers=headers)


def provider_exception(kind: str) -> BaseException:
    """Dung dung lop loi that cua SDK de test mapping, khong goi mang."""
    if kind == "auth":
        message = f"Incorrect API key provided: {FAKE_KEY}"
        return openai.AuthenticationError(
            message, response=provider_response(401, message), body={"error": {"message": message}})
    if kind == "rate":
        message = "Rate limit reached for model gpt-oss-20b on tokens per minute"
        return openai.RateLimitError(
            message, response=provider_response(429, message), body={"error": {"message": message}})
    if kind == "timeout":
        return openai.APITimeoutError(httpx2.Request("POST", PROVIDER_URL))
    raise AssertionError(f"kind la: {kind}")


@pytest.mark.asyncio
async def test_complete_without_key_never_calls_provider():
    with pytest.raises(agent.NotConfigured):
        await agent.complete("prompt", settings(llm_api_key="   "))


@pytest.mark.asyncio
async def test_complete_wires_openai_compatible_params(monkeypatch):
    captured: dict = {}
    monkeypatch.setattr(agent, "AsyncOpenAI", lambda **kw: FakeClient(captured, **kw))
    result = await agent.complete("prompt ngan", settings())
    assert captured["client"]["base_url"] == "https://api.groq.com/openai/v1"
    assert captured["client"]["api_key"] == "khoa-gia-test"
    assert captured["model"] == "openai/gpt-oss-20b"
    assert captured["max_completion_tokens"] == 700
    assert captured["reasoning_effort"] == "low"
    assert captured["messages"][1]["content"] == "prompt ngan"
    assert result.text == "Nhan dinh ngan"
    assert (result.prompt_tokens, result.completion_tokens) == (321, 45)
    assert result.rate_limits["x-ratelimit-limit-tokens"] == "8000"


@pytest.mark.asyncio
async def test_qwen_never_sends_reasoning_effort(monkeypatch):
    """qwen tra 400 neu gui reasoning_effort: chi gpt-oss duoc nhan tham so nay."""
    captured: dict = {}
    monkeypatch.setattr(agent, "AsyncOpenAI", lambda **kw: FakeClient(captured, **kw))
    await agent.complete("prompt ngan", settings(llm_model="qwen/qwen3.8-27b"))
    assert captured["model"] == "qwen/qwen3.8-27b"
    assert "reasoning_effort" not in captured


def install_client(monkeypatch, outcome) -> dict:
    captured: dict = {}
    monkeypatch.setattr(agent, "AsyncOpenAI",
                        lambda **kw: FakeClient(captured, outcome, **kw))
    return captured


@pytest.mark.asyncio
@pytest.mark.parametrize("kind,needle", [
    ("auth", "401"),
    ("rate", "429"),
    ("timeout", "không trả lời kịp"),
])
async def test_provider_failures_become_provider_error(monkeypatch, kind, needle):
    install_client(monkeypatch, provider_exception(kind))
    with pytest.raises(agent.ProviderError) as info:
        await agent.complete("prompt", settings(llm_api_key=FAKE_KEY))
    assert needle in str(info.value)
    # from None: khong mang body loi (co the chua khoa) vao chuoi nhan qua.
    assert info.value.__cause__ is None
    assert info.value.__suppress_context__ is True


@pytest.mark.asyncio
async def test_rate_limit_carries_retry_after_header(monkeypatch):
    message = "Rate limit reached for model qwen on tokens per minute"
    exc = openai.RateLimitError(
        message, response=provider_response(429, message, {"retry-after": "7"}),
        body={"error": {"message": message}})
    install_client(monkeypatch, exc)
    with pytest.raises(agent.ProviderError) as info:
        await agent.complete("prompt", settings())
    assert info.value.retry_after == 7.0


def test_retry_after_seconds_ignores_missing_or_bad_header():
    assert agent._retry_after_seconds(SimpleNamespace()) is None
    assert agent._retry_after_seconds(
        SimpleNamespace(response=SimpleNamespace(headers={}))) is None
    assert agent._retry_after_seconds(
        SimpleNamespace(response=SimpleNamespace(headers={"retry-after": "abc"}))) is None


@pytest.mark.asyncio
async def test_auth_error_never_leaks_key(monkeypatch):
    exc = provider_exception("auth")
    assert FAKE_KEY in str(exc)  # gia lap nha cung cap echo khoa trong body
    install_client(monkeypatch, exc)
    with pytest.raises(agent.ProviderError) as info:
        await agent.complete("prompt", settings(llm_api_key=FAKE_KEY))
    assert FAKE_KEY not in str(info.value)
    assert FAKE_KEY not in repr(info.value)


@pytest.mark.asyncio
async def test_error_body_echo_is_redacted(monkeypatch):
    message = f"400 bad request: api_key={FAKE_KEY} khong hop le"
    exc = openai.APIStatusError(
        message, response=provider_response(400, message), body={"error": {"message": message}})
    install_client(monkeypatch, exc)
    with pytest.raises(agent.ProviderError) as info:
        await agent.complete("prompt", settings(llm_api_key=FAKE_KEY))
    detail = str(info.value)
    assert FAKE_KEY not in detail
    assert "[redacted]" in detail
    assert "400" in detail


@pytest.mark.asyncio
@pytest.mark.parametrize("raw", [BrokenRaw(ValueError("khong phai JSON")), IncompleteRaw()])
async def test_unreadable_200_becomes_provider_error(monkeypatch, raw):
    install_client(monkeypatch, raw)
    with pytest.raises(agent.ProviderError) as info:
        await agent.complete("prompt", settings())
    assert "không đọc được" in str(info.value)


# ---------- ngan sach token ----------

def test_system_prompt_estimate_covers_real_prompt():
    assert agent.estimate_tokens(agent.SYSTEM_PROMPT, "openai/gpt-oss-120b") <= agent.SYSTEM_PROMPT_TOKEN_ESTIMATE
    assert agent.estimate_tokens(agent.SYSTEM_PROMPT, "qwen/qwen3.8-27b") <= agent.SYSTEM_PROMPT_TOKEN_ESTIMATE


def test_profiles_carry_measured_benchmark_limits():
    assert agent.QWEN_PROFILE.chars_per_token == 1.30
    assert agent.QWEN_PROFILE.max_prompt_chars == 4_300
    assert agent.QWEN_PROFILE.supports_reasoning_effort is False
    assert agent.GPT_OSS_PROFILE.chars_per_token == 1.80
    assert agent.GPT_OSS_PROFILE.max_prompt_chars == 6_000
    assert agent.GPT_OSS_PROFILE.supports_reasoning_effort is True
    assert agent.prompt_char_budget("qwen/qwen3.8-27b") == 4_300
    assert agent.prompt_char_budget("openai/gpt-oss-120b") == 6_000


def test_worst_case_turn_fits_tpm_ceiling():
    """Moi model: prompt toi da + system + output + bien an toan phai duoi 8.000 TPM."""
    candles = make_candles(500)
    summary = metrics.summary(candles, "1h")
    for model in ("qwen/qwen3.8-27b", "openai/gpt-oss-120b"):
        prompt, _ = agent.build_prompt("BTC/USDT", "1h", candles, summary, model=model)
        total = (
            agent.SYSTEM_PROMPT_TOKEN_ESTIMATE
            + agent.estimate_tokens(prompt, model)
            + agent.DEFAULT_MAX_OUTPUT_TOKENS
            + agent.SAFETY_MARGIN_TOKENS
        )
        assert len(prompt) <= agent.prompt_char_budget(model)
        assert total <= agent.TPM_CEILING, (model, total)


def test_prompt_budget_shrinks_with_output_allowance():
    assert agent.prompt_char_budget("qwen/qwen3.8-27b") == 4_300
    assert agent.prompt_char_budget("qwen/qwen3.8-27b", 6_000) < 4_300
    assert agent.prompt_char_budget("qwen/qwen3.8-27b", 1_500) == 4_300
    assert agent.prompt_char_budget("qwen/qwen3.8-27b", 50_000) >= agent.MIN_PROMPT_CHARS
    assert agent.prompt_char_budget("openai/gpt-oss-120b", 6_000) < 6_000


def test_hard_cut_fallback_keeps_request_tail():
    """Ngan sach chi con mot dong bang: giu duoi YEU CAU, khong cat phang prompt."""
    candles = make_candles(5)
    summary = metrics.summary(candles, "1h")
    overhead = len(agent._compose("BTC/USDT", "1h", [], summary))
    limit = overhead + len(agent.candle_table(candles[-1:])) + 5
    prompt, used = agent.build_prompt("BTC/USDT", "1h", candles, summary, max_chars=limit)
    assert used == 1
    assert len(prompt) <= limit
    assert "YÊU CẦU:" in prompt
    assert prompt.rstrip().endswith(agent.FOOTER.strip())
    assert agent.candle_table(candles[-1:]) in prompt


# ---------- dieu phoi analyze ----------

@pytest.mark.asyncio
async def test_analyze_compresses_context_and_returns_usage(monkeypatch):
    rows = make_candles(500)

    async def fake_fetch(pool, venue, symbol, timeframe, limit):
        assert (venue, symbol, timeframe, limit) == ("binance", "BTC/USDT", "1h", 500)
        return rows

    async def fake_complete(prompt, _settings, model=None, max_output_tokens=None):
        assert model == "openai/gpt-oss-20b"
        assert len(prompt) <= agent.prompt_char_budget(model)
        return agent.Completion("noi dung", "openai/gpt-oss-20b", 900, 120, 1020, {"a": "b"})

    monkeypatch.setattr(agent.db, "fetch_candles", fake_fetch)
    monkeypatch.setattr(agent, "complete", fake_complete)

    result = await agent.analyze(None, settings(), "BTC/USDT", "1h")
    assert result["candles_used"] == 40
    assert result["usage"] == {"prompt_tokens": 900, "completion_tokens": 120, "total_tokens": 1020}
    assert result["text"] == "noi dung"
    assert result["model"] == "openai/gpt-oss-20b"
    assert result["elapsed_ms"] >= 0
    assert "khoa-gia-test" not in json.dumps(result)


@pytest.mark.asyncio
async def test_analyze_reads_rollup_view_for_four_hour(monkeypatch):
    rows = make_candles(60)

    async def fake_rollup(pool, view, venue, symbol, limit):
        assert (view, symbol) == ("candle_4h", "BTC/USDT")
        return rows

    async def boom(*_args, **_kwargs):
        raise AssertionError("khong duoc doc nen goc khi timeframe co rollup")

    async def fake_complete(_prompt, _settings, **_kwargs):
        return agent.Completion("x", "m", 1, 1, 2, {})

    monkeypatch.setattr(agent.db, "fetch_rollup", fake_rollup)
    monkeypatch.setattr(agent.db, "fetch_candles", boom)
    monkeypatch.setattr(agent, "complete", fake_complete)

    result = await agent.analyze(None, settings(), "BTC/USDT", "4h")
    assert result["timeframe"] == "4h"
    assert result["candles_used"] == 40


@pytest.mark.asyncio
async def test_summary_runs_off_the_event_loop(monkeypatch):
    """metrics.summary la pandas dong bo: phai chay o worker thread keo nghen /api/live."""
    import threading

    seen: dict = {}

    def spy(candles, timeframe):
        seen["thread"] = threading.current_thread()
        return {"observations": len(candles)}

    async def fake_fetch(*_args, **_kwargs):
        return make_candles(10)

    monkeypatch.setattr(agent.db, "fetch_candles", fake_fetch)
    monkeypatch.setattr(agent.metrics, "summary", spy)
    rows, summary = await agent.load_context(None, settings(), "BTC/USDT", "1h")
    assert seen["thread"] is not threading.main_thread()
    assert summary == {"observations": 10}


@pytest.mark.asyncio
async def test_analyze_stops_before_provider_when_warehouse_is_empty(monkeypatch):
    async def empty(*_args, **_kwargs):
        return make_candles(1)

    async def boom(*_args, **_kwargs):
        raise AssertionError("khong duoc goi LLM khi thieu du lieu")

    monkeypatch.setattr(agent.db, "fetch_candles", empty)
    monkeypatch.setattr(agent, "complete", boom)
    with pytest.raises(agent.NoData) as info:
        await agent.analyze(None, settings(), "BTC/USDT", "1h")
    assert "thiếu dữ liệu" in str(info.value)


# ---------- route ----------

@pytest.mark.asyncio
async def test_route_rejects_bad_symbol_before_touching_pool(monkeypatch):
    monkeypatch.setattr(api.app.state, "settings", settings(), raising=False)
    monkeypatch.delattr(api.app.state, "pool", raising=False)
    with pytest.raises(HTTPException) as exc:
        await api.agent_analyze(api.AnalyzeIn(symbol="BTC-USD"))
    assert exc.value.status_code == 422


@pytest.mark.asyncio
async def test_route_rejects_unsupported_timeframe(monkeypatch):
    monkeypatch.setattr(api.app.state, "settings", settings(), raising=False)
    with pytest.raises(HTTPException) as exc:
        await api.agent_analyze(api.AnalyzeIn(symbol="BTC/USDT", timeframe="5m"))
    assert exc.value.status_code == 422
    assert "không được hỗ trợ" in exc.value.detail


@pytest.mark.asyncio
async def test_route_returns_503_without_key(monkeypatch):
    monkeypatch.setattr(api.app.state, "settings", settings(llm_api_key=""), raising=False)
    with pytest.raises(HTTPException) as exc:
        await api.agent_analyze(api.AnalyzeIn(symbol="BTC/USDT"))
    assert exc.value.status_code == 503
    assert "LLM_API_KEY" in exc.value.detail
    assert "chưa sẵn sàng" in exc.value.detail


@pytest.mark.asyncio
async def test_route_maps_provider_error_to_502(monkeypatch):
    monkeypatch.setattr(api.app.state, "settings", settings(), raising=False)
    monkeypatch.setattr(api.app.state, "pool", object(), raising=False)

    async def boom(*_args, **_kwargs):
        raise agent.ProviderError("nha cung cap tra loi 429")

    monkeypatch.setattr(api.agent, "analyze", boom)
    with pytest.raises(HTTPException) as exc:
        await api.agent_analyze(api.AnalyzeIn(symbol="btc"))
    assert exc.value.status_code == 502
    assert "429" in exc.value.detail


@pytest.mark.asyncio
async def test_route_maps_missing_data_to_404(monkeypatch):
    monkeypatch.setattr(api.app.state, "settings", settings(), raising=False)
    monkeypatch.setattr(api.app.state, "pool", object(), raising=False)

    async def boom(*_args, **_kwargs):
        raise agent.NoData("thieu du lieu")

    monkeypatch.setattr(api.agent, "analyze", boom)
    with pytest.raises(HTTPException) as exc:
        await api.agent_analyze(api.AnalyzeIn(symbol="btc"))
    assert exc.value.status_code == 404
