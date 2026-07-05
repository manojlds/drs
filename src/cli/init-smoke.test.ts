import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { initProject } from './init.js';
import { getProjectSetupStatus, syncProjectSetup } from '../lib/project-setup.js';

describe('DRS project onboarding smoke', () => {
  it('initializes and syncs a new git repository', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'drs-init-smoke-'));
    try {
      execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
      writeFileSync(join(repo, 'README.md'), '# Smoke repo\n', 'utf-8');

      expect(getProjectSetupStatus(repo).initialized).toBe(false);
      await initProject(repo, { yes: true });

      const initialized = getProjectSetupStatus(repo);
      expect(initialized.initialized).toBe(true);
      expect(initialized.issues).toEqual([]);
      expect(initialized.skills).toContainEqual(
        expect.objectContaining({
          name: 'drs-factory-planning',
          installed: true,
          modified: false,
          outdated: false,
        })
      );

      const synced = syncProjectSetup(repo);
      expect(synced.initialized).toBe(true);
      expect(synced.issues).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
