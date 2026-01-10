# DRS - Diff Review System

**Intelligent Code Review Platform for GitLab and GitHub**

Enterprise-grade automated code review for Merge Requests and Pull Requests, powered by OpenCode SDK and Claude.

## Features

- **Comprehensive Analysis**: Advanced code review using Claude's latest models
- **Specialized Review Domains**: Security, quality, style, and performance analysis
- **Multi-Platform Support**: Native integration with GitLab and GitHub
- **Flexible Deployment**: CI/CD pipelines, webhook server, or local CLI
- **Highly Customizable**: Configure review agents with project-specific rules
- **Deep Integration**: Full API support for both GitLab and GitHub platforms

## Quick Start

### 1. Prerequisites

Install OpenCode CLI (required for in-process server mode):

```bash
npm install -g opencode-ai
```

### 2. Install DRS

```bash
npm install -g @diff-review-system/drs
```

### 3. Initialize Project

```bash
cd your-project
drs init
```

### 4. Configure Environment

```bash
# Copy example env file
cp .env.example .env

# Edit .env and set:
# - GITLAB_TOKEN: Your GitLab access token (for GitLab MRs)
# - GITHUB_TOKEN: Your GitHub access token (for GitHub PRs)
# - OPENCODE_SERVER: URL of your OpenCode instance (optional - will start in-process if not set)
# - Provider API Key: Set the API key for your chosen model provider
#   - ANTHROPIC_API_KEY for Claude models (e.g., anthropic/claude-opus-4-5-20251101)
#   - ZHIPU_API_KEY for GLM models (e.g., zhipuai/glm-4.7)
#   - OPENAI_API_KEY for OpenAI models (e.g., openai/gpt-4)
#   - See .env.example for all supported providers
```

**Note**: `OPENCODE_SERVER` is optional. If not provided, DRS will automatically start an OpenCode server in-process. For production deployments or when sharing across multiple tools, you can run a dedicated OpenCode server and set the URL.

### 5. Review Local Changes

```bash
# Review unstaged changes
drs review-local

# Review staged changes
drs review-local --staged

# Use specific agents
drs review-local --agents security,quality
```

## Deployment Modes

### Mode 1: Local CLI

Review code locally before pushing:

```bash
# Review local changes
drs review-local

# Review specific GitLab MR
drs review-mr --project my-org/my-repo --mr 123 --post-comments

# Review specific GitHub PR
drs review-pr --owner octocat --repo hello-world --pr 456 --post-comments
```

### Mode 2: GitLab CI/CD

Add to your `.gitlab-ci.yml`:

```yaml
include:
  - remote: 'https://raw.githubusercontent.com/manojlds/drs/main/src/ci/gitlab-ci.template.yml'

ai_review:
  extends: .drs_review
  stage: review
```

**See [GitLab CI Integration Guide](docs/GITLAB_CI_INTEGRATION.md)** for:
- Using the official OpenCode container (`ghcr.io/anomalyco/opencode`)
- Parallel pipeline strategies (child pipelines, DAG with needs)
- Complete examples that don't block your main pipeline

### Mode 3: GitHub Actions

Add to `.github/workflows/pr-review.yml`:

```yaml
name: DRS PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install OpenCode CLI
        run: npm install -g opencode-ai

      - name: Build from source
        run: |
          npm ci
          npm run build

      - name: Review Pull Request
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          node dist/cli/index.js review-pr \
            --owner ${{ github.event.repository.owner.login }} \
            --repo ${{ github.event.repository.name }} \
            --pr ${{ github.event.pull_request.number }} \
            --post-comments
```

