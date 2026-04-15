import { Elysia } from 'elysia';
import { openapi } from '@elysiajs/openapi';
import { api } from './api';
import { startExecutionWorker } from './core/executionWorker';

startExecutionWorker();

new Elysia()
  .use(openapi())
  .get('/', ({ redirect }) => redirect('/openapi'))
  .use(api)
  .listen(3000)
console.log('API server is running on 3000');