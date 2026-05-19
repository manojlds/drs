# DRS · Diff Review System

[![npm version](https://img.shields.io/npm/v/@diff-review-system/drs)](https://www.npmjs.com/package/@diff-review-system/drs)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Automated AI code reviews for GitHub PRs and GitLab MRs.**

DRS helps teams catch critical issues earlier with specialized review agents, unified reporting, and CI-friendly automation — all powered by Pi SDK.

## Why teams like DRS

- 🔒 **Specialized analysis domains**: security, quality, style, performance, documentation
- 🧠 **Flexible agent pipelines**: compose any review agents (including `review/unified-reviewer`) in execution order
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
drs review-local --agents review/security,review/quality
```

### Most-Used Commands

| Goal | Command |
|---|---|
| Review local unstaged changes | `drs review-local` |
| Review local staged changes | `drs review-local --staged` |
| Review local unstaged changes via workflow | `drs workflow run local-review` |
| Review GitHub PR | `drs review-pr --owner <owner> --repo <repo> --pr <number>` |
| Review GitLab MR | `drs review-mr --project <group/repo> --mr <number>` |
| Review GitHub PR via workflow | `drs workflow run github-pr-review --input owner=<owner> --input repo=<repo> --input pr=<number>` |
| Review GitLab MR via workflow | `drs workflow run gitlab-mr-review --input project=<group/repo> --input mr=<number>` |
| Review by PR/MR URL (auto-detect platform) | `drs review-url <https://.../pull/... or .../-/merge_requests/...>` |
| Generate PR description | `drs describe-pr --owner <owner> --repo <repo> --pr <number>` |
| Generate MR description | `drs describe-mr --project <group/repo> --mr <number>` |
| Run any configured agent | `drs run-agent task/docs-updater --prompt "Update release notes"` |
| Run a configured workflow | `drs workflow run release-notes --input-file diff=.drs/diff.md` |

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

# Review by PR/MR URL (auto-detect GitHub vs GitLab)
drs review-url https://github.com/octocat/hello-world/pull/456 --post-comments
drs review-url https://gitlab.com/my-org/my-repo/-/merge_requests/123 --post-comments

# Review specific GitHub PR
drs review-pr --owner octocat --repo hello-world --pr 456 --post-comments

# Review GitHub PR and auto-generate a description (optionally post it)
drs review-pr --owner octocat --repo hello-world --pr 456 --describe
drs review-pr --owner octocat --repo hello-world --pr 456 --describe --post-description

# Enable extended thinking for deeper analysis
drs review-pr --owner octocat --repo hello-world --pr 456 --reasoning-effort high
drs review-mr --project my-org/my-repo --mr 123 --ultrathink

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

DRS uses Pi runtime wiring with markdown-based agent definitions. Agents are addressed by fully qualified ids: `<namespace>/<name>`.

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

> **Full guide**: See [docs/CUSTOM_AGENTS.md](docs/CUSTOM_AGENTS.md) for complete documentation on custom agents, skills, context, per-agent tools, and configuration examples.

### Override Default Agents

Create custom agents in your project:

```bash
# Create custom security agent
mkdir -p .drs/agents/review/security
cat > .drs/agents/review/security/agent.md << 'EOF'
---
description: Custom security reviewer
model: anthropic/claude-sonnet-4-5-20250929
---

You are a security expert for this specific application.

## Project-Specific Rules
[Add your custom rules here]
EOF
```

### Add Context Without Overriding

Add project-specific guidance to a built-in agent without replacing its prompt:

```bash
mkdir -p .drs/agents/review/quality
cat > .drs/agents/review/quality/context.md << 'EOF'
# Quality Context
- Flag functions over 200 lines as HIGH
- We use TypeORM — flag raw SQL queries
EOF
```

### Global Project Context

`.drs/context.md` is injected into **every** agent's prompt:

```markdown
# Project Context
Node.js microservice using Express + TypeORM.
Prioritize correctness, safety, and clarity.
```

### Create New Custom Agents

Add review agents that don't exist in the built-in set:

```bash
mkdir -p .drs/agents/review/api-reviewer
cat > .drs/agents/review/api-reviewer/agent.md << 'EOF'
---
description: REST API contract reviewer
tools:
  Read: true
  Grep: true
---
Review REST API changes for backward compatibility.
EOF
```

Then add to config: `review.agents: [review/security, review/quality, review/api-reviewer]`

For non-review work, create agents in any namespace and run them directly:

```bash
mkdir -p .drs/agents/task/docs-updater
cat > .drs/agents/task/docs-updater/agent.md << 'EOF'
---
description: Documentation update assistant
tools:
  Read: true
  Grep: true
---
Update documentation based on the user's request.
EOF

drs run-agent task/docs-updater --prompt "Summarize the latest API changes"
```

You can also put the run prompt and output behavior in config, then invoke only the agent id:

```yaml
agents:
  overrides:
    task/docs-updater:
      run:
        prompt: "Summarize the latest API changes"
        output: .drs/docs-summary.json
        json: true
```

```bash
drs run task/docs-updater
```

### Configure Workflows

Workflows compose agents and built-in actions into a dependency graph. They are useful when one agent produces an artifact that another agent or action consumes.

```yaml
workflows:
  release-notes:
    inputs:
      diff:
        file: .drs/diff.md
    nodes:
      summarize:
        agent: task/change-summarizer
        input: |
          Summarize these changes:

          {{inputs.diff}}
        output: summary
      write-summary:
        action: write
        needs: [summarize]
        input: "{{artifacts.summary}}"
        writes: RELEASE_NOTES.md
```

```bash
drs workflow run release-notes
drs workflow run release-notes --input-file diff=changes.md --json
```

See [docs/WORKFLOWS.md](docs/WORKFLOWS.md) for the full workflow configuration reference.

### Configure Review Behavior

Edit `.drs/drs.config.yaml`:

```yaml
agents:
  default:
    model: zhipuai/glm-4.7
    skills: []
  namespaces:
    review:
      model: anthropic/claude-sonnet-4-5-20250929
    task:
      model: openai/gpt-4o
  overrides:
    task/docs-updater:
      run:
        promptFile: prompts/docs-update.md
        output: .drs/docs-update.json
        json: true

review:
  agents:
    - review/unified-reviewer
    - review/security
    - review/quality
  ignorePatterns:
    - "*.test.ts"
    - "*.md"
  describe:
    enabled: true
    postDescription: false
  cursorFixLinks:
    enabled: false
    # workspace: my-repo

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
- `review.cursorFixLinks.enabled` adds opt-in `Fix in Cursor` links to posted review comments via Cursor's web deeplink bridge. CLI flags override config: `--fix-in-cursor` / `--skip-fix-in-cursor`.
- `describe.model` is used by `describe-mr`/`describe-pr` and by review-driven descriptions.
- `contextCompression.thresholdPercent` sets a context-window-aware budget (e.g. `0.15` means 15%).
- `contextCompression.maxTokens` is the fallback cap when context window metadata is unavailable.
- `review.agents` explicitly enables deep-review agents; remove an entry to disable that agent.
- Built-in review agent IDs are: `review/unified-reviewer`, `review/security`, `review/quality`, `review/style`, `review/performance`, `review/documentation`.
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

You can also set pricing directly under `pi.provider.<name>.models[].cost` for custom providers.

### Custom Provider Model Metadata (Context Window, Limits, Compat)

If you define custom providers/models under `pi.provider.<name>`, you can set metadata used by DRS:

- `contextWindow`: used for dynamic compression sizing when `thresholdPercent` is enabled
- `maxTokens`: model output limit hint
- `cost`: token pricing override (USD per 1M tokens)
- `compat`: OpenAI compatibility overrides passed through to Pi runtime (for proxy quirks)
  - set at provider level (`pi.provider.<name>.compat`) to apply defaults to all models
  - set at model level (`pi.provider.<name>.models[].compat`) for per-model overrides

```yaml
pi:
  provider:
    my-provider:
      baseUrl: "https://api.example.com/v1"
      api: "openai-completions"
      # apiKey accepts env var name, literal key, or !command
      apiKey: "MY_PROVIDER_API_KEY"
      # Optional provider-wide defaults for all models
      compat:
        supportsStore: false
      models:
        - id: "my-model"
          name: "My Model"
          contextWindow: 200000
          maxTokens: 8192
          cost:
            input: 0.50
            output: 1.50
            cacheRead: 0.00
            cacheWrite: 0.00
          # Optional per-model override
          compat:
            supportsUsageInStreaming: false
            maxTokensField: "max_tokens"
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

### Runtime Timeouts and Provider Retry

To prevent hung reviews, configure runtime-level call/stream timeouts and provider request retry limits:

```yaml
pi:
  runtime:
    operationTimeoutMs: 300000      # timeout for create/prompt/messages calls
    streamTimeoutMs: 900000         # total timeout while waiting for agent completion
    streamPollIntervalMs: 2000      # polling cadence for session messages
  retry:
    provider:
      timeoutMs: 45000              # provider request timeout passed to Pi SDK
      maxRetries: 2                 # provider request retries (Pi SDK)
      maxRetryDelayMs: 15000        # max backoff delay between retries
```

Environment variables override runtime timeout fields:

- `DRS_RUNTIME_OPERATION_TIMEOUT_MS`
- `DRS_RUNTIME_STREAM_TIMEOUT_MS`
- `DRS_RUNTIME_STREAM_POLL_INTERVAL_MS`

### Pi-Native Skill Discovery

DRS auto-discovers skills from these directories when `agents.paths.skills` is not set:

1. `.drs/skills` (project-level overrides)
2. `.agents/skills` (legacy/shared project skills)
3. `.pi/skills` (Pi-native skills)

If the same skill name exists in multiple locations, earlier paths win (`.drs` > `.agents` > `.pi`).

Example layout:

```text
.drs/skills/
  secure-fetch/SKILL.md        # Project override (preferred)
.agents/skills/
  secure-fetch/SKILL.md        # Legacy/shared fallback
.pi/skills/
  secure-fetch/SKILL.md        # Pi-native fallback
  db-indexing/SKILL.md         # Additional Pi-native skill
```

To force a single custom skills directory, set `agents.paths.skills`:

```yaml
agents:
  paths:
    skills: config/agent-skills
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
DRS_DEFAULT_MODEL=anthropic/claude-sonnet-4-5-20250929
DRS_AGENT_REVIEW_SECURITY_MODEL=anthropic/claude-opus-4-5-20251101
REVIEW_AGENTS=review/security,review/quality,review/style,review/performance
REVIEW_THINKING_LEVEL=medium              # Reasoning effort: off, minimal, low, medium, high, xhigh
```

### Configuration Files

1. `.drs/drs.config.yaml` - DRS-specific configuration
2. `.gitlab-review.yml` - Alternative location
3. Environment variables (for provider credentials and platform tokens)

## Development

Quick start for local development:

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
- [Custom Agents & Skills Guide](docs/CUSTOM_AGENTS.md) - Custom agents, context, skills, and per-agent tools
- [Workflows Guide](docs/WORKFLOWS.md) - Compose agents and actions into dependency graphs
- [Model Overrides Guide](docs/MODEL_OVERRIDES.md) - Per-agent model configuration
- [Pi Documentation](https://github.com/badlogic/pi-mono)

## Contributing

Contributions welcome! Please read the contributing guidelines first.

## Support

- Issues: [GitHub Issues](https://github.com/manojlds/drs/issues)
- Discussions: [GitHub Discussions](https://github.com/manojlds/drs/discussions)
- Repository: [github.com/manojlds/drs](https://github.com/manojlds/drs)
