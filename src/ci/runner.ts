import { loadConfig, validateConfig } from '../lib/config.js';
import { exitProcess } from '../lib/exit.js';
import { getLogger } from '../lib/logger.js';
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
  const log = getLogger();
  log.info('DRS CI/CD Analysis Runner starting');

  // Detect environment
  const env = detectCIEnvironment();

  if (env.platform === 'unknown') {
    log.error('Unknown CI environment. Currently supported: GitLab CI');
    exitProcess(1);
  }

  log.info(`Detected CI platform: ${env.platform}`);

  // Validate required environment variables
  if (!env.projectId) {
    log.error('CI_PROJECT_ID not found');
    exitProcess(1);
  }

  if (!env.mrIid) {
    log.error('CI_MERGE_REQUEST_IID not found. This job should only run on merge requests');
    exitProcess(1);
  }

  // Load configuration
  const projectDir = process.env.CI_PROJECT_DIR ?? process.cwd();
  const config = loadConfig(projectDir);

  try {
    validateConfig(config);
  } catch (error) {
    log.error(`Configuration error: ${error instanceof Error ? error.message : String(error)}`);
    exitProcess(1);
  }

  log.info(
    `Project: ${env.projectId} | MR: !${env.mrIid} | Branch: ${env.sourceBranch} → ${env.targetBranch}`
  );

  // Run review
  try {
    await reviewMR(config, {
      projectId: env.projectId,
      mrIid: env.mrIid,
      postComments: true, // Always post comments in CI
      postErrorComment: config.review.postErrorComment ?? false,
      describe: config.review.describe?.enabled ?? false,
      postDescription: config.review.describe?.postDescription ?? false,
    });

    log.info('Review complete');
  } catch (error) {
    log.error('Review failed', undefined, error);
    exitProcess(1);
  }
}

/**
 * Check if running in CI environment
 */
export function isCI(): boolean {
  return !!(process.env.CI ?? process.env.GITLAB_CI ?? process.env.GITHUB_ACTIONS);
}
