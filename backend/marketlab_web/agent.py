"""marketlab_web.agent — mot phat phan tich thi truong bang LLM, khong tool.

Buoc 1 cua lo trinh agentic: chi doc du lieu da co trong kho (metrics.summary +
N nen da dong), nen prompt ngay phia server de nam trong han muc token cua goi
Groq hien tai. Khong dat lenh, khong nhan key san, khong luu lich su.

Ngan sach token mot luot = system prompt + prompt du lieu + max_completion_tokens
+ bien an toan, tat ca duoi TPM_CEILING. Nen duoc cat tu phia cu (cu nhat) cho
den khi vua tran; phan YEU CAU o cuoi prompt luon duoc giu lai.
"""
from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Sequence

import anyio
import openai
from openai import AsyncOpenAI

from marketlab_web import db, metrics

log = logging.getLogger("marketlab.agent")

MAX_PROMPT_CANDLES = 40
CONTEXT_LIMIT = 500
ERROR_CLIP = 300

# Tran mot luot = 8.000 TPM cua goi Free/Developer. Tru system prompt, tran output
# va bien an toan de phan con lai danh cho prompt du lieu.
TPM_CEILING = 8_000
SYSTEM_PROMPT_TOKEN_ESTIMATE = 300
DEFAULT_MAX_OUTPUT_TOKENS = 700
SAFETY_MARGIN_TOKENS = 250
MIN_PROMPT_CHARS = 1_000
MAX_TOOL_STEPS = 6


@dataclass(frozen=True)
class ModelProfile:
    """He so uoc tinh token va tran prompt thuc dung do benchmark buoc 2 do duoc."""
    chars_per_token: float
    max_prompt_chars: int
    supports_reasoning_effort: bool


# qwen: tieng Viet co dau + so lieu do ra 1,30 ky tu/token, tran 4.300 ky tu.
QWEN_PROFILE = ModelProfile(chars_per_token=1.30, max_prompt_chars=4_300,
                            supports_reasoning_effort=False)
# gpt-oss: 1,8 ky tu/token, tran 6.000 ky tu. Nhip 2 luot/phut van duoi 8K TPM.
GPT_OSS_PROFILE = ModelProfile(chars_per_token=1.80, max_prompt_chars=6_000,
                               supports_reasoning_effort=True)


def model_profile(model: str | None) -> ModelProfile:
    return GPT_OSS_PROFILE if "gpt-oss" in (model or "").lower() else QWEN_PROFILE

SYSTEM_PROMPT = (
    "Bạn là trợ lý nghiên cứu thị trường của marketlab. Trả lời bằng tiếng Việt, "
    "chỉ dựa trên phần DỮ LIỆU được cung cấp, không bịa số. Nếu dữ liệu thiếu hoặc "
    "không đủ kết luận thì nói rõ. Không đưa khuyến nghị mua/bán chắc chắn và không "
    "hứa lợi nhuận. Tối đa 220 từ."
)

COLUMNS = "cot: thoi_gian(UTC) open high low close volume"
REQUEST = (
    "YÊU CẦU: tóm tắt xu hướng, biến động và mức drawdown của {symbol} khung {timeframe};\n"
    "nêu giới hạn của dữ liệu (chỉ có giá/khối lượng nến đã đóng)."
)
FOOTER = "\n\nKhông kết luận ngoài dữ liệu trên."


class AgentError(Exception):
    """Loi co the hien thi cho nguoi dung, khong chua thong tin bi mat."""


class NotConfigured(AgentError):
    """Thieu LLM_API_KEY nen khong goi duoc nha cung cap."""


class NoData(AgentError):
    """Kho chua du nen de phan tich."""


class ProviderError(AgentError):
    """Nha cung cap LLM tra loi loi hoac qua thoi gian cho.

    retry_after = header Retry-After cua nha cung cap (giay) khi co, de vong lap
    biet cho bao lau truoc khi thu lai thay vi doan.
    """

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


@dataclass
class Completion:
    text: str
    model: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    rate_limits: dict[str, str] = field(default_factory=dict)


