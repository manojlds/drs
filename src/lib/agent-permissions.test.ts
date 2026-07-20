import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentFilesystemAuthorizer,
  assertAgentWorkspaceChangesAllowed,
  captureAgentWorkspaceSnapshot,
  renderAgentPermissions,
  validateAgentPermissions,
  validateAgentValidation,
} from './agent-permissions.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'drs-agent-permissions-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('agent permissions', () => {
  it('validates generic filesystem rules and requires shell to be disabled', () => {
    expect(() =>
      validateAgentPermissions({
        filesystem: { write: { roots: ['wiki'], allow: ['**/*.md'], deny: ['**/index.md'] } },
        shell: false,
      })
    ).not.toThrow();
    expect(() =>
      validateAgentPermissions({ filesystem: { write: { roots: ['wiki'], allow: ['**/*.md'] } } })
    ).toThrow('must explicitly set shell: false');
    expect(() =>
      validateAgentPermissions({
        filesystem: { write: { roots: ['../outside'], allow: ['**'] } },
        shell: false,
      })
    ).toThrow('must contain repository-relative paths');
  });

  it('validates registered after-write validators', () => {
    expect(() =>
      validateAgentValidation({ afterMutation: [{ name: 'okf-document', root: 'wiki' }] })
    ).not.toThrow();
    expect(() =>
      validateAgentValidation({ afterMutation: [{ name: 'unknown', root: 'wiki' }] })
    ).toThrow('unsupported validator');
  });

  it('renders workflow templates without mutating the source policy', () => {
    const source = {
      filesystem: {
        write: { roots: ['{{root}}'], allow: ['**/*.md'], deny: ['**/index.md'] },
      },
      shell: false,
    };
    const rendered = renderAgentPermissions(source, (value) => value.replace('{{root}}', 'wiki'));

    expect(rendered.filesystem?.write).toEqual({
      roots: ['wiki'],
      allow: ['**/*.md'],
      deny: ['**/index.md'],
    });
    expect(source.filesystem.write).toEqual({
      roots: ['{{root}}'],
      allow: ['**/*.md'],
      deny: ['**/index.md'],
    });
  });

  it('allows matching paths and gives deny rules precedence', async () => {
    const root = await createTempDir();
    const authorizer = new AgentFilesystemAuthorizer(root, {
      write: { roots: ['wiki'], allow: ['**/*.md'], deny: ['**/index.md'] },
    });

    await expect(authorizer.authorize('write', 'wiki/architecture.md')).resolves.toBe(
      join(root, 'wiki', 'architecture.md')
    );
    await expect(authorizer.authorize('write', 'wiki/index.md')).rejects.toThrow('deny list');
    await expect(authorizer.authorize('write', 'src/index.ts')).rejects.toThrow('allowed roots');
    await expect(authorizer.authorize('write', '../outside.md')).rejects.toThrow(
      'outside the working directory'
    );
  });

  it('rejects symbolic-link ancestors and targets', async () => {
    const root = await createTempDir();
    const outside = await createTempDir();
    await mkdir(join(root, 'wiki'));
    await writeFile(join(outside, 'outside.md'), 'outside');
    await symlink(outside, join(root, 'wiki', 'linked'));
    await symlink(join(outside, 'outside.md'), join(root, 'wiki', 'target.md'));
    const authorizer = new AgentFilesystemAuthorizer(root, {
      write: { roots: ['wiki'], allow: ['**/*.md'] },
    });

    await expect(authorizer.authorize('write', 'wiki/linked/new.md')).rejects.toThrow(
      'symbolic link'
    );
    await expect(authorizer.authorize('write', 'wiki/target.md')).rejects.toThrow('symbolic link');
  });

  it('rejects hard-linked writes and treats glob control prefixes literally', async () => {
    const root = await createTempDir();
    const outside = await createTempDir();
    await mkdir(join(root, 'wiki'));
    await writeFile(join(outside, 'outside.md'), 'outside');
    await link(join(outside, 'outside.md'), join(root, 'wiki', 'linked.md'));
    await writeFile(join(root, 'wiki', '!important.md'), 'important');
    await writeFile(join(root, 'wiki', '#notes.md'), 'notes');
    const hardLinkAuthorizer = new AgentFilesystemAuthorizer(root, {
      write: { roots: ['wiki'], allow: ['**/*.md'] },
    });
    const literalAuthorizer = new AgentFilesystemAuthorizer(root, {
      write: { roots: ['wiki'], allow: ['!important.md', '#notes.md'] },
    });

    await expect(hardLinkAuthorizer.authorize('write', 'wiki/linked.md')).rejects.toThrow(
      'multiple hard links'
    );
    await expect(literalAuthorizer.authorize('write', 'wiki/!important.md')).resolves.toBe(
      join(root, 'wiki', '!important.md')
    );
    await expect(literalAuthorizer.authorize('write', 'wiki/#notes.md')).resolves.toBe(
      join(root, 'wiki', '#notes.md')
    );
    await expect(literalAuthorizer.authorize('write', 'wiki/other.md')).rejects.toThrow(
      'allow list'
    );
  });

  it('rejects post-run changes outside the same write policy', async () => {
    const root = await createTempDir();
    await execFileAsync('git', ['init'], { cwd: root });
    await writeFile(join(root, 'source.ts'), 'before\n');
    await mkdir(join(root, 'wiki'));
    await writeFile(join(root, 'wiki', 'guide.md'), 'before\n');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    const permissions = {
      write: { roots: ['wiki'], allow: ['**/*.md'], deny: ['**/index.md'] },
    };
    const before = await captureAgentWorkspaceSnapshot(root);

    await writeFile(join(root, 'wiki', 'guide.md'), 'after\n');
    await expect(assertAgentWorkspaceChangesAllowed(root, permissions, before)).resolves.toEqual([
      'wiki/guide.md',
    ]);

    const beforeDelete = await captureAgentWorkspaceSnapshot(root);
    await rm(join(root, 'wiki', 'guide.md'));
    await expect(
      assertAgentWorkspaceChangesAllowed(
        root,
        {
          ...permissions,
          delete: { roots: ['wiki'], allow: ['**/*.md'] },
        },
        beforeDelete
      )
    ).resolves.toEqual(['wiki/guide.md']);

    await writeFile(join(root, 'source.ts'), 'after\n');
    await expect(assertAgentWorkspaceChangesAllowed(root, permissions, before)).rejects.toThrow(
      'source.ts'
    );
  });

  it('fingerprints tracked submodule worktree changes', async () => {
    const root = await createTempDir();
    const submodule = await createTempDir();
    for (const repository of [root, submodule]) {
      await execFileAsync('git', ['init'], { cwd: repository });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repository });
    }
    await writeFile(join(submodule, 'module.md'), 'before\n');
    await execFileAsync('git', ['add', '.'], { cwd: submodule });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: submodule });
    await execFileAsync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', submodule, 'vendor/module'],
      { cwd: root }
    );
    const before = await captureAgentWorkspaceSnapshot(root);

    await writeFile(join(root, 'vendor', 'module', 'module.md'), 'after\n');

    await expect(
      assertAgentWorkspaceChangesAllowed(
        root,
        { write: { roots: ['wiki'], allow: ['**/*.md'] } },
        before
      )
    ).rejects.toThrow('vendor/module');
  });
});
