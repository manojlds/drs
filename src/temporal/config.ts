import type { DRSConfig } from '../lib/config.js';
import type { TemporalConfig } from './types.js';

const DEFAULT_TEMPORAL_CONFIG: TemporalConfig = {
  address: 'localhost:7233',
  namespace: 'default',
  taskQueue: 'drs-workflows',
  workflowIdPrefix: 'drs',
  workspace: {
    mode: 'local',
    root: '/tmp/drs-temporal-workspaces',
  },
};

export function resolveTemporalConfig(config: DRSConfig): TemporalConfig {
  const configured = config.temporal ?? {};
  const configuredWorkspace = configured.workspace ?? {};
  const envMode = process.env.DRS_TEMPORAL_WORKSPACE_MODE;
  const mode = envMode === 'managed' || envMode === 'local' ? envMode : configuredWorkspace.mode;

  return {
    ...DEFAULT_TEMPORAL_CONFIG,
    ...configured,
    address:
      process.env.DRS_TEMPORAL_ADDRESS ?? configured.address ?? DEFAULT_TEMPORAL_CONFIG.address,
    namespace:
      process.env.DRS_TEMPORAL_NAMESPACE ??
      configured.namespace ??
      DEFAULT_TEMPORAL_CONFIG.namespace,
    taskQueue:
      process.env.DRS_TEMPORAL_TASK_QUEUE ??
      configured.taskQueue ??
      DEFAULT_TEMPORAL_CONFIG.taskQueue,
    workspace: {
      ...DEFAULT_TEMPORAL_CONFIG.workspace,
      ...configuredWorkspace,
      ...(mode ? { mode } : {}),
      ...(process.env.DRS_TEMPORAL_WORKSPACE_ROOT
        ? { root: process.env.DRS_TEMPORAL_WORKSPACE_ROOT }
        : {}),
    },
  };
}
