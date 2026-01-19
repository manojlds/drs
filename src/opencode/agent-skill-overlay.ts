import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join, relative } from 'path';
import { tmpdir } from 'os';
import * as yaml from 'yaml';
import type { DRSConfig } from '../lib/config.js';
import { builtInAgentPath } from './opencode-paths.js';
import { loadProjectSkills, type SkillDefinition } from './skill-loader.js';

export interface AgentSkillOverlay {
  root: string;
  cleanup: () => Promise<void>;
}

export type SkillConfig = DRSConfig['skills'];

const SKILL_FILE_NAME = 'SKILL.md';

function normalizeSkillList(skills: unknown): string[] {
  if (!Array.isArray(skills)) {
    return [];
  }
  return skills.map(String).filter((skill) => skill.length > 0);
}

function resolveConfiguredSkills(skillConfig: SkillConfig, agentName: string): string[] {
  if (!skillConfig) {
    return [];
  }

  const normalizedName = agentName.startsWith('review/') ? agentName.slice(7) : agentName;
  const defaultSkills = normalizeSkillList(skillConfig.default);
  const normalizedAgentSkills = normalizeSkillList(skillConfig.agents?.[normalizedName]);
  const perAgentSkills =
    normalizedAgentSkills.length > 0
      ? normalizedAgentSkills
      : normalizeSkillList(skillConfig.agents?.[agentName]);

  return Array.from(new Set([...defaultSkills, ...perAgentSkills]));
}

function upsertAgentSkills(content: string, skills: string[]): string {
  if (skills.length === 0) {
    return content;
  }

  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  const parsed = frontmatterMatch ? yaml.parse(frontmatterMatch[1]) : {};
  const frontmatter = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};

  const existingSkills = normalizeSkillList(frontmatter?.skills);
  const mergedSkills = Array.from(new Set([...existingSkills, ...skills]));

  const updatedFrontmatter = {
    ...frontmatter,
    skills: mergedSkills,
  };

  const frontmatterText = yaml.stringify(updatedFrontmatter).trimEnd();
  const newFrontmatter = `---\n${frontmatterText}\n---\n`;

  if (frontmatterMatch) {
    return `${newFrontmatter}${content.slice(frontmatterMatch[0].length)}`;
  }

  return `${newFrontmatter}\n${content}`;
}

async function writeFileWithSkills(
  sourcePath: string,
  targetPath: string,
  agentName: string,
  skillConfig: SkillConfig
): Promise<void> {
  const content = await readFile(sourcePath, 'utf-8');
  const skills = resolveConfiguredSkills(skillConfig, agentName);
  const updatedContent = upsertAgentSkills(content, skills);

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, updatedContent);
}

async function traverseDirectory(
  currentPath: string,
  fileFilter: (entry: string, fullPath: string) => boolean
): Promise<string[]> {
  const files: string[] = [];

  if (!existsSync(currentPath)) {
    return files;
  }

  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(currentPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await traverseDirectory(fullPath, fileFilter)));
    } else if (entry.isFile() && fileFilter(entry.name, fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function resolveOverrideAgentName(overrideRoot: string, filePath: string): string {
  const relativePath = relative(overrideRoot, filePath).replace(/\\/g, '/');
  const stripped = relativePath.replace(/\/agent\.md$/, '');
  return stripped.startsWith('review/') ? stripped : `review/${stripped}`;
}

async function copyBuiltInAgents(destinationRoot: string, skillConfig: SkillConfig): Promise<void> {
  const files = await traverseDirectory(builtInAgentPath, (entry) => entry.endsWith('.md'));

  const results = await Promise.allSettled(
    files.map(async (filePath) => {
      const relativePath = relative(builtInAgentPath, filePath).replace(/\\/g, '/');
      const agentName = relativePath.replace(/\.md$/, '').replace(/\\/g, '/');
      const targetPath = join(destinationRoot, relativePath);
      await writeFileWithSkills(filePath, targetPath, agentName, skillConfig);
    })
  );

  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    throw new Error(`Failed to prepare ${failures.length} built-in agent(s)`);
  }
}

async function copyOverrideAgents(
  projectPath: string,
  destinationRoot: string,
  skillConfig: SkillConfig
): Promise<void> {
  const overrideRoot = join(projectPath, '.drs', 'agents');
  const files = await traverseDirectory(overrideRoot, (entry) => entry === 'agent.md');

  const results = await Promise.allSettled(
    files.map(async (filePath) => {
      const agentName = resolveOverrideAgentName(overrideRoot, filePath);
      const targetPath = join(destinationRoot, `${agentName}.md`);
      await writeFileWithSkills(filePath, targetPath, agentName, skillConfig);
    })
  );

  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    throw new Error(`Failed to prepare ${failures.length} override agent(s)`);
  }
}

async function copyProjectSkills(
  projectPath: string,
  destinationRoot: string
): Promise<SkillDefinition[]> {
  const skills = loadProjectSkills(projectPath);

  const results = await Promise.allSettled(
    skills.map(async (skill) => {
      const targetPath = join(destinationRoot, skill.name, SKILL_FILE_NAME);
      const content = await readFile(skill.path, 'utf-8');
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content);
    })
  );

  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    throw new Error(`Failed to prepare ${failures.length} skill file(s)`);
  }

  return skills;
}

export async function createAgentSkillOverlay(
  projectPath: string,
  skillConfig: SkillConfig
): Promise<AgentSkillOverlay | null> {
  const hasSkillConfig = Boolean(skillConfig?.default?.length || skillConfig?.agents);
  const skills = loadProjectSkills(projectPath);

  if (!hasSkillConfig && skills.length === 0) {
    return null;
  }

  const overlayRoot = await mkdtemp(join(tmpdir(), 'drs-opencode-'));

  const opencodeRoot = join(overlayRoot, '.opencode');
  const agentRoot = join(opencodeRoot, 'agent');
  const skillRoot = join(opencodeRoot, 'skills');

  await mkdir(agentRoot, { recursive: true });
  await mkdir(skillRoot, { recursive: true });

  try {
    await copyBuiltInAgents(agentRoot, skillConfig);
    await copyOverrideAgents(projectPath, agentRoot, skillConfig);
    await copyProjectSkills(projectPath, skillRoot);
  } catch (error) {
    await rm(overlayRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    root: overlayRoot,
    cleanup: async () => {
      await rm(overlayRoot, { recursive: true, force: true });
    },
  };
}
