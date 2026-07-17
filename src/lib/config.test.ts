import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

describe('Config', () => {
  it('should not overwrite default agents when undefined is passed', () => {
    const config = loadConfig(process.cwd(), {
      review: {
        agents: undefined,
      },
    } as any);

    // Should keep default agents, not overwrite with undefined
    expect(config.review.agents).toBeDefined();
    expect(Array.isArray(config.review.agents)).toBe(true);
    expect(config.review.agents.length).toBeGreaterThan(0);
  });

  it('should override agents when explicitly provided', () => {
    const config = loadConfig(process.cwd(), {
      review: {
        agents: ['review/security'],
      } as any,
    });

    expect(config.review.agents).toEqual(['review/security']);
  });

  it('should load agents from config file when no override provided', () => {
    const config = loadConfig(process.cwd());

    // Should load whatever is configured in the project's .drs/drs.config.yaml
    expect(config.review.agents).toBeDefined();
    expect(Array.isArray(config.review.agents)).toBe(true);
    expect(config.review.agents.length).toBeGreaterThan(0);

    // Verify each agent is a string (simple format) or object (detailed format)
    config.review.agents.forEach((agent) => {
      const isValid = typeof agent === 'string' || (typeof agent === 'object' && 'name' in agent);
      expect(isValid).toBe(true);
    });
  });

  it('should respect skipRepoCheck config option', () => {
    const config = loadConfig(process.cwd(), {
      review: {
        skipRepoCheck: true,
      } as any,
    });

    expect(config.review.skipRepoCheck).toBe(true);
  });

  it('should respect skipBranchCheck config option', () => {
    const config = loadConfig(process.cwd(), {
      review: {
        skipBranchCheck: true,
      } as any,
    });

    expect(config.review.skipBranchCheck).toBe(true);
  });

  it('should default skipRepoCheck and skipBranchCheck to undefined', () => {
    const config = loadConfig(process.cwd());

    expect(config.review.skipRepoCheck).toBeUndefined();
    expect(config.review.skipBranchCheck).toBeUndefined();
  });

  it('should load pricing overrides when provided', () => {
    const config = loadConfig(process.cwd(), {
      pricing: {
        models: {
          'opencode/glm-5-free': {
            input: 1,
            output: 2,
          },
        },
      },
    });

    expect(config.pricing?.models?.['opencode/glm-5-free']).toEqual({
      input: 1,
      output: 2,
    });
  });

  it('should load fix.checks when provided', () => {
    const config = loadConfig(process.cwd(), {
      fix: {
        checks: [
          {
            name: 'typecheck',
            command: 'npm run type-check',
            matchPaths: ['src/**/*.ts'],
            timeoutMs: 60000,
          },
          {
            name: 'lint',
            command: 'npm run lint',
          },
        ],
      },
    });

    expect(config.fix?.checks).toHaveLength(2);
    expect(config.fix?.checks?.[0]).toEqual({
      name: 'typecheck',
      command: 'npm run type-check',
      matchPaths: ['src/**/*.ts'],
      timeoutMs: 60000,
    });
    expect(config.fix?.checks?.[1]).toEqual({
      name: 'lint',
      command: 'npm run lint',
    });
  });

  it('loads built-in workflow files', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'drs-workflow-builtins-'));

    try {
      const config = loadConfig(projectRoot);

      expect(config.workflows?.['local-review']).toMatchObject({
        description: 'Review local git diff',
        inputs: {
          staged: {
            type: 'boolean',
            default: false,
          },
        },
        nodes: {
          change: {
            action: 'change-source',
          },
          review: {
            action: 'review',
            with: {
              source: 'change',
            },
          },
        },
      });
      expect(config.workflows?.['gitlab-mr-review']?.inputs).toMatchObject({
        project: { type: 'string', required: true },
        mr: { type: 'number', required: true },
        describe: { type: 'boolean', default: false },
        post: { type: 'boolean', default: false },
        visual: { type: 'boolean', default: false },
        fixMode: { type: 'enum', default: 'stacked' },
        fixSeverity: { type: 'enum', default: 'high' },
        visualOutputPath: { type: 'string', default: '.drs/visual-mr-explainer.html' },
        codeQuality: { type: 'boolean', default: false },
      });
      expect(config.workflows?.['github-pr-review']?.inputs).toMatchObject({
        visual: { type: 'boolean', default: false },
        visualOutputPath: { type: 'string', default: '.drs/visual-pr-explainer.html' },
      });
      expect(config.workflows?.['github-pr-review']?.nodes.visual).toMatchObject({
        agent: 'visual/pr-explainer',
        needs: ['change', 'review'],
        if: 'inputs.visual == true',
        writes: '{{inputs.visualOutputPath}}',
      });
      expect(config.workflows?.['github-pr-visual-explain']).toMatchObject({
        description: 'Generate a visual HTML explainer artifact for a GitHub pull request',
        inputs: {
          owner: '',
          repo: '',
          pr: '',
          outputPath: '.drs/visual-pr-explainer.html',
          slides: 'false',
        },
        nodes: {
          visual: {
            agent: 'visual/pr-explainer',
            writes: '{{inputs.outputPath}}',
          },
        },
      });
      expect(config.workflows?.['github-pr-review']?.nodes.describe?.needs).toEqual(['change']);
      expect(config.workflows?.['github-pr-review']?.nodes.review?.needs).toEqual(['change']);
      expect(config.workflows?.['github-pr-review']?.nodes.review?.with).toMatchObject({
        source: 'change',
      });
      expect(config.workflows?.['github-pr-review']?.nodes['post-comments']?.needs).toEqual([
        'review',
      ]);
      expect(config.workflows?.['gitlab-mr-review']?.nodes.describe?.needs).toEqual(['change']);
      expect(config.workflows?.['gitlab-mr-review']?.nodes.review?.needs).toEqual(['change']);
      expect(config.workflows?.['gitlab-mr-review']?.nodes.review?.with).toMatchObject({
        source: 'change',
      });
      expect(config.workflows?.['gitlab-mr-review']?.nodes.visual?.needs).toEqual([
        'change',
        'review',
      ]);
      expect(config.workflows?.['gitlab-mr-review']?.nodes.visual?.if).toBe(
        'inputs.visual == true'
      );
      expect(config.workflows?.['gitlab-mr-review']?.nodes['post-comments']?.needs).toEqual([
        'review',
      ]);
      expect(config.workflows?.['gitlab-mr-review']?.nodes['code-quality']?.needs).toEqual([
        'review',
      ]);
      expect(config.workflows?.['github-pr-describe']).toMatchObject({
        description: 'Generate a GitHub pull request description, optionally posting it',
        inputs: {
          owner: '',
          repo: '',
          pr: '',
          post: 'false',
        },
        nodes: {
          describe: {
            action: 'describe',
            with: {
              post: '{{inputs.post}}',
            },
          },
        },
      });
      expect(config.workflows?.['gitlab-mr-describe']?.inputs).toEqual({
        project: '',
        mr: '',
        post: 'false',
      });
      expect(config.workflows?.['github-pr-post-comment']).toMatchObject({
        description: 'Post or update a GitHub pull request comment',
        nodes: {
          comment: {
            action: 'post-comment',
          },
        },
      });
      expect(config.workflows?.['local-changelog-update']).toMatchObject({
        description: 'Update CHANGELOG.md from local unstaged changes',
        nodes: {
          'update-changelog': {
            agent: 'task/changelog-updater',
          },
        },
      });
      expect(config.workflows?.['local-fix-review-issues']).toMatchObject({
        description:
          'Fix actionable issues from a saved local DRS review artifact with verification loop',
        inputs: {
          review: { type: 'string' },
          fixSeverity: { type: 'enum', default: 'high' },
          fixMaxIterations: { type: 'number', default: 3 },
        },
        nodes: {
          'fix-issues': {
            agent: 'task/review-issue-fixer',
          },
          're-review': {
            action: 'review',
          },
          'verify-fix': {
            action: 'verify-fix',
          },
        },
      });
      expect(config.workflows?.['local-update-agents-md']).toMatchObject({
        description: 'Update repository agent guidance from local changes',
        nodes: {
          'update-guidance': {
            agent: 'task/agents-md-updater',
          },
        },
      });
      expect(config.workflows?.['repository-wiki-sync']).toMatchObject({
        description: 'Generate or update one OKF v0.1 repository wiki bundle',
        metadata: {
          kind: 'maintenance',
          tags: ['documentation', 'wiki', 'okf'],
        },
        inputs: {
          root: { type: 'string', default: 'wiki' },
          instructions: { type: 'string', default: '' },
        },
        output: 'wikiValidation',
        nodes: {
          'maintain-wiki': {
            agent: 'task/okf-wiki-maintainer',
            output: 'wikiSummary',
          },
          'sync-indexes': {
            action: 'sync-okf-indexes',
            needs: ['maintain-wiki'],
          },
          'validate-wiki': {
            action: 'validate-okf-wiki',
            needs: ['sync-indexes'],
            output: 'wikiValidation',
          },
        },
      });
      expect(config.workflows?.['tag-changelog-update']).toMatchObject({
        description: 'Update CHANGELOG.md from changes between two git refs or tags',
        inputs: {
          from: '',
          to: '',
        },
        nodes: {
          'release-change': {
            action: 'change-source',
            with: {
              type: 'git-range',
            },
          },
          'update-changelog': {
            agent: 'task/changelog-updater',
          },
        },
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('loads project workflow files from .drs/workflows', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'drs-project-workflow-'));

    try {
      mkdirSync(join(projectRoot, '.drs', 'workflows'), { recursive: true });
      writeFileSync(
        join(projectRoot, '.drs', 'workflows', 'release-notes.yaml'),
        [
          'description: Draft release notes',
          'nodes:',
          '  write:',
          '    action: write',
          '    input: hello',
          '    writes: RELEASE_NOTES.md',
          '',
        ].join('\n')
      );

      const config = loadConfig(projectRoot);

      expect(config.workflows?.['release-notes']).toMatchObject({
        description: 'Draft release notes',
        nodes: {
          write: {
            action: 'write',
            writes: 'RELEASE_NOTES.md',
          },
        },
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('lets project workflow files override built-in workflow files', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'drs-workflow-override-'));

    try {
      mkdirSync(join(projectRoot, '.drs', 'workflows'), { recursive: true });
      writeFileSync(
        join(projectRoot, '.drs', 'workflows', 'local-review.yaml'),
        [
          'description: Project local review override',
          'nodes:',
          '  write:',
          '    action: write',
          '    input: project',
          '    writes: project.txt',
          '',
        ].join('\n')
      );

      const config = loadConfig(projectRoot);

      expect(config.workflows?.['local-review']).toMatchObject({
        description: 'Project local review override',
        nodes: {
          write: {
            action: 'write',
          },
        },
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects top-level workflows in drs.config.yaml', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'drs-workflow-config-'));

    try {
      mkdirSync(join(projectRoot, '.drs'), { recursive: true });
      writeFileSync(
        join(projectRoot, '.drs', 'drs.config.yaml'),
        [
          'workflows:',
          '  custom:',
          '    description: Inline workflow',
          '    nodes:',
          '      write:',
          '        action: write',
          '',
        ].join('\n')
      );

      expect(() => loadConfig(projectRoot)).toThrow('cannot define top-level workflows');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects workflow files that contain a workflows map', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'drs-workflow-map-'));

    try {
      mkdirSync(join(projectRoot, '.drs', 'workflows'), { recursive: true });
      writeFileSync(
        join(projectRoot, '.drs', 'workflows', 'custom.yaml'),
        ['workflows:', '  custom:', '    nodes:', '      write:', '        action: write', ''].join(
          '\n'
        )
      );

      expect(() => loadConfig(projectRoot)).toThrow('must define one workflow directly');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('loads workflow run defaults from drs.config.yaml', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'drs-workflow-default-'));

    try {
      mkdirSync(join(projectRoot, '.drs'), { recursive: true });
      writeFileSync(
        join(projectRoot, '.drs', 'drs.config.yaml'),
        ['workflow:', '  default: local-changelog-review', ''].join('\n')
      );

      const config = loadConfig(projectRoot);

      expect(config.workflow?.default).toBe('local-changelog-review');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('uses DRS_DEFAULT_MODEL as the generic default model environment alias', () => {
    const previous = process.env.DRS_DEFAULT_MODEL;
    process.env.DRS_DEFAULT_MODEL = 'provider/env-default-model';

    try {
      const config = loadConfig(process.cwd());

      expect(config.agents.default?.model).toBe('provider/env-default-model');
    } finally {
      if (previous === undefined) {
        delete process.env.DRS_DEFAULT_MODEL;
      } else {
        process.env.DRS_DEFAULT_MODEL = previous;
      }
    }
  });

  it('merges pi runtime timeout and provider retry settings', () => {
    const config = loadConfig(process.cwd(), {
      pi: {
        runtime: {
          operationTimeoutMs: 111000,
          streamTimeoutMs: 222000,
          streamPollIntervalMs: 1500,
        },
        retry: {
          provider: {
            timeoutMs: 45000,
            maxRetries: 2,
            maxRetryDelayMs: 15000,
          },
        },
      },
    });

    expect(config.pi.runtime).toEqual({
      operationTimeoutMs: 111000,
      streamTimeoutMs: 222000,
      streamPollIntervalMs: 1500,
    });

    expect(config.pi.retry?.provider).toEqual({
      timeoutMs: 45000,
      maxRetries: 2,
      maxRetryDelayMs: 15000,
    });
  });

  it('rejects legacy review.default config with migration guidance', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'drs-legacy-config-'));

    try {
      mkdirSync(join(projectRoot, '.drs'), { recursive: true });
      writeFileSync(
        join(projectRoot, '.drs', 'drs.config.yaml'),
        ['review:', '  default:', '    model: provider/legacy-model', ''].join('\n')
      );

      expect(() => loadConfig(projectRoot)).toThrow('review.default -> agents.default');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects legacy review.paths config with migration guidance', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'drs-legacy-paths-'));

    try {
      mkdirSync(join(projectRoot, '.drs'), { recursive: true });
      writeFileSync(
        join(projectRoot, '.drs', 'drs.config.yaml'),
        ['review:', '  paths:', '    agents: custom/agents', ''].join('\n')
      );

      expect(() => loadConfig(projectRoot)).toThrow('review.paths -> agents.paths');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects removed implicit review posting config keys', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'drs-removed-posting-config-'));

    try {
      mkdirSync(join(projectRoot, '.drs'), { recursive: true });
      writeFileSync(
        join(projectRoot, '.drs', 'drs.config.yaml'),
        [
          'review:',
          '  postErrorComment: true',
          '  describe:',
          '    enabled: true',
          '    postDescription: true',
          '',
        ].join('\n')
      );

      expect(() => loadConfig(projectRoot)).toThrow('review.postErrorComment');
      expect(() => loadConfig(projectRoot)).toThrow('review.describe.postDescription');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  describe('load-time action validation', () => {
    function writeWorkflowWithAction(
      projectRoot: string,
      workflowName: string,
      action: string | number | boolean | null
    ): void {
      mkdirSync(join(projectRoot, '.drs', 'workflows'), { recursive: true });
      const yaml = [
        'description: Test workflow with bad action',
        'nodes:',
        '  step:',
        '    action: ' + action,
        '',
      ].join('\n');
      writeFileSync(join(projectRoot, '.drs', 'workflows', workflowName + '.yaml'), yaml);
    }

    it('throws did-you-mean for a near-miss typo of a supported action', () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'drs-action-typo-'));
      try {
        writeWorkflowWithAction(projectRoot, 'typo-workflow', 'verify-fx');
        expect(() => loadConfig(projectRoot)).toThrow(/verify-fix/);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('lists every supported action for a wholly unknown action', () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'drs-action-unknown-'));
      try {
        writeWorkflowWithAction(projectRoot, 'unknown-workflow', 'do-the-thing');
        expect(() => loadConfig(projectRoot)).toThrow(/Supported actions:/);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('accepts a valid action without throwing', () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'drs-action-ok-'));
      try {
        writeWorkflowWithAction(projectRoot, 'ok-workflow', 'verify-fix');
        const config = loadConfig(projectRoot);
        expect(config.workflows?.['ok-workflow']?.nodes.step?.action).toBe('verify-fix');
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('treats non-string action values as missing', () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'drs-action-null-'));
      try {
        writeWorkflowWithAction(projectRoot, 'null-workflow', null);
        expect(() => loadConfig(projectRoot)).not.toThrow();
        const config = loadConfig(projectRoot);
        expect(config.workflows?.['null-workflow']?.nodes.step?.action).toBeNull();
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });
});