@dataclass
class ChatResult:
    """Mot luot chat tho: co the co tool_calls ma chua co cau tra loi cuoi."""
    text: str
    tool_calls: list[dict[str, Any]]
    model: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    latency_ms: int
    rate_limits: dict[str, str] = field(default_factory=dict)


def estimate_tokens(text: str, model: str | None = None) -> int:
    """Uoc tinh bao thu (lam tron len) theo he so cua model. Khong phai billing."""
    return math.ceil(len(text) / model_profile(model).chars_per_token)


def prompt_token_room(model: str | None = None,
                      max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS) -> int:
    """Token con lai cho prompt du lieu sau khi tru system + output + bien an toan."""
    reserved = SYSTEM_PROMPT_TOKEN_ESTIMATE + int(max_output_tokens) + SAFETY_MARGIN_TOKENS
    return max(0, TPM_CEILING - reserved)


def prompt_char_budget(model: str | None = None,
                       max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS) -> int:
    """Tran ky tu prompt: nho hon giua tran thuc dung cua model va han muc token."""
    profile = model_profile(model)
    return max(MIN_PROMPT_CHARS,
               min(profile.max_prompt_chars,
                   int(prompt_token_room(model, max_output_tokens) * profile.chars_per_token)))


def worst_case_tokens(prompt: str, model: str | None = None,
                      max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS) -> int:
    """Tong mot luot theo uoc tinh bao thu: system + prompt + output + bien an toan."""
    return (SYSTEM_PROMPT_TOKEN_ESTIMATE + estimate_tokens(prompt, model)
            + int(max_output_tokens) + SAFETY_MARGIN_TOKENS)


def _num(value: float | int | None, digits: int = 4) -> str:
    if value is None:
        return "n/a"
    return f"{float(value):.{digits}g}"


