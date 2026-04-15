import { Elysia } from 'elysia';
import { Service } from './service';
import { CodeExecutionModels } from './model';

export const api = new Elysia()
  .post('/code-sessions', ({ body }) => {
    return Service.createSession(body);
  }, {
    body: CodeExecutionModels.CreateSessionBody,
    response: CodeExecutionModels.CreateSessionResponse,
    detail: { summary: 'Create a new live coding session' }
  })

  .patch('/code-sessions/:session_id', ({ params, body }) => {
    return Service.updateSession(params.session_id, body);
  }, {
    params: CodeExecutionModels.SessionIdParam,
    body: CodeExecutionModels.PatchSessionBody,
    response: CodeExecutionModels.PatchSessionResponse,
    detail: { summary: 'Autosave the learner\'s current source code' }
  })

  .post('/code-sessions/:session_id/run', ({ params }) => {
    return Service.queueExecution(params.session_id);
  }, {
    params: CodeExecutionModels.SessionIdParam,
    response: CodeExecutionModels.RunSessionResponse,
    detail: { summary: 'Execute the current code asynchronously' }
  })

  .get('/executions/:execution_id', ({ params }) => {
    return Service.getExecution(params.execution_id);
  }, {
    params: CodeExecutionModels.ExecutionIdParam,
    response: CodeExecutionModels.GetExecutionResponse,
    detail: { summary: 'Retrieve execution status and result' }
  });