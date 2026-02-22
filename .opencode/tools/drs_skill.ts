import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { tool } from '@opencode-ai/plugin';

type SkillPayload = {
  _tool: 'drs_skill'; // Tool identifier for log parsing
  skill_name: string;
  instructions: string;
  base_directory: string;
  has_scripts: boolean;
  has_references: boolean;
  has_assets: boolean;
};

const skillFileNames = ['SKILL.md', 'skill.md'];

function resolveSkillPath(skillRoot: string): string | null {
  for (const fileName of skillFileNames) {
    const candidate = join(skillRoot, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function parseSkillInstructions(content: string): string {
  const frontmatterMatch = content.match(/^---\n[\s\S]*?\n---\n?/);
  if (!frontmatterMatch) {
    return content.trim();
  }
  return content.slice(frontmatterMatch[0].length).trim();
}

function normalizeSkillsRoot(projectRoot: string, configuredRoot: string): string {
  return isAbsolute(configuredRoot) ? resolve(configuredRoot) : resolve(projectRoot, configuredRoot);
}

function resolveDefaultSkillsRoots(projectRoot: string): string[] {
  const candidates = [join(projectRoot, '.drs', 'skills'), join(projectRoot, '.pi', 'skills')];

  const existing = candidates.filter((candidate) => {
    if (!existsSync(candidate)) {
      return false;
    }

    try {
      return statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });

  return existing.length > 0 ? existing : [candidates[0]];
}

function resolveSkillsRoots(projectRoot: string): string[] {
  const configuredRoots =
    process.env.DRS_SKILLS_ROOTS
      ?.split(delimiter)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0) ?? [];

  if (configuredRoots.length > 0) {
    return configuredRoots.map((entry) => normalizeSkillsRoot(projectRoot, entry));
  }

  const configuredRoot = process.env.DRS_SKILLS_ROOT?.trim();
  if (configuredRoot) {
    return [normalizeSkillsRoot(projectRoot, configuredRoot)];
  }

  return resolveDefaultSkillsRoots(projectRoot);
}

function readSkill(skillName: string): SkillPayload {
  const projectRoot = process.env.DRS_PROJECT_ROOT ?? process.cwd();
  const skillsRoots = resolveSkillsRoots(projectRoot);

  const searchedPaths: string[] = [];
  for (const skillsRoot of skillsRoots) {
    const skillRoot = join(skillsRoot, skillName);
    searchedPaths.push(skillRoot);

    const skillPath = resolveSkillPath(skillRoot);
    if (!skillPath) {
      continue;
    }

    const content = readFileSync(skillPath, 'utf-8');
    const instructions = parseSkillInstructions(content);
    const skillDir = dirname(skillPath);
    console.log(`[drs_skill] Loaded skill "${skillName}" from ${skillPath}`);

    return {
      _tool: 'drs_skill',
      skill_name: skillName,
      instructions,
      base_directory: skillDir,
      has_scripts: existsSync(join(skillDir, 'scripts')),
      has_references: existsSync(join(skillDir, 'references')),
      has_assets: existsSync(join(skillDir, 'assets')),
    };
  }

  throw new Error(`Skill "${skillName}" not found. Searched: ${searchedPaths.join(', ')}`);
}

export default tool({
  description:
    'Load a DRS skill on-demand from configured skill directories (defaults to .drs/skills with .pi/skills auto-discovery).',
  args: {
    name: tool.schema.string().describe('Skill name to activate'),
  },
  async execute({ name }): Promise<SkillPayload> {
    return readSkill(name);
  },
});
