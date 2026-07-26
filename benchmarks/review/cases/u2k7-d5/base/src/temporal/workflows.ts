type Result = { status: 'success' | 'failed' };

export function startWorkflow(runNode: (id: string) => Promise<Result>) {
  let start!: () => void;
  const startGate = new Promise<void>((resolve) => { start = resolve; });
  const done = (async () => {
    await startGate;
    return runNode('build');
  })();
  return { start, done };
}
