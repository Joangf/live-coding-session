# live-coding-session

# 🚀 Access the app: [livecode.jfservice.id.vn](https://livecode.jfservice.id.vn)

An API for creating live coding sessions, saving source code, queueing executions, and running user code inside isolated Docker sandboxes.

## What It Does

The service exposes a small HTTP API backed by PostgreSQL, Redis, BullMQ, and Docker:

- PostgreSQL stores coding sessions and execution records.
- Redis stores the BullMQ queue used to process execution jobs.
- Caddy works as a reverse proxy and automatically manages HTTPS certificates.
- The API server creates sessions, updates source code, and enqueues runs.
- A background worker consumes execution jobs and launches short-lived Docker containers.
- Each sandbox container gets the submitted source code, runs it with the selected language runtime, and returns stdout, stderr, exit code, and duration.

OpenAPI documentation is available at `/openapi` after the server starts.

## Documentation

- [System Design](./DESIGN.md)

## Requirements

- Docker Desktop or a compatible Docker daemon
- Bun 1.3+
- Docker Compose

The API container needs access to the Docker socket so it can launch sandbox containers.

## Project Layout

- `src/index.ts` starts the API server and execution worker.
- `src/api/` defines the HTTP routes and request/response models.
- `src/queue/` defines the BullMQ queue used to schedule execution jobs.
- `src/core/executionWorker.ts` processes jobs and updates execution state.
- `src/core/sandbox.ts` creates and manages the Docker sandbox containers.
- `db/init.sql` initializes the PostgreSQL schema.

## Run With Docker Compose

This is the recommended way to run the project locally.

```bash
docker compose up -d --build
```

That starts:

- PostgreSQL on `127.0.0.1:5432`
- Redis on `127.0.0.1:6379`
- The API server on `127.0.0.1:3000`
- Caddy as the public reverse proxy with automatic HTTPS certificate provisioning and renewal

Once the containers are up, open `http://localhost:3000/openapi`.

To stop the stack:

```bash
docker compose down
```

The server listens on port `3000`.

### Environment Variables

The compose file provides sensible defaults, but these variables control the runtime:

- `DATABASE_URL`: PostgreSQL connection string used by the API.
- `REDIS_URL`: Redis connection string used by BullMQ.
- `SANDBOX_MAX_CONTAINERS` (default `20`): global cap for active sandbox containers.
- `SANDBOX_MAX_CONTAINERS_PER_CLIENT` (default `2`): per-client cap. In the current worker flow, each `session_id` is treated as the client identity.
- `SANDBOX_MEMORY_BYTES` (default `134217728`): memory cap per sandbox container.
- `SANDBOX_NANO_CPUS` (default `500000000`): CPU cap per sandbox container, where `500000000` equals 0.5 vCPU.
- `EXECUTION_TIMEOUT_MS` (default `5000`): maximum time allowed for a sandbox run.
- `EXECUTION_MAX_OUTPUT_CHARS` (default `20000`): output truncation limit for stdout and stderr.
- `EXECUTION_CONCURRENCY` (default `2`): number of execution jobs processed in parallel.

Set a sandbox cap to `0` or a negative value to disable that specific limit.

## API Flow

1. `POST /code-sessions` creates a new session with a language and optional initial source code.
2. `PATCH /code-sessions/:session_id` updates the session source code and language.
3. `POST /code-sessions/:session_id/run` creates an execution row and enqueues a BullMQ job.
4. The worker pulls the job from Redis and marks the execution as `RUNNING`.
5. The worker loads the session source from PostgreSQL and passes it to the sandbox.
6. The sandbox starts a short-lived container for the requested language.
7. The container executes the code with networking disabled and a restricted filesystem.
8. The worker stores the final execution status and captured output back in PostgreSQL.
9. `GET /executions/:execution_id` returns the latest execution status and results.

## Sandbox Flow

The sandbox is designed to run untrusted code with minimal privileges:

1. The worker normalizes the requested language and looks up the matching runtime image.
2. The service checks container capacity before creating a new sandbox.
3. The runtime image is pulled if it is not already available locally.
4. The source code is base64-encoded and injected into the container through an environment variable.
5. The container mounts an in-memory workspace and runs the language-specific command.
6. Network access is disabled, privilege escalation is blocked, Linux capabilities are dropped, and the root filesystem is read-only.
7. Stdout and stderr are captured, truncated if needed, and returned to the worker.
8. If the timeout is reached, the container is stopped and the execution is marked as `TIMEOUT`.
9. The container is removed after every run, even when execution fails.

### Supported Runtimes

The current sandbox mapping supports:

- `python` -> `python:3.14-alpine`
- `javascript` -> `node:20-alpine`

## Database Schema

The database is initialized from `db/init.sql` and contains:

- `code_sessions` for session metadata and saved source code.
- `executions` for queued and completed runs.
- A trigger that updates `updated_at` when a session changes.
- An index on `executions.status` for status lookups.

## Common Endpoints

- `GET /` redirects to `/openapi`
- `POST /code-sessions`
- `PATCH /code-sessions/:session_id`
- `POST /code-sessions/:session_id/run`
- `GET /executions/:execution_id`

## Notes

- The execution worker starts in the same process as the API server.
- The current worker flow uses `session_id` as the sandbox client identity for per-client limits.
- If Docker runs out of capacity, execution requests fail early before a container is created.
