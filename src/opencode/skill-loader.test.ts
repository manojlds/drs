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

  it('auto-discovers .drs/skills and .pi/skills with deterministic precedence', () => {
    const projectRoot = createTempDir('drs-skill-loader-discovery-');

    const drsSkillPath = join(projectRoot, '.drs', 'skills', 'shared-skill', 'SKILL.md');
    const piSkillPath = join(projectRoot, '.pi', 'skills', 'shared-skill', 'SKILL.md');
    const piOnlySkillPath = join(projectRoot, '.pi', 'skills', 'pi-only-skill', 'SKILL.md');

    mkdirSync(join(projectRoot, '.drs', 'skills', 'shared-skill'), { recursive: true });
    mkdirSync(join(projectRoot, '.pi', 'skills', 'shared-skill'), { recursive: true });
    mkdirSync(join(projectRoot, '.pi', 'skills', 'pi-only-skill'), { recursive: true });

    writeFileSync(
      drsSkillPath,
      `---\nname: shared-skill\ndescription: Project override skill\n---\n\nUse the project-specific guidance.\n`
    );
    writeFileSync(
      piSkillPath,
      `---\nname: shared-skill\ndescription: Pi fallback skill\n---\n\nUse the Pi fallback guidance.\n`
    );
    writeFileSync(
      piOnlySkillPath,
      `---\nname: pi-only-skill\ndescription: Pi-native setup helper\n---\n\nUse Pi-native setup instructions.\n`
    );

    const skills = loadProjectSkills(projectRoot);
    const skillNames = skills.map((skill) => skill.name).sort();

    expect(skillNames).toEqual(['pi-only-skill', 'shared-skill']);

    const sharedSkill = skills.find((skill) => skill.name === 'shared-skill');
    expect(sharedSkill?.path).toBe(resolve(drsSkillPath));
    expect(sharedSkill?.description).toBe('Project override skill');

    const loadedShared = loadSkillByName(projectRoot, 'shared-skill');
    expect(loadedShared?.instructions).toContain('project-specific guidance');

    const loadedPiOnly = loadSkillByName(projectRoot, 'pi-only-skill');
    expect(loadedPiOnly?.instructions).toContain('Pi-native setup instructions');
  });

  it('falls back to .pi/skills when .drs/skills does not exist', () => {
    const projectRoot = createTempDir('drs-skill-loader-pi-fallback-');
    const skillPath = join(projectRoot, '.pi', 'skills', 'pi-fallback', 'SKILL.md');

    mkdirSync(join(projectRoot, '.pi', 'skills', 'pi-fallback'), { recursive: true });
    writeFileSync(
      skillPath,
      `---\nname: pi-fallback\ndescription: Pi fallback discovery\n---\n\nLoaded from .pi/skills.\n`
    );

    const skills = loadProjectSkills(projectRoot);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('pi-fallback');
    expect(skills[0].path).toBe(resolve(skillPath));
  });

  it('throws actionable error when configured skills path is invalid', () => {
    const projectRoot = createTempDir('drs-skill-loader-invalid-');

    expect(() => loadProjectSkills(projectRoot, createConfig('missing/skills'))).toThrow(
      'review.paths.skills'
    );
  });
});
