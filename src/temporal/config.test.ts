import { describe, expect, it } from 'vitest';
import type { DRSConfig } from '../lib/config.js';
import { resolveTemporalConfig } from './config.js';

describe('resolveTemporalConfig', () => {
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
});
