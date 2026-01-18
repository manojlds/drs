import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { DRSConfig } from './config.js';

/**
 * Represents a loaded skill from the skills directory
 */
export interface Skill {
  name: string;
  path: string;
  content: string;
}

/**
 * Load all available skills from the configured skills directory
 * Skills are expected to be in subdirectories with a SKILL.md file
 *
 * @param config - DRS configuration
 * @param projectPath - Base path of the project
 * @returns Array of loaded skills
 */
export function loadSkills(config: DRSConfig, projectPath: string = process.cwd()): Skill[] {
  if (!config.skills?.enabled) {
    return [];
  }

  const skillsDir = resolve(projectPath, config.skills.directory || '.drs/skills');

  if (!existsSync(skillsDir)) {
    return [];
  }

  const skills: Skill[] = [];

  try {
    const entries = readdirSync(skillsDir);

    for (const entry of entries) {
      const entryPath = join(skillsDir, entry);
      const stat = statSync(entryPath);

      if (stat.isDirectory()) {
        // Look for SKILL.md in the directory
        const skillFilePath = join(entryPath, 'SKILL.md');

        if (existsSync(skillFilePath)) {
          try {
            const content = readFileSync(skillFilePath, 'utf-8');
            skills.push({
              name: entry,
              path: skillFilePath,
              content,
            });
          } catch (error) {
            console.warn(`Warning: Failed to load skill from ${skillFilePath}:`, error);
          }
        }
      }
    }
  } catch (error) {
    console.warn(`Warning: Failed to read skills directory ${skillsDir}:`, error);
    return [];
  }

  return skills;
}

/**
 * Get skills that should be enabled for a specific agent
 * Combines global skills with agent-specific skills
 *
 * @param config - DRS configuration
 * @param agentName - Name of the agent
 * @param projectPath - Base path of the project
 * @returns Array of skills to enable for this agent
 */
export function getAgentSkills(
  config: DRSConfig,
  agentName: string,
  projectPath: string = process.cwd()
): Skill[] {
  if (!config.skills?.enabled) {
    return [];
  }

  // Load all available skills
  const allSkills = loadSkills(config, projectPath);

  if (allSkills.length === 0) {
    return [];
  }

  // Get skills to enable for this agent
  const skillsToEnable = new Set<string>();

  // Add global skills
  if (config.skills.global) {
    for (const skillName of config.skills.global) {
      skillsToEnable.add(skillName);
    }
  }

  // Add agent-specific skills
  const agentConfig = config.review.agents.find(
    (a) => (typeof a === 'string' ? a : a.name) === agentName
  );

  if (agentConfig && typeof agentConfig !== 'string' && agentConfig.skills) {
    for (const skillName of agentConfig.skills) {
      skillsToEnable.add(skillName);
    }
  }

  // Filter available skills to only those that should be enabled
  return allSkills.filter((skill) => skillsToEnable.has(skill.name));
}

/**
 * Build a skills context string to include in agent prompts
 *
 * @param skills - Array of skills to include
 * @returns Formatted string containing all skill contents
 */
export function buildSkillsContext(skills: Skill[]): string {
  if (skills.length === 0) {
    return '';
  }

  const skillSections = skills.map((skill) => {
    return `## Skill: ${skill.name}\n\n${skill.content}`;
  });

  return `# Available Skills

You have access to the following skills that provide additional context and instructions for your review:

${skillSections.join('\n\n---\n\n')}

Use these skills as guidance when performing your review. Follow the instructions and best practices defined in these skills.
`;
}
