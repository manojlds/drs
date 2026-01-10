import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';

const DEFAULT_DRS_CONFIG = `# DRS Configuration
# Documentation: https://github.com/your-org/drs

review:
  # Review agents to use (mix of built-in and custom)
  agents:
    - security
    - quality
    - style
    - performance

  # Automatically review new PRs/MRs
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

const DEFAULT_GLOBAL_CONTEXT = `# Project Context

## Architecture
<!-- Describe your system architecture -->

## Technology Stack
<!-- List your main technologies, frameworks, and tools -->

## Trust Boundaries
<!-- Explain what inputs are trusted vs untrusted -->

## Review Guidelines
<!-- Any project-specific guidelines for reviewers -->
`;

const EXAMPLE_AGENT_CONTEXT = `# Security Agent Context

## Project-Specific Security Rules

### What NOT to Flag
<!-- List patterns that are valid for your project -->

### What TO Flag
<!-- List security concerns specific to your project -->

## Severity Calibration
- **CRITICAL**: Actively exploitable vulnerabilities with high impact
- **HIGH**: Real security issues requiring immediate attention
- **MEDIUM**: Potential edge cases or hardening opportunities
- **LOW**: Best practice improvements
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
    - npm install -g @diff-review-system/drs
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
  console.log(chalk.bold.cyan('\n📋 DRS | Configuration Setup\n'));

  // Create .drs directory
  const drsDir = join(projectPath, '.drs');
  if (!existsSync(drsDir)) {
    mkdirSync(drsDir, { recursive: true });
    console.log(chalk.green('✓'), 'Created', chalk.cyan('.drs/'), 'directory');
  } else {
    console.log(chalk.yellow('⚠'), chalk.cyan('.drs/'), 'directory already exists');
  }

  // Create global context file
  const contextPath = join(drsDir, 'context.md');
  if (!existsSync(contextPath)) {
    writeFileSync(contextPath, DEFAULT_GLOBAL_CONTEXT, 'utf-8');
    console.log(chalk.green('✓'), 'Created', chalk.cyan('.drs/context.md'));
  } else {
    console.log(chalk.yellow('⚠'), chalk.cyan('.drs/context.md'), 'already exists');
  }

  // Create .drs/agents directory
  const agentsDir = join(drsDir, 'agents');
  if (!existsSync(agentsDir)) {
    mkdirSync(agentsDir, { recursive: true });
    console.log(chalk.green('✓'), 'Created', chalk.cyan('.drs/agents/'), 'directory');
  }

  // Create example agent folders
  const exampleAgents = ['security', 'quality', 'style', 'performance'];
  for (const agentName of exampleAgents) {
    const agentDir = join(agentsDir, agentName);
    if (!existsSync(agentDir)) {
      mkdirSync(agentDir, { recursive: true });

      // Create context.md template
      const agentContextPath = join(agentDir, 'context.md');
      writeFileSync(
        agentContextPath,
        EXAMPLE_AGENT_CONTEXT.replace(
          'Security',
          agentName.charAt(0).toUpperCase() + agentName.slice(1)
        ),
        'utf-8'
      );
    }
  }
  console.log(chalk.green('✓'), 'Created agent context templates in', chalk.cyan('.drs/agents/'));

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
    writeFileSync(join(examplesDir, 'gitlab-ci.example.yml'), EXAMPLE_GITLAB_CI, 'utf-8');

    // Write example .env file
    writeFileSync(join(examplesDir, '.env.example'), EXAMPLE_ENV, 'utf-8');

    console.log(
      chalk.green('✓'),
      'Created example configurations in',
      chalk.cyan('.drs/examples/')
    );
  }

  // Create custom agents info
  const customAgentReadme = `# DRS Agent Customization

DRS supports three levels of agent customization:

## 1. Global Context (.drs/context.md)

Project-wide context applied to ALL agents. Use this for:
- Architecture overview
- Technology stack
- Trust boundaries
- General review guidelines

## 2. Agent-Specific Context (.drs/agents/{name}/context.md)

**Additive** - Enhances the default agent with project-specific rules.

Example: \`.drs/agents/security/context.md\`
\`\`\`markdown
# Security Agent Context

## What NOT to Flag
- process.env for configuration (standard practice)
- Data from trusted APIs

## What TO Flag
- SQL injection vulnerabilities
- XSS in user-facing endpoints
\`\`\`

## 3. Full Agent Override (.drs/agents/{name}/agent.md)

**Replacement** - Completely replaces the default agent.

Example: \`.drs/agents/security/agent.md\`
\`\`\`markdown
---
description: Custom security reviewer
model: claude-sonnet-4-5
tools:
  Read: true
  Grep: true
---

You are a security expert specialized in [your domain].

[Complete custom instructions here]
\`\`\`

## Custom Agents

Create a new folder for custom agents:
\`.drs/agents/rails-reviewer/agent.md\`

Then add to \`.drs/drs.config.yaml\`:
\`\`\`yaml
review:
  agents:
    - security
    - quality
    - rails-reviewer  # Your custom agent
\`\`\`

## Future: Skills (Coming Soon)

\`.drs/agents/security/skills/python.md\`
\`.drs/agents/security/skills/nodejs.md\`

Skills will be auto-loaded based on detected languages.

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
  console.log('  1. Edit', chalk.cyan('.drs/context.md'), 'with your project context');
  console.log('  2. Customize agent behavior in', chalk.cyan('.drs/agents/{name}/context.md'));
  console.log('  3. Configure review settings in', chalk.cyan('.drs/drs.config.yaml'));
  console.log(
    '  4. Set environment variables (see',
    chalk.cyan('.drs/examples/.env.example') + ')'
  );
  console.log('  5. Run', chalk.cyan('drs review-pr'), 'to test on a PR\n');
  console.log(chalk.gray('See', chalk.cyan('.drs/agents/README.md'), 'for customization guide\n'));
}
