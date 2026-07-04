// @ts-check

/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { getDiff, getFileDiff, runGit } = require('./git.cjs');

test('getDiff returns file summaries without transferring the full patch', async () => {
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, 'a.txt'), 'one\ntwo changed\n');
  await fs.writeFile(path.join(repo, 'b.txt'), 'new file\n');
  await runGit(repo, ['add', '-N', 'b.txt']);

  const result = await getDiff(repo, {});

  assert.equal(result.patch, '');
  assert.equal(result.truncated, undefined);
  assert.equal(result.files.length, 2);
  assert.deepEqual(
    result.files.map((file) => ({ path: file.path, status: file.status })),
    [
      { path: 'a.txt', status: 'modified' },
      { path: 'b.txt', status: 'added' },
    ]
  );
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
});

test('getFileDiff returns one file patch on demand', async () => {
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, 'a.txt'), 'one\ntwo changed\n');
  await fs.writeFile(path.join(repo, 'b.txt'), 'new file\n');
  await runGit(repo, ['add', '-N', 'b.txt']);

  const result = await getFileDiff(repo, { path: 'a.txt' });

  assert.equal(result.truncated, undefined);
  assert.match(result.patch, /diff --git a\/a\.txt b\/a\.txt/);
  assert.doesNotMatch(result.patch, /b\.txt/);
});

test('large diff guard reports truncation without returning patch content', async () => {
  const repo = await createRepo();
  await fs.writeFile(path.join(repo, 'a.txt'), `${'x'.repeat(200)}\n`);

  const result = await getDiff(repo, { maxPatchBytes: 80 });

  assert.equal(result.truncated, true);
  assert.equal(result.patch, '');
  assert.equal(result.maxPatchBytes, 80);
  assert.ok((result.patchBytes ?? 0) > 80);
  assert.equal(result.files[0]?.path, 'a.txt');
});

async function createRepo() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'drs-desktop-git-'));
  await runGit(repo, ['init']);
  await runGit(repo, ['config', 'user.email', 'desktop-test@example.com']);
  await runGit(repo, ['config', 'user.name', 'Desktop Test']);
  await fs.writeFile(path.join(repo, 'a.txt'), 'one\ntwo\n');
  await runGit(repo, ['add', 'a.txt']);
  await runGit(repo, ['commit', '-m', 'initial']);
  return repo;
}
