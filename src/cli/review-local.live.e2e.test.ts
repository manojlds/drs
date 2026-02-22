/**
 * Live E2E test for review-local.
 *
 * Run manually (never in CI):
 *   DRS_E2E_LIVE=1 npm test -- src/cli/review-local.live.e2e.test.ts
 *
 * Optional:
 *   DRS_E2E_MODEL=provider/model-id
 */
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import simpleGit from 'simple-git';
import { config as loadDotenv } from 'dotenv';
import { describe, expect, it } from 'vitest';

loadDotenv();

const shouldRunLiveE2E = !process.env.CI && process.env.DRS_E2E_LIVE === '1';
const liveModel =
  process.env.DRS_E2E_MODEL ?? process.env.REVIEW_DEFAULT_MODEL ?? 'opencode/glm-5-free';

function runReviewLocalCli(
  cwd: string,
  outputPath: string
): Promise<{ code: number; logs: string }> {
  return new Promise((resolvePromise, reject) => {
    const repoRoot = process.cwd();
    const tsxBin = resolve(
      repoRoot,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
    );

    const child = spawn(
      tsxBin,
      [resolve(repoRoot, 'src/cli/index.ts'), 'review-local', '--output', outputPath],
      {
        cwd,
        env: {
          ...process.env,
          REVIEW_DEFAULT_MODEL: liveModel,
          OPENCODE_API_KEY: process.env.OPENCODE_API_KEY ?? process.env.OPENCODE_ZEN_API_KEY ?? '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let logs = '';
    child.stdout.on('data', (chunk: Buffer) => {
      logs += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      logs += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise({ code: code ?? -1, logs });
    });
  });
}

const describeLive = shouldRunLiveE2E ? describe : describe.skip;

describeLive('review-local live e2e (real LLM)', () => {
  it('runs full review-local pipeline against a real provider and writes JSON output', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'drs-live-e2e-'));
    const repoDir = join(tempRoot, 'repo');
    const outputPath = 'review-local-live-output.json';

    const hasAnyProviderCredential = Boolean(
      process.env.OPENCODE_API_KEY ??
      process.env.OPENCODE_ZEN_API_KEY ??
      process.env.ANTHROPIC_API_KEY ??
      process.env.OPENAI_API_KEY ??
      process.env.ZHIPU_API_KEY
    );

    if (!hasAnyProviderCredential) {
      throw new Error(
        'Live E2E requires provider credentials. Set OPENCODE_API_KEY/OPENCODE_ZEN_API_KEY/ANTHROPIC_API_KEY/OPENAI_API_KEY/ZHIPU_API_KEY.'
      );
    }

    try {
      mkdirSync(repoDir, { recursive: true });

      const git = simpleGit(repoDir);
      await git.init();
      await git.addConfig('user.name', 'DRS E2E');
      await git.addConfig('user.email', 'drs-e2e@example.com');

      mkdirSync(join(repoDir, 'src'), { recursive: true });
      mkdirSync(join(repoDir, '.drs'), { recursive: true });

      writeFileSync(
        join(repoDir, '.drs/drs.config.yaml'),
        [
          'review:',
          '  default:',
          `    model: ${liveModel}`,
          '    skills: []',
          '  mode: multi-agent',
          '  agents:',
          '    - security',
          '  ignorePatterns: []',
          '  describe:',
          '    enabled: false',
          '    postDescription: false',
          'contextCompression:',
          '  enabled: false',
          '',
        ].join('\n'),
        'utf-8'
      );

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

      const result = await runReviewLocalCli(repoDir, outputPath);

      if (!new Set([0, 1]).has(result.code)) {
        throw new Error(`review-local exited with code ${result.code}.\nLogs:\n${result.logs}`);
      }

      const outputFile = join(repoDir, outputPath);
      if (!existsSync(outputFile)) {
        throw new Error(`Expected output file was not created.\nLogs:\n${result.logs}`);
      }

      const outputRaw = readFileSync(outputFile, 'utf-8');
      const output = JSON.parse(outputRaw) as {
        summary: { filesReviewed: number };
        issues: unknown[];
        metadata?: { source?: string };
      };

      expect(output.summary.filesReviewed).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(output.issues)).toBe(true);
      expect(output.metadata?.source).toBe('local-unstaged');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 300000);
});
