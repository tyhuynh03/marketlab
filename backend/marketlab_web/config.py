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


@lru_cache
def get_settings() -> Settings:
    return Settings()