**Required Secrets**:
- Provider API Key - set one based on your model choice:
  - `ANTHROPIC_API_KEY`: For Claude models
  - `ZHIPU_API_KEY`: For ZhipuAI GLM models
  - `OPENAI_API_KEY`: For OpenAI models
  - See [OpenCode providers](https://opencode.ai/docs/providers/) for other options

**Optional Configuration**:
- Set `OPENCODE_SERVER` secret if you want to use a remote OpenCode server instead of in-process mode

### Mode 4: Webhook Server

Deploy as a standalone service:

```bash
# Using Docker Compose
cd examples
docker-compose up -d

# Configure webhooks:
# GitLab: http://your-server:8080/webhook/gitlab (Merge request events, Comments)
# GitHub: http://your-server:8080/webhook/github (Pull request events)
```

## OpenCode Server Configuration

DRS supports two modes of OpenCode server operation:

### In-Process Server (Default)

If `OPENCODE_SERVER` is not set, DRS will automatically start an OpenCode server within the same process. **Note**: This still requires the OpenCode CLI to be installed globally.

```bash
# Install OpenCode CLI first (required)
npm install -g opencode-ai

# Then run DRS (server starts automatically)
drs review-local
```

**Pros:**
- Minimal configuration required (just install CLI)
- Automatic startup/shutdown
- Simpler deployment
- Lower latency

**Cons:**
- Requires OpenCode CLI installation
- Server lifetime tied to CLI process
- Cannot share across multiple tools
- Uses process resources

### Remote Server (Optional)

For production deployments or when sharing across multiple tools, run a dedicated OpenCode server:

```bash
# Set the server URL
export OPENCODE_SERVER=http://opencode.internal:3000
drs review-local
```

**Pros:**
- Persistent server
- Shared across multiple tools
- Better for CI/CD pipelines
- Can be scaled separately

**Cons:**
- Requires separate service setup
- Additional infrastructure

## Architecture

DRS uses OpenCode SDK with markdown-based agent definitions:

```
.opencode/
├── agent/
│   ├── gitlab-reviewer.md       # GitLab MR orchestrator
│   ├── github-reviewer.md       # GitHub PR orchestrator
│   ├── local-reviewer.md        # Local diff reviewer
│   └── review/
│       ├── security.md          # Security specialist
│       ├── quality.md           # Code quality expert
│       ├── style.md             # Style checker
│       └── performance.md       # Performance analyzer
└── opencode.jsonc               # Configuration
```

## Customization

### Override Default Agents

Create custom agents in your project:

```bash
# Create custom security agent
mkdir -p .drs/agents
cat > .drs/agents/security.md << 'EOF'
---
description: Custom security reviewer
model: opencode/claude-sonnet-4-5
---

You are a security expert for this specific application.

## Project-Specific Rules
[Add your custom rules here]
EOF
```

### Configure Review Behavior

Edit `.drs/drs.config.yaml`:

```yaml
review:
  agents:
    - security
    - quality
  ignorePatterns:
    - "*.test.ts"
    - "*.md"
```

## Review Domains

### Security Analysis

Focuses on:
- OWASP Top 10 vulnerabilities
- Injection attacks (SQL, XSS, Command)
- Authentication/authorization issues
- Sensitive data exposure
- Security misconfigurations

### Quality Analysis

Reviews:
- Design patterns and anti-patterns
- Code complexity
- DRY violations
- Error handling
- Code smells

### Style Analysis

Checks:
- Naming conventions
- Code formatting
- Documentation quality
- Type safety (TypeScript)
- Unused code

### Performance Analysis

Analyzes:
- Algorithmic complexity
- Database query efficiency
- Memory management
- Caching opportunities
- Concurrency issues

## Configuration

### Environment Variables

```bash
# Required (depending on platform)
GITLAB_TOKEN=glpat-xxx              # For GitLab MR reviews
GITHUB_TOKEN=ghp-xxx                # For GitHub PR reviews

# Provider API Keys (set the one for your chosen model provider)
ANTHROPIC_API_KEY=sk-ant-xxx        # For Anthropic Claude models
ZHIPU_API_KEY=xxx                   # For ZhipuAI GLM models
OPENAI_API_KEY=sk-xxx               # For OpenAI models

# Optional
OPENCODE_SERVER=http://localhost:3000  # Leave empty to start in-process server
GITLAB_URL=https://gitlab.com
REVIEW_AGENTS=security,quality,style,performance
```

### Configuration Files

1. `.drs/drs.config.yaml` - DRS-specific configuration
2. `.gitlab-review.yml` - Alternative location
3. `.opencode/opencode.jsonc` - OpenCode configuration

## Examples

See the `examples/` directory for:
- GitLab CI configuration
- Docker Compose setup
- Custom agent definitions
- Configuration templates

## Development

For comprehensive local development and testing instructions, see [DEVELOPMENT.md](DEVELOPMENT.md).

Quick start:

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Development mode
npm run dev
```

## Requirements

- Node.js 20+
- OpenCode CLI (`npm install -g opencode-ai`) - Required even for in-process mode
- Anthropic API key (for Claude AI)
- GitLab access token (for GitLab MR reviews)
- GitHub access token (for GitHub PR reviews)
- Git 2.30+ (for local mode)
- OpenCode server instance (optional - will start in-process if not provided)

## License

Apache-2.0

## Documentation

- [GitLab CI Integration Guide](docs/GITLAB_CI_INTEGRATION.md) - Complete guide for GitLab CI/CD setup
- [Development Guide](DEVELOPMENT.md) - Local development and testing guide
- [Design Document](DESIGN.md) - Original design using Claude Agent SDK
- [Architecture Document](ARCHITECTURE.md) - OpenCode SDK architecture
- [Publishing Guide](PUBLISHING_SETUP.md) - How to publish to npm
- [OpenCode Documentation](https://opencode.ai/docs)
- [GitLab API](https://docs.gitlab.com/ee/api/)

## Contributing

Contributions welcome! Please read the contributing guidelines first.

## Support

- Issues: [GitHub Issues](https://github.com/your-org/drs/issues)
- Discussions: [GitHub Discussions](https://github.com/your-org/drs/discussions)
