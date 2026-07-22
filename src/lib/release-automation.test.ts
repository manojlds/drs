import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface WorkflowJob {
  environment?: string;
  permissions?: Record<string, string>;
  steps: WorkflowStep[];
}

interface WorkflowDefinition {
  on?: {
    push?: unknown;
    workflow_dispatch?: {
      inputs?: Record<string, { required?: boolean }>;
    };
  };
  concurrency?: { group?: string };
  jobs: Record<string, WorkflowJob>;
}

const root = process.cwd();
const metadataScript = join(root, '.github/scripts/release-metadata.mjs');
const tempDirs: string[] = [];

function runMetadata(args: string[], cwd = root) {
  return spawnSync(process.execPath, [metadataScript, ...args], {
    cwd,
    encoding: 'utf-8',
  });
}

function loadWorkflow(path: string): WorkflowDefinition {
  return parse(readFileSync(join(root, path), 'utf-8')) as WorkflowDefinition;
}

function workflowRuns(workflow: WorkflowDefinition, job: string): string {
  return workflow.jobs[job].steps.map((step) => step.run ?? '').join('\n');
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('release metadata validation', () => {
  it.each([
    ['5.0.0', 'latest'],
    ['5.0.0-rc.1', 'next'],
    ['5.0.0-canary.7', 'next'],
    ['5.0.0+build.1', 'latest'],
  ])('accepts exact SemVer %s with npm tag %s', (version, npmTag) => {
    const result = runMetadata(['validate-version', version]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ version, tag: `v${version}`, npmTag });
  });

  it.each(['v5.0.0', '5.0', '05.0.0', '5.0.0-rc.01', '5.0.0-rc..1', ' 5.0.0'])(
    'rejects non-canonical version %s',
    (version) => {
      expect(runMetadata(['validate-version', version]).status).not.toBe(0);
    }
  );

  it('round-trips real calendar dates', () => {
    expect(runMetadata(['validate-date', '2026-02-28']).status).toBe(0);
    expect(runMetadata(['validate-date', '2026-02-29']).status).not.toBe(0);
    expect(runMetadata(['validate-date', '2026-13-01']).status).not.toBe(0);
  });

  it('requires versions and dist-tags to move forward', () => {
    expect(runMetadata(['assert-greater', '5.0.0-rc.2', '5.0.0-rc.1']).status).toBe(0);
    expect(runMetadata(['assert-greater', '5.0.0', '5.0.0-rc.2']).status).toBe(0);
    expect(runMetadata(['assert-greater', '4.1.0', '5.0.0-rc.1']).status).not.toBe(0);
    expect(runMetadata(['assert-greater', '5.0.0-rc.1', '5.0.0-rc.1']).status).not.toBe(0);
  });

  it('checks committed package and changelog metadata', () => {
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
      version: string;
    };

    expect(runMetadata(['check-package', `v${packageJson.version}`]).status).toBe(0);
    expect(runMetadata(['check-version-only', packageJson.version]).status).toBe(0);
    expect(runMetadata(['check-changelog-version', packageJson.version]).status).toBe(0);
  });

  it('rejects lockfile drift and stale prerelease changelog sections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'drs-release-metadata-'));
    tempDirs.push(directory);
    writeFileSync(join(directory, 'package.json'), '{"version":"5.0.0"}\n');
    writeFileSync(
      join(directory, 'package-lock.json'),
      '{"version":"4.1.0","packages":{"":{"version":"4.1.0"}}}\n'
    );
    writeFileSync(
      join(directory, 'CHANGELOG.md'),
      '# Changelog\n\n## 5.0.0-rc.2 - 2026-07-22\n\n## 5.0.0-rc.1 - 2026-07-21\n'
    );

    expect(runMetadata(['check-package', 'v5.0.0'], directory).status).not.toBe(0);
    expect(runMetadata(['check-changelog', '5.0.0-rc.2', '2026-07-22'], directory).status).not.toBe(
      0
    );
  });

  it('checks required and forbidden npm pack paths', () => {
    const directory = mkdtempSync(join(tmpdir(), 'drs-release-pack-'));
    tempDirs.push(directory);
    const manifestPath = join(directory, 'pack.json');
    const requiredFiles = [
      'package.json',
      'README.md',
      'LICENSE',
      'dist/cli/index.js',
      '.pi/workflows/github-pr-review.yaml',
      '.wiki-site/.vitepress/config.mts',
    ];
    writeFileSync(
      manifestPath,
      JSON.stringify([{ version: '5.0.0', files: requiredFiles.map((path) => ({ path })) }])
    );
    expect(runMetadata(['check-pack', manifestPath, '5.0.0']).status).toBe(0);

    writeFileSync(
      manifestPath,
      JSON.stringify([
        {
          version: '5.0.0',
          files: [...requiredFiles, 'src/index.ts'].map((path) => ({ path })),
        },
      ])
    );
    expect(runMetadata(['check-pack', manifestPath, '5.0.0']).status).not.toBe(0);
  });
});

