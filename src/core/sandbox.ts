import Docker from 'dockerode'
import { PassThrough } from 'stream'

const docker = new Docker()

type LanguageRuntime = {
  image: string
  fileName: string
  executeCommand: string
}

export type SandboxExecutionResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  execution_time_ms: number
}

type SandboxExecutionOptions = {
  clientId?: string
  executionId?: string
}

const parseLimit = (value: string | undefined, fallback: number) => {
  const parsed = Number(value ?? `${fallback}`)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  // Zero or negative values disable the cap.
  if (parsed <= 0) {
    return Number.MAX_SAFE_INTEGER
  }

  return Math.floor(parsed)
}

const MAX_SANDBOX_CONTAINERS = parseLimit(Bun.env.SANDBOX_MAX_CONTAINERS, 20)
const MAX_SANDBOX_CONTAINERS_PER_CLIENT = parseLimit(Bun.env.SANDBOX_MAX_CONTAINERS_PER_CLIENT, 2)
const SANDBOX_MEMORY_BYTES = parseLimit(Bun.env.SANDBOX_MEMORY_BYTES, 128 * 1024 * 1024)
const SANDBOX_NANO_CPUS = parseLimit(Bun.env.SANDBOX_NANO_CPUS, 500_000_000)

const SANDBOX_LABEL = 'com.live-coding-session.sandbox'
const SANDBOX_CLIENT_ID_LABEL = 'com.live-coding-session.client-id'
const SANDBOX_EXECUTION_ID_LABEL = 'com.live-coding-session.execution-id'

const LANGUAGE_RUNTIME_MAP: Record<string, LanguageRuntime> = {
  python: {
    image: 'python:3.14-alpine',
    fileName: 'main.py',
    executeCommand: 'python /workspace/main.py',
  },
  javascript: {
    image: 'node:20-alpine',
    fileName: 'main.js',
    executeCommand: 'node /workspace/main.js',
  },
}
const imagePullCache = new Set<string>()

const normalizeLanguage = (language: string) => language.trim().toLowerCase()

const truncateOutput = (value: string, maxChars: number) => {
  if (maxChars <= 0) {
    return ''
  }

  if (value.length <= maxChars) {
    return value
  }

  return `${value.slice(0, maxChars)}\n[output truncated to ${maxChars} characters]`
}

const shellScriptForRuntime = (runtime: LanguageRuntime) => {
  return [
    'set -euo pipefail',
    'mkdir -p /workspace',
    `printf "%s" "$SOURCE_CODE_BASE64" | base64 -d > /workspace/${runtime.fileName}`,
    runtime.executeCommand,
  ].join(' && ')
}

const ensureImageExists = async (image: string) => {
  if (imagePullCache.has(image)) {
    return
  }

  try {
    await docker.getImage(image).inspect()
    imagePullCache.add(image)
    return
  } catch {
    // Fall through to pull image.
  }

  const stream = await docker.pull(image)
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })

  imagePullCache.add(image)
}

const getSandboxContainerCount = async (clientId?: string) => {
  const labelFilters = [`${SANDBOX_LABEL}=true`]

  if (clientId) {
    labelFilters.push(`${SANDBOX_CLIENT_ID_LABEL}=${clientId}`)
  }

  const containers = await docker.listContainers({
    all: true,
    filters: {
      label: labelFilters,
    },
  })

  return containers.length
}

const assertContainerCapacity = async (clientId?: string) => {
  const totalCount = await getSandboxContainerCount()
  if (totalCount >= MAX_SANDBOX_CONTAINERS) {
    throw new Error(
      `Sandbox capacity reached (${MAX_SANDBOX_CONTAINERS} containers). Try again later.`,
    )
  }

  if (!clientId) {
    return
  }

  const clientCount = await getSandboxContainerCount(clientId)
  if (clientCount >= MAX_SANDBOX_CONTAINERS_PER_CLIENT) {
    throw new Error(
      `Client sandbox limit reached (${MAX_SANDBOX_CONTAINERS_PER_CLIENT} containers).`,
    )
  }
}

export const runCodeInSandbox = async (
  language: string,
  sourceCode: string,
  timeoutMs: number,
  maxOutputChars: number,
  options: SandboxExecutionOptions = {},
): Promise<SandboxExecutionResult> => {
  const normalizedLanguage = normalizeLanguage(language)
  const runtime = LANGUAGE_RUNTIME_MAP[normalizedLanguage]
  if (!runtime) {
    throw new Error(`Unsupported language: ${language}`)
  }

  const clientId = options.clientId?.trim() || 'anonymous'

  await assertContainerCapacity(clientId)
  await ensureImageExists(runtime.image)

  const createdAt = Date.now()
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []

  const container = await docker.createContainer({
    Image: runtime.image,
    Cmd: ['sh', '-lc', shellScriptForRuntime(runtime)],
    Env: [`SOURCE_CODE_BASE64=${Buffer.from(sourceCode).toString('base64')}`],
    Tty: false,
    OpenStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Labels: {
      [SANDBOX_LABEL]: 'true',
      [SANDBOX_CLIENT_ID_LABEL]: clientId,
      [SANDBOX_EXECUTION_ID_LABEL]: options.executionId?.trim() || 'unknown',
    },
    HostConfig: {
      NetworkMode: 'none',
      Memory: SANDBOX_MEMORY_BYTES,
      NanoCpus: SANDBOX_NANO_CPUS,
      PidsLimit: 64,
      ReadonlyRootfs: true,
      SecurityOpt: ['no-new-privileges'],
      CapDrop: ['ALL'],
      Tmpfs: {
        '/tmp': 'rw,nosuid,nodev,noexec,size=64m',
        '/workspace': 'rw,nosuid,nodev,noexec,size=16m',
      },
    },
  })

  let timedOut = false
  let exitCode: number | null = null
  let timeoutHandle: NodeJS.Timeout | null = null

  try {
    const attachStream = await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    })

    const stdoutStream = new PassThrough()
    stdoutStream.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk.toString('utf-8'))
    })

    const stderrStream = new PassThrough()
    stderrStream.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString('utf-8'))
    })

    docker.modem.demuxStream(attachStream, stdoutStream, stderrStream)

    await container.start()

    const waitPromise = container.wait()
    timeoutHandle = setTimeout(async () => {
      timedOut = true
      try {
        await container.stop({ t: 0 })
      } catch {
        try {
          await container.kill()
        } catch {
          // Ignore: container may have already exited.
        }
      }
    }, timeoutMs)

    const waitResult = await waitPromise
    exitCode = typeof waitResult.StatusCode === 'number' ? waitResult.StatusCode : null

    return {
      stdout: truncateOutput(stdoutChunks.join(''), maxOutputChars),
      stderr: truncateOutput(stderrChunks.join(''), maxOutputChars),
      exitCode,
      timedOut,
      execution_time_ms: Date.now() - createdAt,
    }
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
    }

    try {
      await container.remove({ force: true })
    } catch {
      // Ignore cleanup errors to avoid masking execution result.
    }
  }
}