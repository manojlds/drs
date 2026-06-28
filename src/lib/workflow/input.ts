import type { WorkflowInputConfig } from '../config.js';

export type WorkflowInputConfigType = 'string' | 'boolean' | 'number' | 'enum';

export function getWorkflowInputConfigType(input: WorkflowInputConfig): WorkflowInputConfigType {
  return typeof input === 'string' ? 'string' : (input.type ?? 'string');
}
