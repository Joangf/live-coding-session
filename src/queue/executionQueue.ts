import { Queue } from 'bullmq';
const REDIS_URL = String(Bun.env.REDIS_URL);
export const ExecutionQueue = new Queue('Execution', {
  connection: {
    url: REDIS_URL,
  },
});
export const makeExecutionJob = async (session_id: string, execution_id: string) => {
  const job = await ExecutionQueue.add('execute-code', { session_id, execution_id }, {
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  });
  return job.id;
}