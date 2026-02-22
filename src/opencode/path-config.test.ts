import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DRSConfig } from '../lib/config.js';
import { resolveReviewPaths } from './path-config.js';

function createConfig(paths: { agents?: unknown; skills?: unknown }): DRSConfig {
  return {
    review: {
      paths: {
        agents: paths.agents as string | undefined,
        skills: paths.skills as string | undefined,
      },
    },
  } as unknown as DRSConfig;
}

describe('resolveReviewPaths', () => {
  const tempDirs: string[] = [];

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves default paths from project root deterministically', () => {
    const projectRoot = createTempDir('drs-path-default-');
    const nested = join(projectRoot, 'nested', 'dir');
    mkdirSync(nested, { recursive: true });

    const canonical = resolveReviewPaths(projectRoot);
    const nonCanonical = resolveReviewPaths(join(projectRoot, 'nested', '..'));

    expect(canonical.agentsPath).toBe(resolve(projectRoot, '.drs/agents'));
    expect(canonical.skillsPath).toBe(resolve(projectRoot, '.drs/skills'));
    expect(nonCanonical).toEqual(canonical);
  });

  it('resolves repo-relative configured paths', () => {
    const projectRoot = createTempDir('drs-path-relative-');
    mkdirSync(join(projectRoot, 'config', 'agents'), { recursive: true });
    mkdirSync(join(projectRoot, 'config', 'skills'), { recursive: true });

    const result = resolveReviewPaths(
      projectRoot,
      createConfig({
        agents: 'config/agents',
        skills: 'config/skills',
      })
    );

    expect(result.agentsPath).toBe(resolve(projectRoot, 'config/agents'));
    expect(result.skillsPath).toBe(resolve(projectRoot, 'config/skills'));
  });

  it('resolves absolute configured paths', () => {
    const projectRoot = createTempDir('drs-path-project-');
    const absoluteRoot = createTempDir('drs-path-absolute-');
    const agentsPath = join(absoluteRoot, 'agents');
    const skillsPath = join(absoluteRoot, 'skills');
    mkdirSync(agentsPath, { recursive: true });
    mkdirSync(skillsPath, { recursive: true });

    const result = resolveReviewPaths(
      projectRoot,
      createConfig({
        agents: agentsPath,
        skills: skillsPath,
      })
    );

    expect(result.agentsPath).toBe(resolve(agentsPath));
    expect(result.skillsPath).toBe(resolve(skillsPath));
  });

  it('throws actionable error when repo-relative path escapes project root', () => {
    const projectRoot = createTempDir('drs-path-escape-');

    expect(() =>
      resolveReviewPaths(projectRoot, createConfig({ agents: '../shared-agents' }))
    ).toThrow('resolves outside repository root');
  });

  it('throws actionable error when configured path does not exist', () => {
    const projectRoot = createTempDir('drs-path-missing-');

    expect(() =>
      resolveReviewPaths(projectRoot, createConfig({ skills: 'missing/skills' }))
    ).toThrow('directory does not exist');
  });

  it('throws actionable error when configured path is not a directory', () => {
    const projectRoot = createTempDir('drs-path-file-');
    const filePath = join(projectRoot, 'agents-file.md');
    writeFileSync(filePath, '# not a directory\n');

    expect(() => resolveReviewPaths(projectRoot, createConfig({ agents: filePath }))).toThrow(
      'not a directory'
    );
  });

  it('throws actionable error when configured path is not a string', () => {
    const projectRoot = createTempDir('drs-path-invalid-type-');

    expect(() =>
      resolveReviewPaths(
        projectRoot,
        createConfig({
          skills: 123,
        })
      )
    ).toThrow('expected a string path');
  });
});
