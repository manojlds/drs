import type { DRSConfig } from './config.js';
import { getDefaultSkills, normalizeAgentConfig } from './config.js';
import { loadProjectSkills } from '../opencode/skill-loader.js';

type SkillsPromptFormat = 'text' | 'xml';

type SkillSummary = {
  name: string;
  description: string;
};

function normalizeSkillList(skills: unknown): string[] {
  if (!Array.isArray(skills)) {
    return [];
  }
  return skills.map(String).filter((skill) => skill.length > 0);
}

function resolveConfiguredSkills(config: DRSConfig, agentName: string): string[] {
  const normalizedAgents = normalizeAgentConfig(config.review.agents);
  const normalizedName = agentName.startsWith('review/') ? agentName.slice(7) : agentName;
  const entry =
    normalizedAgents.find((agent) => agent.name === normalizedName) ??
    normalizedAgents.find((agent) => agent.name === agentName);
  const defaultSkills = normalizeSkillList(getDefaultSkills(config));
  const agentSkills = entry ? normalizeSkillList(entry.skills) : [];
  const mergedSkills = new Set([...defaultSkills, ...agentSkills]);
  return Array.from(mergedSkills);
}

function buildAvailableSkillsXml(skills: SkillSummary[]): string {
  if (skills.length === 0) {
    return '<available_skills>\nNo skills available.\n</available_skills>';
  }

  const lines = ['<available_skills>'];
  for (const skill of skills) {
    const description = skill.description
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    lines.push('  <skill>');
    lines.push(`    <name>${skill.name}</name>`);
    lines.push(`    <description>${description}</description>`);
    lines.push('  </skill>');
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

function buildAvailableSkillsText(skills: SkillSummary[]): string {
  if (skills.length === 0) {
    return 'No skills available.';
  }

  const lines = ['Available Skills:'];
  for (const skill of skills) {
    const description = skill.description ? `: ${skill.description}` : '';
    lines.push(`- ${skill.name}${description}`);
  }
  return lines.join('\n');
}

function buildSkillsPrompt(skills: SkillSummary[], format: SkillsPromptFormat): string {
  return format === 'xml' ? buildAvailableSkillsXml(skills) : buildAvailableSkillsText(skills);
}

export function buildSkillPromptSection(
  config: DRSConfig,
  agentName: string,
  projectRoot: string
): string | null {
  const configuredSkills = resolveConfiguredSkills(config, agentName);
  if (configuredSkills.length === 0) {
    return null;
  }

  const promptFormat: SkillsPromptFormat =
    config.review.default?.skillsPromptFormat === 'text' ? 'text' : 'xml';
  const projectSkills = new Map(
    loadProjectSkills(projectRoot, config).map((skill) => [skill.name, skill])
  );
  const availableSkills = configuredSkills
    .map((skillName) => projectSkills.get(skillName))
    .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill))
    .map((skill) => ({ name: skill.name, description: skill.description }));
  const missingSkills = configuredSkills.filter((skillName) => !projectSkills.has(skillName));
  if (missingSkills.length > 0) {
    console.warn(`⚠️  Missing skill definitions for: ${missingSkills.join(', ')}`);
  }

  const prompt = buildSkillsPrompt(availableSkills, promptFormat);
  return `# Skills\n\n${prompt}\n\nThese skills are loaded directly by the Pi runtime. Use the most relevant skill guidance while reviewing.`;
}
