import { Worker } from 'bullmq'
import { Pg } from '../api/model'
import { runCodeInSandbox } from './sandbox'

type ExecutionJobData = {
  session_id: string
  execution_id: string
}

type SessionForExecution = {
  language: string
  source_code: string
}

const REDIS_URL = Bun.env.REDIS_URL as string
const EXECUTION_TIMEOUT_MS = Number(Bun.env.EXECUTION_TIMEOUT_MS ?? '5000')
const EXECUTION_MAX_OUTPUT_CHARS = Number(Bun.env.EXECUTION_MAX_OUTPUT_CHARS ?? '20000')
const EXECUTION_CONCURRENCY = Number(Bun.env.EXECUTION_CONCURRENCY ?? '2')

let worker: Worker<ExecutionJobData> | null = null

const setRunning = async (executionId: string, retryCount: number) => {
  await Pg`
    UPDATE executions
    SET
      status = 'RUNNING',
      started_at = CURRENT_TIMESTAMP,
      retry_count = ${retryCount}
    WHERE id = ${executionId}
  `
}

const markExecutionDone = async (
  executionId: string,
  status: 'COMPLETED' | 'FAILED' | 'TIMEOUT',
  stdout: string,
  stderr: string,
  executionTimeMs: number,
) => {
  await Pg`
    UPDATE executions
    SET
      status = ${status},
      stdout = ${stdout},
      stderr = ${stderr},
      execution_time_ms = ${executionTimeMs},
      finished_at = CURRENT_TIMESTAMP
    WHERE id = ${executionId}
  `
}

const getSessionForExecution = async (executionId: string) => {
  const [session] = await Pg<SessionForExecution[]>`
    SELECT s.language, s.source_code
    FROM executions e
    INNER JOIN code_sessions s ON s.id = e.session_id
    WHERE e.id = ${executionId}
  `

  return session
}

const processExecution = async (
  executionId: string,
  retryCount: number,
  sessionId: string,
) => {
  await setRunning(executionId, retryCount)
  const session = await getSessionForExecution(executionId)

  if (!session) {
    await markExecutionDone(executionId, 'FAILED', '', 'Session not found for execution', 0)
    return
  }

  try {
    const result = await runCodeInSandbox(
      session.language,
      session.source_code,
      EXECUTION_TIMEOUT_MS,
      EXECUTION_MAX_OUTPUT_CHARS,
      {
        clientId: sessionId,
        executionId,
      },
    )

    if (result.timedOut) {
      await markExecutionDone(
        executionId,
        'TIMEOUT',
        result.stdout,
        result.stderr || 'Execution timed out',
        result.execution_time_ms,
      )
      return
    }

    const status = result.exitCode === 0 ? 'COMPLETED' : 'FAILED'
    await markExecutionDone(
      executionId,
      status,
      result.stdout,
      result.stderr,
      result.execution_time_ms,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown execution error'
    await markExecutionDone(executionId, 'FAILED', '', message, 0)
  }
}

export const startExecutionWorker = () => {
  if (worker) {
    return worker
  }

  worker = new Worker<ExecutionJobData>(
    'Execution',
    async (job) => {
      await processExecution(job.data.execution_id, job.attemptsMade, job.data.session_id)
    },
    {
      connection: {
        url: REDIS_URL,
      },
      concurrency: EXECUTION_CONCURRENCY,
    },
  )

  worker.on('failed', async (job, error) => {
    if (!job) {
      return
    }

    await markExecutionDone(job.data.execution_id, 'FAILED', '', error.message, 0)
  })

  return worker
}
