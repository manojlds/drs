import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import * as yaml from 'yaml';

export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
  dir: string;
}

export interface SkillDefinition extends SkillMetadata {
  instructions: string;
  hasScripts: boolean;
  hasReferences: boolean;
  hasAssets: boolean;
}

const skillFileNames = new Set(['SKILL.md', 'skill.md']);

function traverseDirectory(
  basePath: string,
  currentPath: string,
  fileFilter: (entry: string, fullPath: string) => boolean
): string[] {
  const files: string[] = [];

  if (!existsSync(currentPath)) {
    return files;
  }

  const entries = readdirSync(currentPath);

  for (const entry of entries) {
    const fullPath = join(currentPath, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...traverseDirectory(basePath, fullPath, fileFilter));
    } else if (stat.isFile() && fileFilter(entry, fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function resolveSkillName(skillsRoot: string, filePath: string): string {
  const relativePath = relative(skillsRoot, filePath).replace(/\\/g, '/');
  const parentDir = relativePath.replace(/\/(SKILL|skill)\.md$/, '');
  const segments = parentDir.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? parentDir;
}

function parseSkillFrontmatter(content: string): { description: string; instructions: string } {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!frontmatterMatch) {
    return { description: '', instructions: content.trim() };
  }

  const parsed = yaml.parse(frontmatterMatch[1]);
  const frontmatter =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : ({} as Record<string, unknown>);

  const description =
    typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  const instructions = content.slice(frontmatterMatch[0].length).trim();

  return { description, instructions };
}

function buildSkillMetadata(skillsRoot: string, filePath: string): SkillMetadata {
  const content = readFileSync(filePath, 'utf-8');
  const { description } = parseSkillFrontmatter(content);
  const name = resolveSkillName(skillsRoot, filePath);
  const dir = dirname(filePath);

  return {
    name,
    description,
    path: filePath,
    dir,
  };
}

export function loadProjectSkills(projectPath: string): SkillMetadata[] {
  const skillsRoot = join(projectPath, '.drs', 'skills');
  const files = traverseDirectory(skillsRoot, skillsRoot, (entry) => skillFileNames.has(entry));

  return files.map((filePath) => buildSkillMetadata(skillsRoot, filePath));
}

function resolveSkillFilePath(projectPath: string, skillName: string): string | null {
  const skillRoot = join(projectPath, '.drs', 'skills', skillName);
  for (const fileName of skillFileNames) {
    const candidate = join(skillRoot, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function loadSkillByName(projectPath: string, skillName: string): SkillDefinition | null {
  const skillPath = resolveSkillFilePath(projectPath, skillName);
  if (!skillPath) {
    return null;
  }

  const content = readFileSync(skillPath, 'utf-8');
  const { description, instructions } = parseSkillFrontmatter(content);
  const dir = dirname(skillPath);

  return {
    name: skillName,
    description,
    instructions,
    path: skillPath,
    dir,
    hasScripts: existsSync(join(dir, 'scripts')),
    hasReferences: existsSync(join(dir, 'references')),
    hasAssets: existsSync(join(dir, 'assets')),
  };
}
