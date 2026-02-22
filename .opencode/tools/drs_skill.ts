import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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

function resolveSkillsRoot(projectRoot: string): string {
  const configuredRoot = process.env.DRS_SKILLS_ROOT?.trim();
  if (!configuredRoot) {
    return join(projectRoot, '.drs', 'skills');
  }

  return isAbsolute(configuredRoot) ? configuredRoot : resolve(projectRoot, configuredRoot);
}

function readSkill(skillName: string): SkillPayload {
  const projectRoot = process.env.DRS_PROJECT_ROOT ?? process.cwd();
  const skillsRoot = resolveSkillsRoot(projectRoot);
  const skillRoot = join(skillsRoot, skillName);
  const skillPath = resolveSkillPath(skillRoot);
  if (!skillPath) {
    throw new Error(`Skill "${skillName}" not found in ${skillRoot}`);
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

export default tool({
  description:
    'Load a DRS skill on-demand from the configured skills directory (defaults to .drs/skills).',
  args: {
    name: tool.schema.string().describe('Skill name to activate'),
  },
  async execute({ name }): Promise<SkillPayload> {
    return readSkill(name);
  },
});
