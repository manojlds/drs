import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tool } from '@opencode-ai/plugin';

type SkillPayload = {
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

function readSkill(skillName: string): SkillPayload {
  const projectRoot = process.env.DRS_PROJECT_ROOT ?? process.cwd();
  const skillRoot = join(projectRoot, '.drs', 'skills', skillName);
  const skillPath = resolveSkillPath(skillRoot);
  if (!skillPath) {
    throw new Error(`Skill "${skillName}" not found in ${skillRoot}`);
  }

  const content = readFileSync(skillPath, 'utf-8');
  const instructions = parseSkillInstructions(content);
  const skillDir = dirname(skillPath);
  console.log(`[drs_skill] Loaded skill "${skillName}" from ${skillPath}`);

  return {
    skill_name: skillName,
    instructions,
    base_directory: skillDir,
    has_scripts: existsSync(join(skillDir, 'scripts')),
    has_references: existsSync(join(skillDir, 'references')),
    has_assets: existsSync(join(skillDir, 'assets')),
  };
}

export default tool({
  description: 'Load a DRS skill on-demand from .drs/skills.',
  args: {
    name: tool.schema.string().describe('Skill name to activate'),
  },
  async execute({ name }): Promise<SkillPayload> {
    return readSkill(name);
  },
});
