type Workflow = { nodes: Record<string, unknown>; inputs: Record<string, unknown> };
type Config = { workflows?: Record<string, Workflow> };

async function resolveWorkflowInputs(workflow: Workflow): Promise<Record<string, unknown>> {
  return workflow.inputs;
}

export async function executeWorkflowRun(
  config: Config,
  workflowName: string,
  workflowNodes: Record<string, unknown>
) {
  const workflow = config.workflows?.[workflowName];
  if (!workflow) throw new Error(`Unknown workflow "${workflowName}".`);
  return resolveWorkflowInputs(workflow);
}
