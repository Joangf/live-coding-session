import { Pg, type CodeExecutionModels } from './model'
import { makeExecutionJob } from '../queue/executionQueue'

type SessionRow = {
  id: string
  status: 'ACTIVE'
}

type ExecutionRow = {
  id: string
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'TIMEOUT'
  stdout: string | null
  stderr: string | null
  execution_time_ms: number | null
}

export const Service = {
  createSession: async (body: CodeExecutionModels['CreateSessionBody']) => {
    const sourceCode = body.source_code ?? ''
    const [session] = await Pg<SessionRow[]>`
      INSERT INTO code_sessions (language, source_code, status)
      VALUES (${body.language}, ${sourceCode}, 'ACTIVE')
      RETURNING id, status
    `
    if (!session) {
      throw new Error('Failed to create session')
    }

    return {
      session_id: session.id,
      status: session.status,
    }
  },

  updateSession: async (session_id: string, body: CodeExecutionModels['PatchSessionBody']) => {
    const [session] = await Pg<SessionRow[]>`
      UPDATE code_sessions
      SET
        language = ${body.language},
        source_code = ${body.source_code},
        status = 'ACTIVE'
      WHERE id = ${session_id}
      RETURNING id, status
    `

    if (!session) {
      throw new Error('Session not found')
    }

    return {
      session_id: session.id,
      status: session.status,
    }
  },

  queueExecution: async (session_id: string) => {
    const [execution] = await Pg<ExecutionRow[]>`
      INSERT INTO executions (session_id, status)
      VALUES (${session_id}, 'QUEUED')
      RETURNING id, status, stdout, stderr, execution_time_ms
    `;
    if (!execution) {
      throw new Error('Failed to create execution record')
    }
    // Queue worker consumes session_id and will update execution state later.
    await makeExecutionJob(session_id, execution.id)

    return {
      execution_id: execution.id,
      status: execution.status,
    }
  },

  getExecution: async (execution_id: string) => {
    const [execution] = await Pg<ExecutionRow[]>`
      SELECT id, status, stdout, stderr, execution_time_ms
      FROM executions
      WHERE id = ${execution_id}
    `

    if (!execution) {
      throw new Error('Execution not found')
    }

    return {
      execution_id: execution.id,
      status: execution.status,
      stdout: execution.stdout ?? undefined,
      stderr: execution.stderr ?? undefined,
      execution_time_ms: execution.execution_time_ms ?? undefined,
    }
  },
}