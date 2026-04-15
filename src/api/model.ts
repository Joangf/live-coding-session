import { t, type UnwrapSchema } from 'elysia'
import { SQL } from 'bun'

const DB_URL = String(Bun.env.DATABASE_URL);
export const Pg = new SQL(DB_URL);

export const CodeExecutionModels = {
  // ---------------------------------------------------------
  // 2.1.1 POST /code-sessions
  // ---------------------------------------------------------
  CreateSessionBody: t.Object({
    language: t.String({ description: 'Programming language for this coding session' }),
    source_code: t.Optional(t.String({ description: 'Initial source code submitted by the learner' })),
  }),
  CreateSessionResponse: t.Object({
    session_id: t.String({ format: 'uuid', description: 'Generated UUID for the session' }),
    status: t.Literal('ACTIVE'),
  }),

  SessionStatus: t.Union([
    t.Literal('ACTIVE'),
    t.Literal('ARCHIVED'),
  ]),

  // Shared Path Parameter for session routes
  SessionIdParam: t.Object({
    session_id: t.String({ format: 'uuid' }),
  }),

  // ---------------------------------------------------------
  // 2.1.2 PATCH /code-sessions/{session_id}
  // ---------------------------------------------------------
  PatchSessionBody: t.Object({
    language: t.String(),
    source_code: t.String(),
  }),
  PatchSessionResponse: t.Object({
    session_id: t.String({ format: 'uuid' }),
    status: t.Literal('ACTIVE'),
  }),

  // ---------------------------------------------------------
  // 2.1.3 POST /code-sessions/{session_id}/run
  // ---------------------------------------------------------
  RunSessionResponse: t.Object({
    execution_id: t.String({ format: 'uuid' }),
    status: t.Union([
      t.Literal('QUEUED'),
      t.Literal('RUNNING'),
      t.Literal('COMPLETED'),
      t.Literal('FAILED'),
      t.Literal('TIMEOUT'),
    ]),
  }),

  // Shared Path Parameter for execution routes
  ExecutionIdParam: t.Object({
    execution_id: t.String({ format: 'uuid' }),
  }),

  // ---------------------------------------------------------
  // 2.2.1 GET /executions/{execution_id}
  // ---------------------------------------------------------
  GetExecutionResponse: t.Object({
    execution_id: t.String({ format: 'uuid' }),
    status: t.Union([
      t.Literal('QUEUED'),
      t.Literal('RUNNING'),
      t.Literal('COMPLETED'),
      t.Literal('FAILED'),
      t.Literal('TIMEOUT'),
    ]),
    // These fields are populated when the status is COMPLETED
    stdout: t.Optional(t.String()),
    stderr: t.Optional(t.String()),
    execution_time_ms: t.Optional(t.Number()),
  }),
} as const

// Cast all models to TypeScript types
export type CodeExecutionModels = {
  [k in keyof typeof CodeExecutionModels]: UnwrapSchema<typeof CodeExecutionModels[k]>
}