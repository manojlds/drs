import { existsSync } from 'fs';
import { join } from 'path';
import {
  getSkillStatuses,
  installFactorySkills,
  syncBundledSkills,
  type SkillStatus,
} from './skills.js';

export interface ProjectSetupStatus {
  initialized: boolean;
  configPath: string;
  skills: SkillStatus[];
  issues: string[];
}

export function getProjectSetupStatus(workingDir: string): ProjectSetupStatus {
  const configPath = '.drs/drs.config.yaml';
  const initialized = existsSync(join(workingDir, configPath));
  const skills = getSkillStatuses(workingDir);
  const issues: string[] = [];
  if (!initialized) issues.push('missing-config');
  for (const skill of skills) {
    if (!skill.installed) issues.push(`missing-skill:${skill.name}`);
    else if (skill.modified) issues.push(`modified-skill:${skill.name}`);
    else if (skill.outdated) issues.push(`outdated-skill:${skill.name}`);
  }
  return { initialized, configPath, skills, issues };
}

export function syncProjectSetup(workingDir: string): ProjectSetupStatus {
  const factorySkill = getSkillStatuses(workingDir).find(
    (skill) => skill.name === 'drs-factory-planning'
  );
  if (!factorySkill?.installed) installFactorySkills(workingDir);
  syncBundledSkills(workingDir);
  return getProjectSetupStatus(workingDir);
}
