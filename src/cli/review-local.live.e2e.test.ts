/**
 * Live E2E test for review-local.
 *
 * Run manually (never in CI):
 *   DRS_E2E_LIVE=1 OPENCODE_API_KEY=... npm test -- src/cli/review-local.live.e2e.test.ts
 *
 * Optional:
 *   DRS_E2E_MODEL=provider/model-id
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import simpleGit from 'simple-git';
import { describe, expect, it, vi } from 'vitest';
import type { DRSConfig } from '../lib/config.js';
import { reviewLocal } from './review-local.js';

const shouldRunLiveE2E = !process.env.CI && process.env.DRS_E2E_LIVE === '1';
const liveModel =
  process.env.DRS_E2E_MODEL ?? process.env.REVIEW_DEFAULT_MODEL ?? 'opencode/glm-5-free';

function buildLiveConfig(model: string): DRSConfig {
  return {
    pi: {},
    gitlab: { url: '', token: '' },
    github: { token: '' },
    review: {
      agents: ['security'],
      default: {
        model,
        skills: [],
      },
      ignorePatterns: [],
      mode: 'multi-agent',
      describe: {
        enabled: false,
        postDescription: false,
      },
    },
    describe: {
      includeProjectContext: false,
    },
    contextCompression: {
      enabled: false,
    },
  } as DRSConfig;
}

const describeLive = shouldRunLiveE2E ? describe : describe.skip;

describeLive('review-local live e2e (real LLM)', () => {
  it('runs full review-local pipeline against a real provider and writes JSON output', async () => {
    const originalCwd = process.cwd();
    const tempRoot = mkdtempSync(join(tmpdir(), 'drs-live-e2e-'));
    const repoDir = join(tempRoot, 'repo');
    const outputPath = 'review-local-live-output.json';

    const originalOpencodeApiKey = process.env.OPENCODE_API_KEY;
    if (!process.env.OPENCODE_API_KEY && process.env.OPENCODE_ZEN_API_KEY) {
      process.env.OPENCODE_API_KEY = process.env.OPENCODE_ZEN_API_KEY;
    }

    const hasAnyProviderCredential = Boolean(
      process.env.OPENCODE_API_KEY ??
      process.env.ANTHROPIC_API_KEY ??
      process.env.OPENAI_API_KEY ??
      process.env.ZHIPU_API_KEY
    );

    if (!hasAnyProviderCredential) {
      throw new Error(
        'Live E2E requires provider credentials. Set OPENCODE_API_KEY/ANTHROPIC_API_KEY/OPENAI_API_KEY/ZHIPU_API_KEY.'
      );
    }

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      mkdirSync(repoDir, { recursive: true });
      process.chdir(repoDir);

      const git = simpleGit(repoDir);
      await git.init();
      await git.addConfig('user.name', 'DRS E2E');
      await git.addConfig('user.email', 'drs-e2e@example.com');

      mkdirSync(join(repoDir, 'src'), { recursive: true });

      writeFileSync(
        join(repoDir, 'src', 'query.ts'),
        ['export function findUser(userId: string) {', '  return userId.trim();', '}', ''].join(
          '\n'
        ),
        'utf-8'
      );

      await git.add('.');
      await git.commit('baseline for live e2e');

      writeFileSync(
        join(repoDir, 'src', 'query.ts'),
        [
          'export function findUser(userId: string) {',
          '  const sql = "SELECT * FROM users WHERE id = " + userId;',
          '  return sql;',
          '}',
          '',
        ].join('\n'),
        'utf-8'
      );

      const config = buildLiveConfig(liveModel);

      await reviewLocal(config, {
        staged: false,
        outputPath,
        jsonOutput: false,
        debug: false,
      });

      const outputRaw = readFileSync(join(repoDir, outputPath), 'utf-8');
      const output = JSON.parse(outputRaw) as {
        summary: { filesReviewed: number };
        issues: unknown[];
        metadata?: { source?: string };
      };

      expect(output.summary.filesReviewed).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(output.issues)).toBe(true);
      expect(output.metadata?.source).toBe('local-unstaged');
    } finally {
      exitSpy.mockRestore();

      if (originalOpencodeApiKey === undefined) {
        delete process.env.OPENCODE_API_KEY;
      } else {
        process.env.OPENCODE_API_KEY = originalOpencodeApiKey;
      }

      process.chdir(originalCwd);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 300000);
});
