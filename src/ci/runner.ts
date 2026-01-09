import chalk from 'chalk';
import { loadConfig, validateConfig } from '../lib/config.js';
import { reviewMR } from '../cli/review-mr.js';

export interface CIEnvironment {
  platform: 'gitlab' | 'unknown';
  projectId?: string;
  mrIid?: number;
  targetBranch?: string;
  sourceBranch?: string;
  commitSha?: string;
}

/**
 * Detect CI environment from environment variables
 */
export function detectCIEnvironment(): CIEnvironment {
  // GitLab CI detection
  if (process.env.GITLAB_CI === 'true') {
    return {
      platform: 'gitlab',
      projectId: process.env.CI_PROJECT_ID,
      mrIid: process.env.CI_MERGE_REQUEST_IID
        ? parseInt(process.env.CI_MERGE_REQUEST_IID, 10)
        : undefined,
      targetBranch: process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME,
      sourceBranch: process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME,
      commitSha: process.env.CI_COMMIT_SHA,
    };
  }

  return { platform: 'unknown' };
}

/**
 * Run review in CI/CD environment
 */
export async function runCIReview(): Promise<void> {
  console.log(chalk.bold.cyan('\n📋 DRS | CI/CD Analysis Runner\n'));

  // Detect environment
  const env = detectCIEnvironment();

  if (env.platform === 'unknown') {
    console.error(chalk.red('Error: Unknown CI environment'));
    console.error(chalk.gray('Currently supported: GitLab CI'));
    process.exit(1);
  }

  console.log(chalk.gray(`Detected CI platform: ${env.platform}\n`));

  // Validate required environment variables
  if (!env.projectId) {
    console.error(chalk.red('Error: CI_PROJECT_ID not found'));
    process.exit(1);
  }

  if (!env.mrIid) {
    console.error(chalk.red('Error: CI_MERGE_REQUEST_IID not found'));
    console.error(chalk.gray('This job should only run on merge requests'));
    process.exit(1);
  }

  // Load configuration
  const projectDir = process.env.CI_PROJECT_DIR || process.cwd();
  const config = loadConfig(projectDir);

  try {
    validateConfig(config);
  } catch (error) {
    console.error(chalk.red('Configuration error:'), error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  console.log(chalk.gray(`Project: ${env.projectId}`));
  console.log(chalk.gray(`MR: !${env.mrIid}`));
  console.log(chalk.gray(`Branch: ${env.sourceBranch} → ${env.targetBranch}\n`));

  // Run review
  try {
    await reviewMR(config, {
      projectId: env.projectId,
      mrIid: env.mrIid,
      postComments: true, // Always post comments in CI
    });

    console.log(chalk.green.bold('\n✓ Review complete\n'));
  } catch (error) {
    console.error(chalk.red('\n✗ Review failed\n'));
    console.error(error);
    process.exit(1);
  }
}

/**
 * Check if running in CI environment
 */
export function isCI(): boolean {
  return !!(
    process.env.CI ||
    process.env.GITLAB_CI ||
    process.env.GITHUB_ACTIONS
  );
}
