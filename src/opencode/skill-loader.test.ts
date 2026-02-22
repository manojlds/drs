import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DRSConfig } from '../lib/config.js';
import { loadProjectSkills, loadSkillByName } from './skill-loader.js';

function createConfig(skillsPath: string): DRSConfig {
  return {
    review: {
      paths: {
        skills: skillsPath,
      },
    },
  } as unknown as DRSConfig;
}

describe('skill-loader path resolution', () => {
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

  it('loads skills from configured repo-relative path', () => {
    const projectRoot = createTempDir('drs-skill-loader-');
    const customSkillsRoot = join(projectRoot, 'config', 'skills');
    const skillDir = join(customSkillsRoot, 'api-hardening');
    const skillPath = join(skillDir, 'SKILL.md');

    mkdirSync(join(skillDir, 'scripts'), { recursive: true });
    writeFileSync(
      skillPath,
      `---\nname: api-hardening\ndescription: Harden API handlers\n---\n\nReview authentication and validation paths.\n`
    );

    const config = createConfig('config/skills');
    const skills = loadProjectSkills(projectRoot, config);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('api-hardening');
    expect(skills[0].description).toBe('Harden API handlers');
    expect(skills[0].path).toBe(resolve(skillPath));

    const skill = loadSkillByName(projectRoot, 'api-hardening', config);
    expect(skill).not.toBeNull();
    expect(skill?.instructions).toContain('Review authentication and validation paths.');
    expect(skill?.hasScripts).toBe(true);
  });

  it('throws actionable error when configured skills path is invalid', () => {
    const projectRoot = createTempDir('drs-skill-loader-invalid-');

    expect(() => loadProjectSkills(projectRoot, createConfig('missing/skills'))).toThrow(
      'review.paths.skills'
    );
  });
});
