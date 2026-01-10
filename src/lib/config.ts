import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import * as yaml from 'yaml';

/**
 * Agent configuration - supports both simple string and detailed object format
 */
export interface AgentConfig {
  name: string;
  model?: string;
}

/**
 * Model override mapping from agent name to model identifier
 */
export type ModelOverrides = Record<string, string>;

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

  // GitHub configuration
  github: {
    token: string;
  };

  // Review behavior
  review: {
    agents: (string | AgentConfig)[];
    defaultModel?: string;
    autoReview: boolean;
    reviewOnMention: boolean;
    reviewOnLabel: string[];
    ignorePatterns: string[];
    includePatterns?: string[];
  };

  // Output configuration
  output: {
    format: 'gitlab' | 'github' | 'terminal' | 'json' | 'markdown';
    verbosity: 'minimal' | 'normal' | 'detailed';
  };
}

const DEFAULT_CONFIG: DRSConfig = {
  opencode: {
    serverUrl: process.env.OPENCODE_SERVER || '', // Empty string means use in-process server
  },
  gitlab: {
    url: process.env.GITLAB_URL || 'https://gitlab.com',
    token: process.env.GITLAB_TOKEN || '',
  },
  github: {
    token: process.env.GITHUB_TOKEN || '',
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
export function loadConfig(projectPath?: string, overrides?: Partial<DRSConfig>): DRSConfig {
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
  if (process.env.GITHUB_TOKEN) {
    config.github.token = process.env.GITHUB_TOKEN;
  }
  if (process.env.REVIEW_AGENTS) {
    // Environment variable is always simple string format (comma-separated)
    config.review.agents = process.env.REVIEW_AGENTS.split(',').map((a) => a.trim());
  }
  if (process.env.REVIEW_DEFAULT_MODEL) {
    config.review.defaultModel = process.env.REVIEW_DEFAULT_MODEL;
  }

  // Apply CLI overrides
  if (overrides) {
    config = mergeConfig(config, overrides);
  }

  return config;
}

/**
 * Deep merge two config objects, skipping undefined values
 */
function mergeConfig(base: DRSConfig, override: Partial<DRSConfig>): DRSConfig {
  return {
    opencode: mergeSection(base.opencode, override.opencode),
    gitlab: mergeSection(base.gitlab, override.gitlab),
    github: mergeSection(base.github, override.github),
    review: mergeSection(base.review, override.review),
    output: mergeSection(base.output, override.output),
  };
}

/**
 * Merge a config section, skipping undefined values
 */
function mergeSection<T extends Record<string, any>>(base: T, override?: Partial<T>): T {
  if (!override) return base;

  const result = { ...base };
  for (const key in override) {
    if (override[key] !== undefined) {
      result[key] = override[key] as any;
    }
  }
  return result;
}

/**
 * Validate that required configuration is present
 */
export function validateConfig(config: DRSConfig, platform?: 'gitlab' | 'github'): void {
  // Validate platform-specific tokens if a platform is specified
  if (platform === 'gitlab' && !config.gitlab.token) {
    throw new Error(
      'GitLab token is required. Set GITLAB_TOKEN environment variable or configure in config file'
    );
  }

  if (platform === 'github' && !config.github.token) {
    throw new Error(
      'GitHub token is required. Set GITHUB_TOKEN environment variable or configure in config file'
    );
  }

  // OPENCODE_SERVER is now optional - we'll start in-process if not provided
  if (!config.opencode.serverUrl) {
    console.log('ℹ️  OPENCODE_SERVER not set. Will start OpenCode server in-process.');
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
  const regexPattern = pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.');

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(path);
}

/**
 * Normalize agent configuration from mixed format to AgentConfig array
 */
export function normalizeAgentConfig(agents: (string | AgentConfig)[]): AgentConfig[] {
  return agents.map((agent) => {
    if (typeof agent === 'string') {
      return { name: agent };
    }
    return agent;
  });
}

/**
 * Extract agent names from configuration
 */
export function getAgentNames(config: DRSConfig): string[] {
  return normalizeAgentConfig(config.review.agents).map((agent) => agent.name);
}

/**
 * Build model overrides from config and environment variables
 * Precedence:
 * 1. Per-agent model in config
 * 2. Environment variable REVIEW_AGENT_<NAME>_MODEL (e.g., REVIEW_AGENT_SECURITY_MODEL)
 * 3. defaultModel in config
 * 4. Environment variable REVIEW_DEFAULT_MODEL
 */
export function getModelOverrides(config: DRSConfig): ModelOverrides {
  const overrides: ModelOverrides = {};
  const normalizedAgents = normalizeAgentConfig(config.review.agents);

  // Get default model from config or environment
  const defaultModel = config.review.defaultModel || process.env.REVIEW_DEFAULT_MODEL || undefined;

  for (const agent of normalizedAgents) {
    // Check per-agent environment variable (e.g., REVIEW_AGENT_SECURITY_MODEL)
    const envVarName = `REVIEW_AGENT_${agent.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MODEL`;
    const envModel = process.env[envVarName];

    // Precedence: agent.model > env var > defaultModel
    const model = agent.model || envModel || defaultModel;

    if (model) {
      // Map both the agent name and the review/<agent> format
      overrides[agent.name] = model;
      overrides[`review/${agent.name}`] = model;
    }
  }

  return overrides;
}
