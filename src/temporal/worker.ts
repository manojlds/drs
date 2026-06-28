import { fileURLToPath } from 'url';
import { Worker, NativeConnection } from '@temporalio/worker';
import type { DRSConfig } from '../lib/config.js';
import { resolveTemporalConfig } from './config.js';
import * as activities from './activities.js';

export async function runTemporalWorker(config: DRSConfig): Promise<void> {
  const temporal = resolveTemporalConfig(config);
  const workflowModule = import.meta.url.endsWith('.ts') ? './workflows.ts' : './workflows.js';
  const connection = await NativeConnection.connect({ address: temporal.address });
  const worker = await Worker.create({
    connection,
    namespace: temporal.namespace,
    taskQueue: temporal.taskQueue,
    workflowsPath: fileURLToPath(new URL(workflowModule, import.meta.url)),
    activities,
  });
  await worker.run();
}
