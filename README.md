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

### 6. Diff Context Options (Analyzer-Only / Save & Load)

These options let you run the diff analyzer by itself, save the enriched context to a file,
and reuse it later to skip re-analysis. Useful for debugging, faster CI runs, or re-running
reviews with different agents.

**Options:**
- `--context-only` Run the diff analyzer only (skip review agents and comments)
- `--context-output <path>` Write diff context JSON to a file
- `--context-read <path>` Read diff context JSON from a file and skip the analyzer
- `--no-diff-analyzer` Disable the diff analyzer entirely

```bash
# Run diff analyzer only, save context for later
drs review-local --context-only --context-output diff-context.json

# Review using saved context (skip analyzer)
drs review-local --context-read diff-context.json

# Disable the diff analyzer for this run
drs review-local --no-diff-analyzer
```

**CI pattern: analyze once, reuse many times**
```bash
# Step 1: produce context
drs review-mr --project my-org/my-repo --mr 123 --context-only --context-output diff-context.json

# Step 2: run one or more reviews without re-analyzing
drs review-mr --project my-org/my-repo --mr 123 --context-read diff-context.json --post-comments
```

## Deployment Modes

### Mode 1: Local CLI

Review code locally before pushing:

```bash
# Review local changes
drs review-local

# Review specific GitLab MR
drs review-mr --project my-org/my-repo --mr 123 --post-comments

# Review GitLab MR and generate code quality report
drs review-mr --project my-org/my-repo --mr 123 --code-quality-report gl-code-quality-report.json

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

DRS includes a **secure, pre-configured workflow** at `.github/workflows/pr-review.yml` with built-in protection against external PR abuse.

**Security Features**:
- ✅ **Auto-review for trusted contributors** (repository members/collaborators)
- ⏸️ **Manual approval required** for external contributors
- 🔒 **Cost protection** prevents spam PRs from draining API credits
- 🏷️ **Label-based approval** with `safe-to-review` label

**Quick Setup**:

1. **Configure API Keys** in repository Settings → Secrets:
   - `ANTHROPIC_API_KEY` (for Claude models), or
   - `OPENCODE_ZEN_API_KEY` (for OpenCode Zen), or
   - `ZHIPU_API_KEY` (for ZhipuAI GLM models), or
   - `OPENAI_API_KEY` (for OpenAI models)

2. **Set up External PR Protection** (Important!):
   - Create GitHub Environment: `external-pr-review`
   - Add required reviewers (maintainers)
   - Create `safe-to-review` label

**See [GitHub Actions Integration Guide](docs/GITHUB_ACTIONS_INTEGRATION.md)** for:
- Complete setup instructions
- External PR security configuration
- Model configuration options
- Troubleshooting tips

**See [External PR Security Guide](docs/EXTERNAL_PR_SECURITY.md)** for:
- Detailed security setup
- Cost protection mechanisms
- Maintainer workflow
- Attack prevention strategies

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

## GitLab Code Quality Reports

DRS can generate GitLab-compatible code quality reports that integrate seamlessly with GitLab CI/CD. This provides an alternative (or complement) to inline MR comments.

### Why Use Code Quality Reports?

**Benefits:**
- **Native GitLab Integration**: Issues appear in the MR widget and Changes tab
- **Better UX**: Issues marked with symbols in the code gutter
- **All Severities**: Include MEDIUM/LOW issues without cluttering MR discussions
- **Historical Tracking**: GitLab tracks quality trends over time
- **Non-intrusive**: Doesn't create discussion threads

**When to Use:**
- Use **inline comments** (`--post-comments`) for critical issues requiring discussion
- Use **code quality reports** (`--code-quality-report`) for comprehensive static analysis
- Use **both together** for maximum visibility

### CLI Usage

```bash
# Generate code quality report only
drs review-mr --project my-org/my-repo --mr 123 \
  --code-quality-report gl-code-quality-report.json

# Use both comments and code quality report
drs review-mr --project my-org/my-repo --mr 123 \
  --post-comments \
  --code-quality-report gl-code-quality-report.json
```

### GitLab CI Integration

Add to your `.gitlab-ci.yml`:

```yaml
code_review:
  stage: review
  image: node:20-alpine
  before_script:
    - npm install -g @diff-review-system/drs opencode-ai
  script:
    - drs review-mr --project $CI_PROJECT_PATH --mr $CI_MERGE_REQUEST_IID
        --code-quality-report gl-code-quality-report.json
  artifacts:
    reports:
      codequality: gl-code-quality-report.json
    expire_in: 1 week
  only:
    - merge_requests
```

The code quality report will appear in:
1. **MR Overview**: Widget showing new/resolved issues
2. **Changes Tab**: Gutter symbols on problematic lines
3. **Pipeline Tab**: Quality trend graphs

### Report Format

DRS generates reports in GitLab's CodeClimate-compatible format:

```json
[
  {
    "description": "Query uses string concatenation. Use parameterized queries instead.",
    "check_name": "drs-security",
    "fingerprint": "7815696ecbf1c96e6894b779456d330e",
    "severity": "blocker",
    "location": {
      "path": "src/api/users.ts",
      "lines": { "begin": 42 }
    }
  }
]
```

**Severity Mapping:**
- CRITICAL → blocker
- HIGH → critical
- MEDIUM → major
- LOW → minor

For more details, see [GitLab Code Quality Documentation](https://docs.gitlab.com/ci/testing/code_quality/).

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
mkdir -p .drs/agents/security
cat > .drs/agents/security/agent.md << 'EOF'
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
