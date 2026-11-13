"""marketlab_web.config"""
from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = "postgresql://marketlab:marketlab@127.0.0.1:5433/marketlab"
    venue: str = "binance"
    base_timeframe: str = "1h"
    history_days: int = 120
    ingest_interval_seconds: int = 300
    max_candles_per_request: int = 5000
    live_enabled: bool = True

    # Agent doc-only (buoc 2 lo trinh agentic). Provider OpenAI-compatible, mac dinh Groq.
    # llm_model = model tra loi cuoi (qwen); llm_model_tool = model dieu phoi tool (gpt-oss).
    llm_api_key: str = ""
    llm_base_url: str = "https://api.groq.com/openai/v1"
    llm_model: str = "qwen/qwen3.8-27b"
    llm_model_tool: str = "openai/gpt-oss-120b"
    llm_timeout_seconds: float = 60.0
    llm_max_output_tokens: int = 700
    # gpt-oss tren Groq nhan low/medium/high; qwen khong nhan tham so nay.
    llm_reasoning_effort: str | None = "low"


@lru_cache
def get_settings() -> Settings:
    return Settings()
