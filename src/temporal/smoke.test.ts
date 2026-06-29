import { fileURLToPath } from 'url';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NativeConnection, Worker } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';
import type { DRSConfig } from '../lib/config.js';
import { TemporalWorkflowExecutor } from './executor.js';
import * as activities from './activities.js';

const describeTemporalSmoke = process.env.DRS_TEMPORAL_SMOKE === '1' ? describe : describe.skip;

describeTemporalSmoke('Temporal local server smoke', () => {
  it('runs a safe workflow through a real worker and Temporal server', async () => {
    const workingDir = mkdtempSync(join(tmpdir(), 'drs-temporal-smoke-'));
    const address = process.env.DRS_TEMPORAL_ADDRESS ?? 'localhost:7233';
    const namespace = process.env.DRS_TEMPORAL_NAMESPACE ?? 'default';
    const taskQueue = `drs-smoke-${process.pid}-${Date.now()}`;
    const workflowModule = import.meta.url.endsWith('.ts') ? './workflows.ts' : './workflows.js';
    const connection = await NativeConnection.connect({ address });

    try {
      const worker = await Worker.create({
        connection,
        namespace,
        taskQueue,
        workflowsPath: fileURLToPath(new URL(workflowModule, import.meta.url)),
        activities,
      });

      const config = {
        temporal: {
          address,
          namespace,
          taskQueue,
          workflowIdPrefix: 'drs-smoke',
        },
        workflows: {
          smoke: {
            output: 'result',
            nodes: {
              write: {
                action: 'write',
                input: 'temporal smoke ok',
                writes: '.drs/temporal-smoke.txt',
                output: 'result',
              },
            },
          },
        },
      } as unknown as DRSConfig;

      const result = await worker.runUntil(() =>
        new TemporalWorkflowExecutor().run(config, 'smoke', {
          workingDir,
          jsonOutput: true,
        })
      );

      expect(result.output).toBe('temporal smoke ok');
      expect(result.nodes['write']).toMatchObject({ status: 'success' });
    } finally {
      await connection.close();
      rmSync(workingDir, { recursive: true, force: true });
    }
  }, 30_000);
});
