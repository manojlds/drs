import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';

const DEFAULT_DRS_CONFIG = `# DRS Configuration
# Documentation: https://github.com/your-org/drs

review:
  # Review agents to use
  agents:
    - security
    - quality
    - style
    - performance

  # Automatically review new MRs
  autoReview: true

  # Review when bot is mentioned
  reviewOnMention: true

  # Review when these labels are added
  reviewOnLabel:
    - needs-review
    - security-review

  # Files to ignore during review
  ignorePatterns:
    - "*.test.ts"
    - "*.spec.ts"
    - "**/__tests__/**"
    - "**/__mocks__/**"
    - "*.md"
    - "package-lock.json"
    - "yarn.lock"
    - "pnpm-lock.yaml"

output:
  format: terminal
  verbosity: normal
`;

const EXAMPLE_GITLAB_CI = `# Example GitLab CI configuration for DRS
# Add this to your .gitlab-ci.yml file

stages:
  - review
  - test
  - deploy

# AI Code Review
ai_review:
  stage: review
  image: node:20
  only:
    - merge_requests
  script:
    - npm install -g @drs/gitlab-review-bot
    - drs review-mr --mr $CI_MERGE_REQUEST_IID --project $CI_PROJECT_ID --post-comments
  variables:
    OPENCODE_SERVER: "http://opencode.internal:3000"
    GITLAB_TOKEN: $CI_JOB_TOKEN
  allow_failure: true
`;

const EXAMPLE_ENV = `# DRS Environment Variables

# OpenCode Server URL
OPENCODE_SERVER=http://localhost:3000

# GitLab Configuration
GITLAB_URL=https://gitlab.com
GITLAB_TOKEN=your-gitlab-token-here

# Review Configuration (optional, overrides .drs/drs.config.yaml)
REVIEW_AGENTS=security,quality,style,performance
`;

/**
 * Initialize DRS configuration in a project
 */
export async function initProject(projectPath: string): Promise<void> {
  console.log(chalk.bold.cyan('\n🚀 Initializing DRS Configuration\n'));

  // Create .drs directory
  const drsDir = join(projectPath, '.drs');
  if (!existsSync(drsDir)) {
    mkdirSync(drsDir, { recursive: true });
    console.log(chalk.green('✓'), 'Created', chalk.cyan('.drs/'), 'directory');
  } else {
    console.log(chalk.yellow('⚠'), chalk.cyan('.drs/'), 'directory already exists');
  }

  // Create .drs/agents directory
  const agentsDir = join(drsDir, 'agents');
  if (!existsSync(agentsDir)) {
    mkdirSync(agentsDir, { recursive: true });
    console.log(chalk.green('✓'), 'Created', chalk.cyan('.drs/agents/'), 'directory');
  }

  // Create drs.config.yaml
  const configPath = join(drsDir, 'drs.config.yaml');
  if (!existsSync(configPath)) {
    writeFileSync(configPath, DEFAULT_DRS_CONFIG, 'utf-8');
    console.log(chalk.green('✓'), 'Created', chalk.cyan('.drs/drs.config.yaml'));
  } else {
    console.log(chalk.yellow('⚠'), chalk.cyan('.drs/drs.config.yaml'), 'already exists');
  }

  // Create examples directory
  const examplesDir = join(drsDir, 'examples');
  if (!existsSync(examplesDir)) {
    mkdirSync(examplesDir, { recursive: true });

    // Write example GitLab CI config
    writeFileSync(
      join(examplesDir, 'gitlab-ci.example.yml'),
      EXAMPLE_GITLAB_CI,
      'utf-8'
    );

    // Write example .env file
    writeFileSync(
      join(examplesDir, '.env.example'),
      EXAMPLE_ENV,
      'utf-8'
    );

    console.log(chalk.green('✓'), 'Created example configurations in', chalk.cyan('.drs/examples/'));
  }

  // Create custom agents info
  const customAgentReadme = `# Custom Review Agents

Place your custom review agent definitions (markdown files) in this directory.

## Example: Custom Security Agent

Create a file \`.drs/agents/security.md\` to override the default security agent:

\`\`\`markdown
---
description: Custom security reviewer with project-specific rules
color: "#E53E3E"
model: opencode/claude-sonnet-4-5
tools:
  Read: true
  Glob: true
  Grep: true
---

You are a security expert for this specific application.

## Project-Specific Security Rules

[Add your custom security rules here]
\`\`\`

## Priority Order

DRS loads agents in this order:
1. \`.drs/agents/\` (highest priority - project-specific)
2. \`.opencode/agent/\` (standard OpenCode location)
3. Built-in DRS agents (fallback)

## Learn More

- [DRS Documentation](https://github.com/your-org/drs)
- [OpenCode Agent Guide](https://opencode.ai/docs/agents)
`;

  const agentsReadmePath = join(agentsDir, 'README.md');
  if (!existsSync(agentsReadmePath)) {
    writeFileSync(agentsReadmePath, customAgentReadme, 'utf-8');
    console.log(chalk.green('✓'), 'Created', chalk.cyan('.drs/agents/README.md'));
  }

  // Summary
  console.log(chalk.bold.green('\n✓ DRS initialization complete!\n'));

  console.log(chalk.bold('Next steps:\n'));
  console.log('  1. Edit', chalk.cyan('.drs/drs.config.yaml'), 'to customize review behavior');
  console.log('  2. Set environment variables (see', chalk.cyan('.drs/examples/.env.example') + ')');
  console.log('  3. Run', chalk.cyan('drs review-local'), 'to review local changes');
  console.log('  4. See', chalk.cyan('.drs/examples/gitlab-ci.example.yml'), 'for CI/CD setup\n');
}
