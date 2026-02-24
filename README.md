# DRS · Diff Review System

[![npm version](https://img.shields.io/npm/v/@diff-review-system/drs)](https://www.npmjs.com/package/@diff-review-system/drs)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**AI-powered code review for GitLab MRs and GitHub PRs.**

DRS helps teams catch critical issues earlier with specialized review agents, unified reporting, and CI-friendly automation — all powered by Pi SDK.

## Why teams like DRS

- 🔒 **Specialized analysis domains**: security, quality, style, performance, documentation
- 🧠 **Flexible review modes**: multi-agent deep review, unified one-pass review, hybrid escalation
- 📦 **Pi-native runtime**: in-process execution by default, no separate runtime service required
- ✍️ **Description generation**: optional PR/MR summary generation and posting
- 🧾 **Portable outputs**: inline comments, JSON artifacts, and GitLab code quality reports
- 🎯 **Smart context compression**: dynamic budget sizing with `contextCompression.thresholdPercent`

## Quick Links

- [Quick Start](#quick-start)
- [Deployment Modes](#deployment-modes)
- [Customization](#customization)
- [Configuration](#configuration)
- [Documentation](#documentation)

## Quick Start

### 1. Prerequisites

- Node.js 20+
- API key for your chosen model provider (Anthropic/OpenAI/ZhipuAI/etc.)

### 2. Install DRS

```bash
npm install -g @diff-review-system/drs
```

This installs DRS with Pi runtime bundled — no separate runtime installation needed.

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
# - Pi runtime runs in-process automatically (no remote server needed)
# - Provider API Key: Set the API key for your chosen model provider
#   - ANTHROPIC_API_KEY for Claude models (e.g., anthropic/claude-opus-4-5-20251101)
#   - ZHIPU_API_KEY for GLM models (e.g., zhipuai/glm-4.7)
#   - OPENAI_API_KEY for OpenAI models (e.g., openai/gpt-4)
#   - See .env.example for all supported providers
```

DRS CLI now loads `.env` automatically from your current working directory.

**Note**: DRS runs Pi in-process by default and does not require a remote runtime endpoint.

### 5. Review Local Changes

```bash
# Review unstaged changes
drs review-local

# Review staged changes
drs review-local --staged

# Use specific agents
drs review-local --agents security,quality
```

### Most-Used Commands

| Goal | Command |
|---|---|
| Review local unstaged changes | `drs review-local` |
| Review local staged changes | `drs review-local --staged` |
| Review GitHub PR | `drs review-pr --owner <owner> --repo <repo> --pr <number>` |
| Review GitLab MR | `drs review-mr --project <group/repo> --mr <number>` |
| Generate PR description | `drs describe-pr --owner <owner> --repo <repo> --pr <number>` |
| Generate MR description | `drs describe-mr --project <group/repo> --mr <number>` |

## Deployment Modes

### Mode 1: Local CLI

Review code locally before pushing:

```bash
# Review local changes
drs review-local

# Review specific GitLab MR
drs review-mr --project my-org/my-repo --mr 123 --post-comments

# Review GitLab MR and auto-generate a description (optionally post it)
drs review-mr --project my-org/my-repo --mr 123 --describe
drs review-mr --project my-org/my-repo --mr 123 --describe --post-description

# Review GitLab MR and generate code quality report
drs review-mr --project my-org/my-repo --mr 123 --code-quality-report gl-code-quality-report.json

# Review specific GitHub PR
drs review-pr --owner octocat --repo hello-world --pr 456 --post-comments

# Review GitHub PR and auto-generate a description (optionally post it)
drs review-pr --owner octocat --repo hello-world --pr 456 --describe
drs review-pr --owner octocat --repo hello-world --pr 456 --describe --post-description

# Override base branch used for diff hints
drs review-pr --owner octocat --repo hello-world --pr 456 --base-branch release/2026-01

# Generate review JSON first, then post comments after manual review
drs review-pr --owner octocat --repo hello-world --pr 456 -o review.json
drs post-comments --input review.json --owner octocat --repo hello-world --pr 456

# Show the diff context passed to agents
drs show-changes --owner octocat --repo hello-world --pr 456

# Show diff context for a single file
drs show-changes --owner octocat --repo hello-world --pr 456 --file src/app.ts

# Show diff context using a specific base branch
drs show-changes --owner octocat --repo hello-world --pr 456 --base-branch release/2026-01

# Generate PR/MR descriptions on demand
drs describe-pr --owner octocat --repo hello-world --pr 456
drs describe-pr --owner octocat --repo hello-world --pr 456 --post-description
drs describe-mr --project my-org/my-repo --mr 123
drs describe-mr --project my-org/my-repo --mr 123 --post-description
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
- Pi-based CI setup examples
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
    - npm install -g @diff-review-system/drs
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

## Pi Runtime Configuration

DRS runs on Pi SDK as the sole review runtime.

### In-Process Runtime (Default)

By default, DRS starts Pi runtime in-process:

```bash
drs review-local
```

### Runtime Mode

DRS uses Pi in-process runtime only.

## Architecture

DRS uses Pi runtime wiring with markdown-based agent definitions:

```
.pi/
└── agents/
    └── review/
        ├── security.md          # Security specialist
        ├── quality.md           # Code quality expert
        ├── style.md             # Style checker
        ├── performance.md       # Performance analyzer
        └── documentation.md     # Documentation reviewer
```

Built-in agent definitions live under `.pi/agents`.

## Customization

### Override Default Agents

Create custom agents in your project:

```bash
# Create custom security agent
mkdir -p .drs/agents/security
cat > .drs/agents/security/agent.md << 'EOF'
---
description: Custom security reviewer
model: anthropic/claude-sonnet-4-5-20250929
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
  mode: unified
  agents:
    - security
    - quality
  ignorePatterns:
    - "*.test.ts"
    - "*.md"
  describe:
    enabled: true
    postDescription: false

contextCompression:
  enabled: true
  # Dynamic budget = thresholdPercent × model context window
  thresholdPercent: 0.15
  # Fallback if model context window metadata is unavailable
  maxTokens: 32000
  softBufferTokens: 1500
  hardBufferTokens: 1000

describe:
  model: zhipuai/glm-4.7
```

Notes:
- `review.describe` controls auto-description when running `review-mr` or `review-pr`.
- CLI flags override config: `--describe` / `--skip-describe` and `--post-description` / `--skip-post-description`.
- `describe.model` is used by `describe-mr`/`describe-pr` and by review-driven descriptions.
- `contextCompression.thresholdPercent` sets a context-window-aware budget (e.g. `0.15` means 15%).
- `contextCompression.maxTokens` is the fallback cap when context window metadata is unavailable.
- `review.agents` explicitly enables deep-review agents; remove an entry to disable that agent.
- Built-in review agent names are: `security`, `quality`, `style`, `performance`, `documentation`.
- Unknown agent names fail fast with a validation error before review execution starts.

### Model Pricing Overrides (Cost Reporting)

If your provider/model reports token usage but returns `$0.0000` cost, you can set pricing manually.
Values are in **USD per 1M tokens**.

```yaml
pricing:
  models:
    opencode/glm-5-free:
      input: 0.0
      output: 0.0
      cacheRead: 0.0
      cacheWrite: 0.0
```

You can also set pricing directly under `pi.provider.<name>.models.<model>.cost` for custom providers.

### Custom Provider Model Metadata (Context Window & Output Limits)

If you define custom models under `pi.provider.<name>.models`, you can also set model metadata used by DRS:

- `contextWindow`: used for dynamic compression sizing when `thresholdPercent` is enabled
- `maxTokens`: model output limit hint
- `cost`: token pricing override (USD per 1M tokens)

```yaml
pi:
  provider:
    my-provider:
      npm: "@ai-sdk/openai-compatible"
      name: "My Provider"
      options:
        baseURL: "https://api.example.com/v1"
        apiKey: "{env:MY_PROVIDER_API_KEY}"
      models:
        my-model:
          name: "My Model"
          contextWindow: 200000
          maxTokens: 8192
          cost:
            input: 0.50
            output: 1.50
            cacheRead: 0.00
            cacheWrite: 0.00
```

> Note: For built-in providers/models, context window metadata comes from the runtime model registry.

### Context Compression (Large Diff Handling)

DRS trims large diffs before sending them to models, so reviews stay within context limits.

- `thresholdPercent` enables **dynamic budgeting** based on model context window.
- `maxTokens` is used as fallback when context metadata is missing.
- Generated files and deletion-only hunks can be auto-excluded from prompt context.

Example:

```yaml
contextCompression:
  enabled: true
  thresholdPercent: 0.15 # 15% of model context window
  maxTokens: 32000       # fallback cap
  softBufferTokens: 1500
  hardBufferTokens: 1000
  tokenEstimateDivisor: 4
```

### Pi-Native Skill Discovery

DRS now auto-discovers review skills from both directories when `review.paths.skills` is not set:

1. `.drs/skills` (project-level overrides)
2. `.pi/skills` (Pi-native skills)

If the same skill name exists in both locations, `.drs/skills` wins.

Example layout:

```text
.drs/skills/
  secure-fetch/SKILL.md        # Project override (preferred)
.pi/skills/
  secure-fetch/SKILL.md        # Pi-native fallback
  db-indexing/SKILL.md         # Additional Pi-native skill
```

To force a single custom skills directory, set `review.paths.skills`:

```yaml
review:
  paths:
    skills: config/review-skills
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
GITLAB_URL=https://gitlab.com
REVIEW_AGENTS=security,quality,style,performance
```

### Configuration Files

1. `.drs/drs.config.yaml` - DRS-specific configuration
2. `.gitlab-review.yml` - Alternative location
3. Environment variables (for provider credentials and platform tokens)

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
- API key for your selected provider (Anthropic/OpenAI/ZhipuAI/etc.)
- GitLab access token (for GitLab MR reviews)
- GitHub access token (for GitHub PR reviews)
- Git 2.30+ (for local mode)

Pi runtime is included as a dependency — no separate installation or server needed.

## License

Apache-2.0

## Documentation

- [GitLab CI Integration Guide](docs/GITLAB_CI_INTEGRATION.md) - Complete guide for GitLab CI/CD setup
- [GitHub Actions Integration Guide](docs/GITHUB_ACTIONS_INTEGRATION.md) - GitHub Actions workflow setup
- [External PR Security Guide](docs/EXTERNAL_PR_SECURITY.md) - Security controls for external contributors
- [Model Overrides Guide](docs/MODEL_OVERRIDES.md) - Per-agent model configuration
- [Development Guide](DEVELOPMENT.md) - Local development and testing guide
- [Architecture Document](ARCHITECTURE.md) - Pi runtime architecture
- [Pi Documentation](https://github.com/badlogic/pi-mono)

## Contributing

Contributions welcome! Please read the contributing guidelines first.

## Support

- Issues: [GitHub Issues](https://github.com/manojlds/drs/issues)
- Discussions: [GitHub Discussions](https://github.com/manojlds/drs/discussions)
- Repository: [github.com/manojlds/drs](https://github.com/manojlds/drs)
