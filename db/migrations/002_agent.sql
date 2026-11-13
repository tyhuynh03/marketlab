-- marketlab-web · migration 002: agent runs + steps (chay tay, db/init chi chay lan dau)
--   docker compose exec -T db psql -U marketlab -d marketlab < db/migrations/002_agent.sql
-- Tren Windows (Git Bash) duong dan van nhu tren; neu psql bao khong thay file thi
-- chay: docker compose exec -T db psql -U marketlab -d marketlab -f /dev/stdin < db/migrations/002_agent.sql

CREATE TABLE IF NOT EXISTS agent_run (
    id            bigserial   PRIMARY KEY,
    symbol        text        NOT NULL,
    timeframe     text        NOT NULL,
    status        text        NOT NULL DEFAULT 'running',
    model_tool    text        NOT NULL,
    model_answer  text        NOT NULL,
    tokens_in     integer     NOT NULL DEFAULT 0,
    tokens_out    integer     NOT NULL DEFAULT 0,
    error         text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    CONSTRAINT agent_run_status_check
        CHECK (status IN ('running', 'done', 'error', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS agent_run_created_idx ON agent_run (created_at DESC);

CREATE TABLE IF NOT EXISTS agent_step (
    id           bigserial   PRIMARY KEY,
    run_id       bigint      NOT NULL REFERENCES agent_run (id) ON DELETE CASCADE,
    step_idx     integer     NOT NULL,
    kind         text        NOT NULL,
    tool_name    text,
    args_json    jsonb,
    result_json  jsonb,
    tokens       integer     NOT NULL DEFAULT 0,
    latency_ms   integer     NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_step_kind_check CHECK (kind IN ('tool', 'answer'))
);

CREATE INDEX IF NOT EXISTS agent_step_run_idx ON agent_step (run_id, step_idx);
