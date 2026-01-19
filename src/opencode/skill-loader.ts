import { existsSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

export interface SkillDefinition {
  name: string;
  path: string;
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

export function loadProjectSkills(projectPath: string): SkillDefinition[] {
  const skillsRoot = join(projectPath, '.drs', 'skills');
  const files = traverseDirectory(skillsRoot, skillsRoot, (entry) => skillFileNames.has(entry));

  return files.map((filePath) => ({
    name: resolveSkillName(skillsRoot, filePath),
    path: filePath,
  }));
}
