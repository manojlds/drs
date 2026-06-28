import type { DRSConfig } from '../config.js';
import type { WorkflowRunOptions, WorkflowRunResult } from './types.js';

/**
 * Execution backend for DRS workflows.
 *
 * The CLI's default backend is the local in-process executor. A Temporal
 * executor will implement this same interface so that `drs workflow run` can
 * dispatch through either backend without changing the workflow DSL or the
 * result shape.
 */
export interface WorkflowExecutor {
  /**
   * Run a workflow by name using the project config and return the same
   * `WorkflowRunResult` shape as the local executor.
   */
  run(
    config: DRSConfig,
    workflowName: string,
    options?: WorkflowRunOptions
  ): Promise<WorkflowRunResult>;
}
