import { LocalWorkflowExecutor } from './workflow.js';
import type { WorkflowExecutor } from '../lib/workflow/executor.js';
import { TemporalWorkflowExecutor } from '../temporal/executor.js';

export function createWorkflowExecutor(executorName = 'local', wait = true): WorkflowExecutor {
  if (executorName !== 'temporal' && !wait) {
    throw new Error('--no-wait is only supported with --executor temporal.');
  }

  if (executorName === 'temporal') {
    return new TemporalWorkflowExecutor();
  }
  if (executorName === 'local') {
    return new LocalWorkflowExecutor();
  }

  throw new Error(`Unsupported workflow executor "${executorName}".`);
}
