import type { DRSConfig } from '../lib/config.js';
import type { TemporalConfig } from './types.js';

const DEFAULT_TEMPORAL_CONFIG: TemporalConfig = {
  address: 'localhost:7233',
  namespace: 'default',
  taskQueue: 'drs-workflows',
  workflowIdPrefix: 'drs',
};

export function resolveTemporalConfig(config: DRSConfig): TemporalConfig {
  return {
    ...DEFAULT_TEMPORAL_CONFIG,
    ...(config.temporal ?? {}),
  };
}