def _pct(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{float(value) * 100:+.2f}%"


def _stamp(ts: Any) -> str:
    if isinstance(ts, datetime):
        iso = ts.isoformat()
    else:
        iso = str(ts)
    return iso[:16].replace("T", " ")


def candle_table(candles: Sequence[dict[str, Any]]) -> str:
    """Bang rut gon: mot dong mot nen, bo ky tu thua de tiet kiem token."""
    lines = []
    for c in candles:
        lines.append(
            f"{_stamp(c['ts'])} "
            f"{_num(c['open'], 8)} {_num(c['high'], 8)} {_num(c['low'], 8)} "
            f"{_num(c['close'], 8)} {_num(c['volume'], 4)}"
        )
    return "\n".join(lines)


def summary_line(summary: dict[str, Any]) -> str:
    return (
        f"observations={summary.get('observations')} "
        f"total_return={_pct(summary.get('total_return'))} "
        f"annualized_return={_pct(summary.get('annualized_return'))} "
        f"max_drawdown={_pct(summary.get('max_drawdown'))} "
        f"volatility={_num(summary.get('volatility'))} "
        f"sharpe={_num(summary.get('sharpe'), 3)} "
        f"sortino={_num(summary.get('sortino'), 3)} "
        f"calmar={_num(summary.get('calmar'), 3)}"
    )


def _head(symbol: str, timeframe: str, candle_count: int, summary: dict[str, Any]) -> str:
    """Nhan cua so: chi so tinh tren ca cua so, bang chi trich N nen gan nhat."""
    return (
        f"symbol: {symbol} | khung: {timeframe}\n"
        f"chi so: tinh tren {summary.get('observations')} nen da dong "
        f"(cua so toi da {CONTEXT_LIMIT} nen)\n"
        f"bang: {candle_count} nen gan nhat, moi nhat o cuoi"
    )


def _tail(symbol: str, timeframe: str) -> str:
    return "\n\n" + REQUEST.format(symbol=symbol, timeframe=timeframe) + FOOTER


def _compose(symbol: str, timeframe: str, candles: Sequence[dict[str, Any]],
             summary: dict[str, Any]) -> str:
    return (
        f"{_head(symbol, timeframe, len(candles), summary)}\n\n"
        f"DỮ LIỆU\n{summary_line(summary)}\n\n"
        f"{COLUMNS}\n{candle_table(candles)}"
        f"{_tail(symbol, timeframe)}"
    )


def build_prompt(symbol: str, timeframe: str, candles: Sequence[dict[str, Any]],
                 summary: dict[str, Any], max_candles: int = MAX_PROMPT_CANDLES,
                 max_chars: int | None = None,
                 model: str | None = None) -> tuple[str, int]:
    """Tra (prompt, so nen da dua vao). Cat bot nen cu nhat cho den khi vua tran."""
    limit = prompt_char_budget(model) if max_chars is None else int(max_chars)
    rows = list(candles)[-max_candles:]
    if len(rows) < 2:
        raise NoData(f"cần ít nhất 2 nến để phân tích {symbol} {timeframe}")
    for used in range(len(rows), 1, -1):
        prompt = _compose(symbol, timeframe, rows[len(rows) - used:], summary)
        if len(prompt) <= limit:
            return prompt, used
    # Ngan sach chi con du cho mot phan bang: bo tung dong cu nhat, giu nguyen
    # phan YEU CAU o cuoi prompt thay vi cat phang chuoi prompt.
    kept: list[dict[str, Any]] = []
    for row in reversed(rows[-2:]):
        trial = [row, *kept]
        if len(_compose(symbol, timeframe, trial, summary)) > limit:
            break
        kept = trial
    return _compose(symbol, timeframe, kept, summary), len(kept)


async def load_context(pool: Any, settings: Any, symbol: str,
                       timeframe: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Doc nen (rollup cho 4h/1d) roi tinh summary. pandas chay trong threadpool."""
    view = db.ROLLUP_VIEWS.get(timeframe)
    if view:
        rows = await db.fetch_rollup(pool, view, settings.venue, symbol, CONTEXT_LIMIT)
    else:
        rows = await db.fetch_candles(pool, settings.venue, symbol, timeframe, CONTEXT_LIMIT)
    if len(rows) < 2:
        raise NoData(f"thiếu dữ liệu cho {symbol} {timeframe} — chạy worker ingest trước")
    summary = await anyio.to_thread.run_sync(metrics.summary, rows, timeframe)
    return rows, summary


def _retry_after_seconds(exc: Exception) -> float | None:
    """Doc header Retry-After (giay) neu nha cung cap gui kem loi 429."""
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if not headers:
        return None
    try:
        value = float(str(headers.get("retry-after") or "").strip())
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _clip(text: str, secret: str = "") -> str:
    """Mot dong ngan gon, che khoa neu nha cung cap echo lai trong body loi."""
    clean = " ".join(text.split())
    if secret:
        clean = clean.replace(secret, "[redacted]")
    return clean if len(clean) <= ERROR_CLIP else f"{clean[:ERROR_CLIP]}…"


async def chat(messages: list[dict[str, Any]], settings: Any, model: str | None = None,
               tools: list[dict[str, Any]] | None = None,
               max_output_tokens: int | None = None) -> ChatResult:
    """Mot luot chat (co the kem tool). Khong log prompt va khong log khoa."""
    api_key = (settings.llm_api_key or "").strip()
    if not api_key:
        raise NotConfigured("thiếu LLM_API_KEY")
    target = model or settings.llm_model
    output_cap = int(max_output_tokens or settings.llm_max_output_tokens
                     or DEFAULT_MAX_OUTPUT_TOKENS)

    params: dict[str, Any] = {
        "model": target,
        "messages": messages,
        "temperature": 0.2,
        "max_completion_tokens": output_cap,
    }
    if tools:
        params["tools"] = tools
        params["tool_choice"] = "auto"
    # Chi gpt-oss nhan reasoning_effort; qwen tra loi 400 neu gui tham so la.
    if model_profile(target).supports_reasoning_effort:
        effort = (settings.llm_reasoning_effort or "").strip()
        if effort:
            params["reasoning_effort"] = effort

    started = time.perf_counter()
    # from None: khong mang body loi cua nha cung cap (co the echo khoa) vao traceback.
    try:
        async with AsyncOpenAI(
            api_key=api_key,
            base_url=settings.llm_base_url,
            timeout=settings.llm_timeout_seconds,
            max_retries=1,
        ) as client:
            raw = await client.chat.completions.with_raw_response.create(**params)
    except openai.AuthenticationError:
        raise ProviderError("khóa LLM không hợp lệ (401)") from None
    except openai.RateLimitError as exc:
        raise ProviderError("nhà cung cấp báo vượt hạn mức (429) — thử lại sau",
                            retry_after=_retry_after_seconds(exc)) from None
    except openai.APITimeoutError:
        raise ProviderError("nhà cung cấp không trả lời kịp") from None
    except openai.APIStatusError as exc:
        raise ProviderError(
            f"nhà cung cấp trả lời {exc.status_code}: {_clip(str(exc), api_key)}") from None
    except openai.OpenAIError as exc:
        raise ProviderError(f"lỗi gọi LLM: {_clip(str(exc), api_key)}") from None

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    # 200 nhung body khong phai JSON / thieu truong: 502 doc duoc, khong phai 500.
    try:
        body = raw.parse()
        model_name = body.model or target
        usage = body.usage
        prompt_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
        completion_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
        total_tokens = int(getattr(usage, "total_tokens", 0) or 0) or (
            prompt_tokens + completion_tokens)
        choice = body.choices[0] if body.choices else None
        message = choice.message if choice else None
        text = ((message.content if message else "") or "").strip()
        tool_calls = [
            {"id": str(call.id), "name": str(call.function.name),
             "arguments": str(call.function.arguments or "{}")}
            for call in ((message.tool_calls if message else None) or [])
        ]
    except (AttributeError, IndexError, KeyError, TypeError, ValueError,
            openai.APIResponseValidationError):
        raise ProviderError("phản hồi của nhà cung cấp không đọc được") from None
    if not text and not tool_calls:
        raise ProviderError("model trả về nội dung rỗng")

    limits = {
        key.lower(): value
        for key, value in raw.headers.items()
        if key.lower().startswith("x-ratelimit-")
    }
    log.info("LLM %s: %s->%s token, %sms", model_name,
             prompt_tokens, completion_tokens, elapsed_ms)
    return ChatResult(
        text=text,
        tool_calls=tool_calls,
        model=model_name,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
        latency_ms=elapsed_ms,
        rate_limits=limits,
    )


async def complete(prompt: str, settings: Any, model: str | None = None,
                   max_output_tokens: int | None = None) -> Completion:
    """Goi mot phat khong tool (duong phan tich cu va cau tra loi cuoi)."""
    result = await chat(
        [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        settings, model=model, tools=None, max_output_tokens=max_output_tokens,
    )
    if not result.text:
        raise ProviderError("model trả về nội dung rỗng")
    return Completion(
        text=result.text,
        model=result.model,
        prompt_tokens=result.prompt_tokens,
        completion_tokens=result.completion_tokens,
        total_tokens=result.total_tokens,
        rate_limits=result.rate_limits,
    )


async def analyze(pool: Any, settings: Any, symbol: str, timeframe: str) -> dict[str, Any]:
    if not (settings.llm_api_key or "").strip():
        raise NotConfigured("thiếu LLM_API_KEY")
    started = time.perf_counter()
    candles, summary = await load_context(pool, settings, symbol, timeframe)
    model = settings.llm_model
    max_output = int(getattr(settings, "llm_max_output_tokens", DEFAULT_MAX_OUTPUT_TOKENS)
                     or DEFAULT_MAX_OUTPUT_TOKENS)
    prompt, used = build_prompt(symbol, timeframe, candles, summary, model=model,
                                max_chars=prompt_char_budget(model, max_output))
    completion = await complete(prompt, settings, model=model, max_output_tokens=max_output)
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    log.info("analyze %s %s: %s nen, %s ky tu prompt", symbol, timeframe, used, len(prompt))
    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "model": completion.model,
        "text": completion.text,
        "candles_used": used,
        "prompt_chars": len(prompt),
        "estimated_prompt_tokens": estimate_tokens(prompt, model),
        "usage": {
            "prompt_tokens": completion.prompt_tokens,
            "completion_tokens": completion.completion_tokens,
            "total_tokens": completion.total_tokens,
        },
        "elapsed_ms": elapsed_ms,
        "rate_limits": completion.rate_limits,
    }