describe('release workflow transaction', () => {
  it('prepares without write credentials and commits a validated patch', () => {
    const workflow = loadWorkflow('.github/workflows/release-changelog.yml');
    const source = readFileSync(join(root, '.github/workflows/release-changelog.yml'), 'utf-8');
    const prepareRuns = workflowRuns(workflow, 'prepare');
    const commitRuns = workflowRuns(workflow, 'commit');

    expect(workflow.jobs.prepare.environment).toBe('release');
    expect(workflow.jobs.prepare.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.commit.permissions).toMatchObject({ contents: 'write', actions: 'write' });
    expect(prepareRuns).toContain('npm version "$VERSION" --no-git-tag-version --ignore-scripts');
    expect(prepareRuns).toContain('repository-wiki-sync');
    expect(prepareRuns).toContain('git diff --cached --binary --full-index');
    expect(prepareRuns).toContain('check-version-only "$VERSION"');
    expect(prepareRuns).toContain('Release verification changed the staged patch');
    expect(prepareRuns).toContain('Generated release patch does not match the verified index');
    expect(commitRuns).toContain('git apply --index --binary');
    expect(commitRuns).toContain('sha256sum "$patch"');
    expect(commitRuns).toContain('push --atomic origin');
    expect(commitRuns).toContain('gh workflow run ci.yml');
    expect(commitRuns).toContain('gh workflow run wiki-pages.yml');
    expect(commitRuns).toContain('gh workflow run publish.yml');
    expect(commitRuns).toContain('--ref "$TAG"');
    expect(commitRuns).toContain('GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $basic_auth"');
    expect(commitRuns).not.toContain('git -c "http.https://github.com/.extraheader');
    expect(source).not.toMatch(
      /uses: actions\/(?:checkout|setup-node|upload-artifact|download-artifact)@v/u
    );
    expect(source).toContain('persist-credentials: false');
  });

  it('publishes only an exact manually dispatched tag and never rewrites package metadata', () => {
    const workflow = loadWorkflow('.github/workflows/publish.yml');
    const source = readFileSync(join(root, '.github/workflows/publish.yml'), 'utf-8');
    const runs = workflowRuns(workflow, 'publish');
    const inputs = workflow.on?.workflow_dispatch?.inputs;

    expect(workflow.on?.push).toBeUndefined();
    expect(workflow.concurrency?.group).toBe('npm-publish');
    expect(workflow.jobs.publish.environment).toBe('release');
    expect(inputs?.tag?.required).toBe(true);
    expect(inputs?.commit?.required).toBe(true);
    expect(runs).toContain('check-package "$INPUT_TAG"');
    expect(runs).toContain('git merge-base --is-ancestor');
    expect(runs).toContain('[[ "$npm_output" != *E404* ]]');
    expect(runs).toContain('assert-greater "$version" "$current_dist_version"');
    expect(runs).toContain('check-pack');
    expect(runs).toContain('npm publish --provenance --access public');
    expect(runs).not.toContain('pkg.version =');
    expect(runs).not.toContain('writeFileSync');
    expect(source).not.toMatch(/uses: actions\/(?:checkout|setup-node)@v/u);
  });

  it('removes post-tag changelog automation', () => {
    expect(existsSync(join(root, '.github/workflows/tag-changelog.yml'))).toBe(false);
  });
});

describe('release script syntax', () => {
  it('passes Node syntax validation', () => {
    expect(() =>
      execFileSync(process.execPath, ['--check', metadataScript], { cwd: root })
    ).not.toThrow();
  });
});
