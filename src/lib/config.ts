import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import * as yaml from 'yaml';

export interface DRSConfig {
  // OpenCode configuration
  opencode: {
    serverUrl: string;
  };

  // GitLab configuration
  gitlab: {
    url: string;
    token: string;
  };

  // Review behavior
  review: {
    agents: string[];
    autoReview: boolean;
    reviewOnMention: boolean;
    reviewOnLabel: string[];
    ignorePatterns: string[];
    includePatterns?: string[];
  };

  // Output configuration
  output: {
    format: 'gitlab' | 'terminal' | 'json' | 'markdown';
    verbosity: 'minimal' | 'normal' | 'detailed';
  };
}

const DEFAULT_CONFIG: DRSConfig = {
  opencode: {
    serverUrl: process.env.OPENCODE_SERVER || 'http://localhost:3000',
  },
  gitlab: {
    url: process.env.GITLAB_URL || 'https://gitlab.com',
    token: process.env.GITLAB_TOKEN || '',
  },
  review: {
    agents: ['security', 'quality', 'style', 'performance'],
    autoReview: true,
    reviewOnMention: true,
    reviewOnLabel: ['needs-review', 'security-review'],
    ignorePatterns: [
      '*.test.ts',
      '*.spec.ts',
      '**/__tests__/**',
      '**/__mocks__/**',
      '*.md',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
    ],
  },
  output: {
    format: 'terminal',
    verbosity: 'normal',
  },
};

/**
 * Load configuration from various sources with precedence:
 * 1. CLI arguments (passed as overrides)
 * 2. Environment variables
 * 3. .drs/drs.config.yaml or .drs/drs.config.json
 * 4. .gitlab-review.yml
 * 5. Default values
 */
export function loadConfig(
  projectPath?: string,
  overrides?: Partial<DRSConfig>
): DRSConfig {
  const basePath = projectPath || process.cwd();
  let config = { ...DEFAULT_CONFIG };

  // Try loading from .drs/drs.config.yaml
  const drsConfigPath = resolve(basePath, '.drs/drs.config.yaml');
  if (existsSync(drsConfigPath)) {
    const fileConfig = yaml.parse(readFileSync(drsConfigPath, 'utf-8'));
    config = mergeConfig(config, fileConfig);
  }

  // Try loading from .gitlab-review.yml
  const gitlabReviewPath = resolve(basePath, '.gitlab-review.yml');
  if (existsSync(gitlabReviewPath)) {
    const fileConfig = yaml.parse(readFileSync(gitlabReviewPath, 'utf-8'));
    config = mergeConfig(config, fileConfig);
  }

  // Apply environment variable overrides
  if (process.env.OPENCODE_SERVER) {
    config.opencode.serverUrl = process.env.OPENCODE_SERVER;
  }
  if (process.env.GITLAB_URL) {
    config.gitlab.url = process.env.GITLAB_URL;
  }
  if (process.env.GITLAB_TOKEN) {
    config.gitlab.token = process.env.GITLAB_TOKEN;
  }
  if (process.env.REVIEW_AGENTS) {
    config.review.agents = process.env.REVIEW_AGENTS.split(',').map(a => a.trim());
  }

  // Apply CLI overrides
  if (overrides) {
    config = mergeConfig(config, overrides);
  }

  return config;
}

/**
 * Deep merge two config objects
 */
function mergeConfig(base: DRSConfig, override: Partial<DRSConfig>): DRSConfig {
  return {
    opencode: { ...base.opencode, ...override.opencode },
    gitlab: { ...base.gitlab, ...override.gitlab },
    review: { ...base.review, ...override.review },
    output: { ...base.output, ...override.output },
  };
}

/**
 * Validate that required configuration is present
 */
export function validateConfig(config: DRSConfig): void {
  if (!config.gitlab.token) {
    throw new Error(
      'GitLab token is required. Set GITLAB_TOKEN environment variable or configure in .gitlab-review.yml'
    );
  }

  if (!config.opencode.serverUrl) {
    throw new Error(
      'OpenCode server URL is required. Set OPENCODE_SERVER environment variable or configure in .drs/drs.config.yaml'
    );
  }

  if (config.review.agents.length === 0) {
    throw new Error('At least one review agent must be configured');
  }
}

/**
 * Check if a file should be ignored based on patterns
 */
export function shouldIgnoreFile(filePath: string, config: DRSConfig): boolean {
  // Check ignore patterns
  for (const pattern of config.review.ignorePatterns) {
    if (minimatch(filePath, pattern)) {
      return true;
    }
  }

  // If include patterns are specified, check those
  if (config.review.includePatterns && config.review.includePatterns.length > 0) {
    let matches = false;
    for (const pattern of config.review.includePatterns) {
      if (minimatch(filePath, pattern)) {
        matches = true;
        break;
      }
    }
    return !matches;
  }

  return false;
}

// Simple minimatch implementation for pattern matching
function minimatch(path: string, pattern: string): boolean {
  const regexPattern = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(path);
}
