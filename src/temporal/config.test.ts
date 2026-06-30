import { afterEach, describe, expect, it } from 'vitest';
import type { DRSConfig } from '../lib/config.js';
import { resolveTemporalConfig } from './config.js';

describe('resolveTemporalConfig', () => {
  const envKeys = [
    'DRS_TEMPORAL_ADDRESS',
    'DRS_TEMPORAL_NAMESPACE',
    'DRS_TEMPORAL_TASK_QUEUE',
    'DRS_TEMPORAL_WORKSPACE_MODE',
    'DRS_TEMPORAL_WORKSPACE_ROOT',
  ];

  afterEach(() => {
    for (const key of envKeys) {
      delete process.env[key];
    }
  });

  it('uses development defaults', () => {
    const config = {} as DRSConfig;
    expect(resolveTemporalConfig(config)).toEqual({
      address: 'localhost:7233',
      namespace: 'default',
      taskQueue: 'drs-workflows',
      workflowIdPrefix: 'drs',
      workspace: {
        mode: 'local',
        root: '/tmp/drs-temporal-workspaces',
      },
    });
  });

  it('allows project overrides', () => {
    const config = {
      temporal: {
        address: 'temporal.example.com:7233',
        namespace: 'prod',
        taskQueue: 'repo-maintenance',
        workflowIdPrefix: 'repo',
        workspace: {
          mode: 'managed',
          root: '/var/lib/drs/workspaces',
        },
      },
    } as DRSConfig;
    expect(resolveTemporalConfig(config)).toEqual({
      address: 'temporal.example.com:7233',
      namespace: 'prod',
      taskQueue: 'repo-maintenance',
      workflowIdPrefix: 'repo',
      workspace: {
        mode: 'managed',
        root: '/var/lib/drs/workspaces',
      },
    });
  });

  it('lets environment variables override config and defaults', () => {
    process.env.DRS_TEMPORAL_ADDRESS = 'env-host:7233';
    process.env.DRS_TEMPORAL_NAMESPACE = 'env-ns';
    process.env.DRS_TEMPORAL_TASK_QUEUE = 'env-queue';

    const config = {
      temporal: {
        address: 'temporal.example.com:7233',
        namespace: 'prod',
        taskQueue: 'repo-maintenance',
      },
    } as DRSConfig;

    expect(resolveTemporalConfig(config)).toMatchObject({
      address: 'env-host:7233',
      namespace: 'env-ns',
      taskQueue: 'env-queue',
    });
  });

  it('falls back to config when env vars are not set', () => {
    const config = {
      temporal: {
        address: 'temporal.example.com:7233',
        namespace: 'prod',
        taskQueue: 'repo-maintenance',
      },
    } as DRSConfig;

    expect(resolveTemporalConfig(config)).toMatchObject({
      address: 'temporal.example.com:7233',
      namespace: 'prod',
      taskQueue: 'repo-maintenance',
    });
  });
});
