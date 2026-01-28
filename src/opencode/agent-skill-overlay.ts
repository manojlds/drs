import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'fs/promises';
import { existsSync, lstatSync } from 'fs';
import { dirname, join, relative } from 'path';
import { tmpdir } from 'os';
import * as yaml from 'yaml';
import type { AgentConfig, DRSConfig } from '../lib/config.js';
import { getDefaultSkills, normalizeAgentConfig } from '../lib/config.js';
import { builtInAgentPath } from './opencode-paths.js';
import { loadProjectSkills, type SkillDefinition } from './skill-loader.js';

export interface AgentSkillOverlay {
  root: string;
  skillSymlink?: string; // Path to symlink in project directory
  cleanup: () => Promise<void>;
}

export type SkillConfig = {
  defaultSkills: string[];
  agents: AgentConfig[];
};

const SKILL_FILE_NAME = 'SKILL.md';

function normalizeSkillList(skills: unknown): string[] {
  if (!Array.isArray(skills)) {
    return [];
  }
  return skills.map(String).filter((skill) => skill.length > 0);
}

function resolveConfiguredSkills(skillConfig: SkillConfig, agentName: string): string[] {
  if (!skillConfig || skillConfig.agents.length === 0) {
    return [];
  }

  const normalizedName = agentName.startsWith('review/') ? agentName.slice(7) : agentName;
  const entry =
    skillConfig.agents.find((agent) => agent.name === normalizedName) ??
    skillConfig.agents.find((agent) => agent.name === agentName);

  const defaultSkills = normalizeSkillList(skillConfig.defaultSkills);
  const agentSkills = entry ? normalizeSkillList(entry.skills) : [];
  const mergedSkills = new Set([...defaultSkills, ...agentSkills]);

  if (mergedSkills.size === 0) {
    return [];
  }

  return Array.from(mergedSkills);
}

function upsertAgentSkills(content: string, skills: string[]): string {
  if (skills.length === 0) {
    return content;
  }

  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  const parsed = frontmatterMatch ? yaml.parse(frontmatterMatch[1]) : {};
  const frontmatter = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};

  // Enable the skill tool and set permissions for configured skills
  // OpenCode uses on-demand skill loading via the 'skill' tool, not preloaded skills
  const updatedFrontmatter = {
    ...frontmatter,
    tools: {
      ...(frontmatter.tools || {}),
      skill: true, // Enable the skill tool
    },
    permission: {
      ...(frontmatter.permission || {}),
      skill: {
        // Allow all skills by default - could be made more granular if needed
        '*': 'allow',
      },
    },
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

/**
 * Create a symlink in the project's .opencode/skills directory pointing to
 * the overlay's skills directory. This allows OpenCode to discover skills
 * when sessions run with the project directory as their working directory.
 */
async function createSkillSymlink(
  projectPath: string,
  overlaySkillRoot: string
): Promise<string | undefined> {
  const projectOpencodeDir = join(projectPath, '.opencode');
  const projectSkillsPath = join(projectOpencodeDir, 'skills');

  // Check if .opencode/skills already exists in the project
  if (existsSync(projectSkillsPath)) {
    // Check if it's already a symlink (from a previous run that didn't clean up)
    try {
      const stats = lstatSync(projectSkillsPath);
      if (stats.isSymbolicLink()) {
        // Remove stale symlink and create fresh one
        await unlink(projectSkillsPath);
      } else {
        // It's a real directory - don't modify it
        console.warn(
          '⚠️  Project already has .opencode/skills directory - skills may not be discoverable'
        );
        return undefined;
      }
    } catch {
      // Couldn't stat, skip symlink creation
      return undefined;
    }
  }

  // Create .opencode directory if it doesn't exist
  await mkdir(projectOpencodeDir, { recursive: true });

  // Create symlink: project/.opencode/skills -> overlay/.opencode/skills
  await symlink(overlaySkillRoot, projectSkillsPath, 'dir');

  return projectSkillsPath;
}

export async function createAgentSkillOverlay(
  projectPath: string,
  config: DRSConfig
): Promise<AgentSkillOverlay | null> {
  const normalizedAgents = normalizeAgentConfig(config.review.agents);
  const defaultSkills = getDefaultSkills(config);
  const hasSkillConfig =
    defaultSkills.length > 0 || normalizedAgents.some((agent) => (agent.skills ?? []).length > 0);
  const skills = loadProjectSkills(projectPath);

  if (!hasSkillConfig && skills.length === 0) {
    return null;
  }

  const overlayRoot = await mkdtemp(join(tmpdir(), 'drs-opencode-'));

  const opencodeRoot = join(overlayRoot, '.opencode');
  const agentRoot = join(opencodeRoot, 'agent');
  const skillRoot = join(opencodeRoot, 'skills');

  let skillSymlink: string | undefined;

  try {
    await mkdir(agentRoot, { recursive: true });
    await mkdir(skillRoot, { recursive: true });

    const skillConfig: SkillConfig = {
      defaultSkills,
      agents: normalizedAgents,
    };
    await copyBuiltInAgents(agentRoot, skillConfig);
    await copyOverrideAgents(projectPath, agentRoot, skillConfig);
    await copyProjectSkills(projectPath, skillRoot);

    // Create symlink so skills are discoverable from project directory
    // (OpenCode sessions run with project dir, not overlay dir)
    if (skills.length > 0) {
      skillSymlink = await createSkillSymlink(projectPath, skillRoot);
    }
  } catch (error) {
    // Clean up symlink if it was created
    if (skillSymlink) {
      await unlink(skillSymlink).catch(() => {});
    }
    await rm(overlayRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    root: overlayRoot,
    skillSymlink,
    cleanup: async () => {
      // Clean up symlink first
      if (skillSymlink) {
        await unlink(skillSymlink).catch(() => {});
      }
      await rm(overlayRoot, { recursive: true, force: true });
    },
  };
}
