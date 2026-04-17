# DESIGN

## 1. Architecture Overview

### 1.1 System Components

- API server (Elysia): handles HTTP requests for session creation, autosave, run requests, and execution polling.
- PostgreSQL: stores `code_sessions` and `executions` as the source of truth for state.
- Redis + BullMQ queue: decouples execution requests from code execution.
- Execution worker: consumes queue jobs, runs code in sandbox, and updates execution state.
- Docker sandbox runtime: runs user code in isolated, short-lived containers.
- Caddy reverse proxy: routes external traffic to the API and manages HTTPS certificates automatically.

### 1.2 End-to-End Request Flow

#### Code session creation

1. Client calls `POST /code-sessions` with language and optional source code.
2. API inserts a new row in `code_sessions` with status `ACTIVE`.
3. API returns `session_id`.

#### Autosave behavior

1. Client periodically calls `PATCH /code-sessions/:session_id`.
2. API updates `language`, `source_code`, and `status='ACTIVE'`.
3. PostgreSQL trigger updates `updated_at` automatically.
4. Latest saved source is what later execution jobs will use.

#### Execution request

1. Client calls `POST /code-sessions/:session_id/run`.
2. API inserts an `executions` row with `status='QUEUED'`.
3. API enqueues a BullMQ job containing `session_id` and `execution_id`.
4. API returns `execution_id` for polling.

#### Background execution

1. Worker picks the job from queue.
2. Worker marks execution `RUNNING` and sets `started_at`.
3. Worker loads latest `language` + `source_code` from `code_sessions`.
4. Worker executes code in a restricted Docker container.
5. Worker stores terminal state (`COMPLETED` / `FAILED` / `TIMEOUT`) with output and timing.

#### Result polling

1. Client polls `GET /executions/:execution_id`.
2. API returns current execution state and result fields (`stdout`, `stderr`, `execution_time_ms`) when available.
3. Polling stops once terminal state is returned.

### 1.3 Queue-Based Execution Design

- Request path is intentionally short: enqueue and return quickly.
- Execution path is asynchronous and isolated from API latency.
- BullMQ retry policy (`attempts=2`, exponential backoff) handles transient worker failures.
- Concurrency is controlled by `EXECUTION_CONCURRENCY`.

### 1.4 Execution Lifecycle and State Management

Canonical execution states in DB:

- `QUEUED`: execution row created, waiting in queue.
- `RUNNING`: worker started processing, container launching/running.
- `COMPLETED`: process exit code `0`.
- `FAILED`: non-zero exit, unsupported language, missing session, worker/runtime error.
- `TIMEOUT`: execution exceeded `EXECUTION_TIMEOUT_MS`.

Timestamps support observability and SLA tracking:

- `queued_at`, `started_at`, `finished_at`.

`retry_count` tracks attempt number from BullMQ for debugging and reliability analysis.

---

## 2. Reliability & Data Model

### 2.1 Data Model Summary

`code_sessions`

- `id` (UUID PK)
- `language`
- `source_code`
- `status` (currently `ACTIVE`)
- `created_at`, `updated_at`

`executions`

- `id` (UUID PK)
- `session_id` (FK to `code_sessions`)
- `status` (`QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`, `TIMEOUT`)
- `stdout`, `stderr`
- `execution_time_ms`
- `queued_at`, `started_at`, `finished_at`
- `retry_count`

### 2.2 Required State Progression

Expected lifecycle:

- `QUEUED` -> `RUNNING` -> (`COMPLETED` | `FAILED` | `TIMEOUT`)

The worker enforces transitions by DB updates in each processing stage.

### 2.3 Idempotency Handling

#### Current behavior

- Each call to run endpoint creates a new `executions` row. This avoids accidental overwrite across separate run requests.
- Retry attempts update the same `execution_id`, making retries for one job logically grouped.

#### Prevent duplicate execution runs

Current implementation does not yet expose a client-provided idempotency key.

Production recommendation:

- Accept `Idempotency-Key` on `POST /code-sessions/:session_id/run`.
- Store `(session_id, idempotency_key)` with a unique constraint.
- Return existing `execution_id` for repeated keys instead of inserting a new execution row.

