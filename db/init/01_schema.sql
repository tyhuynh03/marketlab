-- marketlab-web · schema khoi tao (docker-entrypoint-initdb.d chay mot lan luc bootstrap)

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Nen: 1h candle cho moi (venue, symbol). Rollup lon hon khong luu lap lai,
-- ma tinh bang continuous aggregate o duoi.
-- Khong co cot `trades`: ccxt fetch_ohlcv chuan hoa con 6 truong (o,h,l,c,v),
-- so lenh la field rieng cua tung venue -> muon co phai doc raw endpoint.
CREATE TABLE IF NOT EXISTS candle (
    venue      text          NOT NULL,
    symbol     text          NOT NULL,
    timeframe  text          NOT NULL,
    ts         timestamptz   NOT NULL,
    open       numeric(20,8) NOT NULL,
    high       numeric(20,8) NOT NULL,
    low        numeric(20,8) NOT NULL,
    close      numeric(20,8) NOT NULL,
    volume     numeric(28,8) NOT NULL,
    PRIMARY KEY (venue, symbol, timeframe, ts)
);

SELECT create_hypertable('candle', 'ts', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS candle_symbol_idx
    ON candle (venue, symbol, timeframe, ts DESC);

CREATE TABLE IF NOT EXISTS watchlist (
    venue      text        NOT NULL DEFAULT 'binance',
    symbol     text        NOT NULL,
    timeframe  text        NOT NULL DEFAULT '1h',
    label      text,
    added_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (venue, symbol, timeframe)
);

CREATE MATERIALIZED VIEW IF NOT EXISTS candle_4h
WITH (timescaledb.continuous) AS
SELECT venue, symbol,
       time_bucket('4 hours', ts) AS bucket,
       first(open, ts)  AS open,
       max(high)        AS high,
       min(low)         AS low,
       last(close, ts)  AS close,
       sum(volume)      AS volume
FROM candle
WHERE timeframe = '1h'
GROUP BY venue, symbol, bucket
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS candle_1d
WITH (timescaledb.continuous) AS
SELECT venue, symbol,
       time_bucket('1 day', ts) AS bucket,
       first(open, ts)  AS open,
       max(high)        AS high,
       min(low)         AS low,
       last(close, ts)  AS close,
       sum(volume)      AS volume
FROM candle
WHERE timeframe = '1h'
GROUP BY venue, symbol, bucket
WITH NO DATA;

-- start_offset phai lon hon history_days cua worker (120 ngay) neu khong
-- nhung lan backfill nguoc ve qua 30 ngay se khong duoc refresh lai.
SELECT add_continuous_aggregate_policy('candle_4h',
    start_offset      => INTERVAL '150 days',
    end_offset        => INTERVAL '4 hours',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists     => TRUE);

SELECT add_continuous_aggregate_policy('candle_1d',
    start_offset      => INTERVAL '150 days',
    end_offset        => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists     => TRUE);

INSERT INTO watchlist (venue, symbol, timeframe, label) VALUES
    ('binance', 'BTC/USDT', '1h', 'Bitcoin'),
    ('binance', 'ETH/USDT', '1h', 'Ethereum')
ON CONFLICT DO NOTHING;
