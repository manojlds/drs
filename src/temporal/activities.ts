import { loadConfig } from '../lib/config.js';
import { runWorkflowNodeLocally } from '../cli/workflow.js';
import type { RunWorkflowNodeActivityInput } from './types.js';

export async function runWorkflowNodeActivity(input: RunWorkflowNodeActivityInput) {
  const config = loadConfig(input.workingDir);
  return runWorkflowNodeLocally(
    config,
    input.nodeId,
    input.node,
    {
      debug: input.options?.debug,
      thinkingLevel: input.options?.thinkingLevel,
      workingDir: input.workingDir,
      jsonOutput: true,
      trace: false,
    },
    input.workingDir,
    input.context
  );
}
