import { existsSync } from 'fs';
import { join } from 'path';

export interface ProjectSetupStatus {
  initialized: boolean;
  configPath: string;
  issues: string[];
}

export function getProjectSetupStatus(workingDir: string): ProjectSetupStatus {
  const configPath = '.drs/drs.config.yaml';
  const initialized = existsSync(join(workingDir, configPath));
  const issues: string[] = [];
  if (!initialized) issues.push('missing-config');
  return { initialized, configPath, issues };
}
