import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('package contract', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
  ) as Record<string, unknown>;
  const packageLock = JSON.parse(
    readFileSync(new URL('../package-lock.json', import.meta.url), 'utf-8')
  ) as { version?: string; packages?: Record<string, { version?: string }> };

  it('publishes DRS as a CLI-only package', () => {
    expect(packageJson).not.toHaveProperty('main');
    expect(packageJson).not.toHaveProperty('exports');
    expect(packageJson.bin).toEqual({ drs: 'dist/cli/index.js' });
  });

  it('cleans build output and exposes only runnable test scripts', () => {
    expect(packageJson.scripts).toMatchObject({
      build: 'node clean-dist.mjs && tsc',
      test: 'vitest run',
      'test:temporal:smoke': 'DRS_TEMPORAL_SMOKE=1 vitest run src/temporal/smoke.test.ts',
    });
    expect(packageJson.scripts).not.toHaveProperty('test:e2e');
  });

  it('keeps package and lockfile versions identical', () => {
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages?.['']?.version).toBe(packageJson.version);
  });
});
