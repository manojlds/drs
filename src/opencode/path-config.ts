import { existsSync, statSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';
import type { DRSConfig } from '../lib/config.js';

const DEFAULT_AGENT_PATH = '.drs/agents';
const DEFAULT_SKILL_PATH = '.drs/skills';

type ReviewPathType = 'agents' | 'skills';

export interface ResolvedReviewPaths {
  agentsPath: string;
  skillsPath: string;
}

function isOutsideProjectRoot(projectRoot: string, targetPath: string): boolean {
  const relativePath = relative(projectRoot, targetPath);
  const firstSegment = relativePath.split(/[\\/]/).filter(Boolean)[0];
  return firstSegment === '..';
}

function resolveConfiguredPath(
  projectRoot: string,
  configuredPath: unknown,
  fallbackPath: string,
  pathType: ReviewPathType
): string {
  if (configuredPath === undefined || configuredPath === null) {
    return resolve(projectRoot, fallbackPath);
  }

  if (typeof configuredPath !== 'string') {
    throw new Error(
      `Invalid review.paths.${pathType}: expected a string path. Use a repo-relative path like "${fallbackPath}" or an absolute path.`
    );
  }

  const trimmed = configuredPath.trim();
  if (!trimmed) {
    throw new Error(
      `Invalid review.paths.${pathType}: path cannot be empty. Use a repo-relative path like "${fallbackPath}" or an absolute path.`
    );
  }

  const resolvedPath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectRoot, trimmed);

  if (!isAbsolute(trimmed) && isOutsideProjectRoot(projectRoot, resolvedPath)) {
    throw new Error(
      `Invalid review.paths.${pathType}: "${configuredPath}" resolves outside repository root (${projectRoot}). Use a repo-relative path within the repository or an absolute path.`
    );
  }

  if (!existsSync(resolvedPath)) {
    throw new Error(
      `Invalid review.paths.${pathType}: "${configuredPath}" resolved to "${resolvedPath}", but the directory does not exist. Create the directory or remove review.paths.${pathType} to use "${fallbackPath}".`
    );
  }

  if (!statSync(resolvedPath).isDirectory()) {
    throw new Error(
      `Invalid review.paths.${pathType}: "${configuredPath}" resolved to "${resolvedPath}", but it is not a directory. Point review.paths.${pathType} to a directory or remove it to use "${fallbackPath}".`
    );
  }

  return resolvedPath;
}

export function resolveReviewPaths(projectPath: string, config?: DRSConfig): ResolvedReviewPaths {
  const projectRoot = resolve(projectPath);

  return {
    agentsPath: resolveConfiguredPath(
      projectRoot,
      config?.review.paths?.agents,
      DEFAULT_AGENT_PATH,
      'agents'
    ),
    skillsPath: resolveConfiguredPath(
      projectRoot,
      config?.review.paths?.skills,
      DEFAULT_SKILL_PATH,
      'skills'
    ),
  };
}