#### Safe reprocessing of jobs

Current design is partially safe because worker writes final state by `execution_id`.

Recommended hardening:

- Guard `setRunning` with conditional update (only from non-terminal states).
- Guard final update to avoid changing already terminal executions.
- Optionally add `last_error_at` and `worker_id` for forensic tracing.

### 2.4 Failure Handling

#### Retries

- BullMQ retries once after first failure (`attempts=2`) with exponential backoff.

#### Error states

- Worker maps runtime and processing failures to `FAILED`.
- Worker maps deadline breach to `TIMEOUT`.

#### Dead-letter / failed execution handling

- BullMQ keeps failed jobs in its failed set.
- Database preserves terminal status and error output for retrieval.
- No dedicated DLQ processing pipeline is implemented yet.

Recommended next step:

- Add a scheduled reconciler that scans stale `RUNNING`/`QUEUED` executions and marks them `FAILED` with reason when they exceed a safety threshold.

---

## 3. Scalability Considerations

### 3.1 Many Concurrent Live Coding Sessions

- API remains lightweight by avoiding inline execution.
- Session writes are simple row updates; execution is offloaded to queue workers.
- Container-level resource limits prevent one run from exhausting host resources.

### 3.2 Horizontal Scaling of Workers

- BullMQ supports multiple worker instances consuming from the same queue.
- Horizontal scale can be achieved by running more API/worker containers (with same Redis + DB).
- Keep `EXECUTION_CONCURRENCY` moderate per worker to avoid Docker host thrashing.

### 3.3 Queue Backlog Handling

- Backlog naturally accumulates in Redis queue during traffic spikes.
- User experience remains responsive because enqueue is fast.
- Polling endpoint allows clients to observe queued state.

Recommended backlog controls:

- Emit queue depth metrics and alert thresholds.
- Add request rate limits per session/user.
- Optionally reject new runs when backlog exceeds defined SLO thresholds.

### 3.4 Potential Bottlenecks and Mitigations

- Docker image pull latency: pre-pull runtime images during startup.
- Docker daemon saturation: cap global and per-client sandbox containers.
- PostgreSQL write contention: index heavily queried fields (status, timestamps), tune connection pool.
- Redis queue pressure: move to managed Redis / persistence tuning for production.
- Polling overhead: introduce websocket/SSE notifications or exponential polling intervals.

---

## 4. Trade-offs

### 4.1 Technology Choices and Why

- Elysia + Bun: fast startup and low overhead for API-centric workloads.
- PostgreSQL: reliable relational storage for sessions + execution history.
- Redis + BullMQ: mature async job orchestration with retries and concurrency controls.
- Docker sandboxing: practical isolation boundary for untrusted code execution.
- Caddy: simple reverse proxy with automatic HTTPS certificate management.

### 4.2 Optimization Priority

Current implementation optimizes for:

- Simplicity: easy local setup and understandable execution flow.
- Developer speed: minimal moving parts and straightforward API contracts.
- Basic reliability: retries, persisted states, timeout handling.

Compared priorities:

- Reliability and observability are improved, but not yet at full production maturity.
- Strict exactly-once semantics are not fully guaranteed yet without idempotency keys.

### 4.3 Production Readiness Gaps

- No explicit authentication/authorization model for session ownership.
- No client idempotency key support on run requests.
- No dedicated dead-letter re-drive workflow.
- Limited metrics/tracing dashboards (queue latency, container launch time, failure rate).
- Polling-only result delivery (no push channel).
- Single process currently starts both API and worker; independent scaling topology is not yet separated by role.

## 5. Suggested Next Steps

1. Add idempotency-key support for run endpoint and DB unique constraint.
2. Add stale-execution reconciler for zombie `RUNNING` states.
3. Add metrics and alerts (queue depth, processing latency, timeout ratio, retry ratio).
4. Split deployment roles (API-only and worker-only) for cleaner horizontal scaling.
5. Add authenticated session ownership and per-user quotas/rate limits.
