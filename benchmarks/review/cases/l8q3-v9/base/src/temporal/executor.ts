type Options = { workingDir: string };
type Result = { workflowId: string };

export async function execute(options: Options): Promise<Result> {
  return { workflowId: options.workingDir };
}
