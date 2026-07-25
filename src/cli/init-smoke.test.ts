import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { initProject } from './init.js';
import { getProjectSetupStatus } from '../lib/project-setup.js';

describe('DRS project onboarding smoke', () => {
  it('initializes a new git repository', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'drs-init-smoke-'));
    try {
      execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
      writeFileSync(join(repo, 'README.md'), '# Smoke repo\n', 'utf-8');

      expect(getProjectSetupStatus(repo).initialized).toBe(false);
      await initProject(repo, { yes: true });

      const initialized = getProjectSetupStatus(repo);
      expect(initialized.initialized).toBe(true);
      expect(initialized.issues).toEqual([]);
      const config = readFileSync(join(repo, '.drs', 'drs.config.yaml'), 'utf-8');
      expect(config).toContain('  agent: review/unified-reviewer');
      expect(config).not.toContain('  agents:');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
