// @ts-check

/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { runDrs } = require('./drs-cli.cjs');

const repoRoot = join(dirname(__dirname), '..');

test('desktop can run DRS init and doctor for a new project', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'drs-desktop-init-'));
  try {
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'README.md'), '# Desktop smoke repo\n', 'utf-8');

    const before = await runDrs({ repoRoot, workingDir: repo, args: ['doctor', '--json'], allowNonZero: true });
    assert.equal(JSON.parse(before.stdout).initialized, false);

    await runDrs({ repoRoot, workingDir: repo, args: ['init', '--yes'] });

    const after = await runDrs({ repoRoot, workingDir: repo, args: ['doctor', '--json'], allowNonZero: true });
    const status = JSON.parse(after.stdout);
    assert.equal(status.initialized, true);
    assert.deepEqual(status.issues, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
