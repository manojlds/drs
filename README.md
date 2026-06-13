# DRS · Diff Review System

[![npm version](https://img.shields.io/npm/v/@diff-review-system/drs)](https://www.npmjs.com/package/@diff-review-system/drs)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Workflow-first AI code maintenance for reviews, changelogs, docs, and repository upkeep.**

DRS runs agentic workflows for local diffs, GitHub PRs, and GitLab MRs. Review is a first-class packaged workflow, and the same workflow engine can update changelogs, fix review findings, refresh agent guidance, post comments, and compose project-specific maintenance pipelines — all powered by Pi SDK.

## Why teams like DRS

- 🧭 **Workflow-first automation**: run packaged or project-defined DAG workflows with `drs workflow run`
- 🎯 **First-class review workflows**: `local-review`, `github-pr-review`, and `gitlab-mr-review` are included out of the box
- 🧠 **Flexible agent pipelines**: add your own project-specific `review/*` and `task/*` agents
- 📦 **Pi-native runtime**: in-process execution by default, no separate runtime service required
- ✍️ **Maintenance workflows**: update changelogs, fix review issues, refresh AGENTS.md-style guidance, and generate PR/MR descriptions
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

### 5. Run Local Workflows

```bash
# Review unstaged changes
drs workflow run local-review

# Review staged changes
drs workflow run local-staged-review

# Update CHANGELOG.md from local changes
drs workflow run local-changelog-update

# Update CHANGELOG.md from the previous tag to the current tag, or explicit refs
drs workflow run tag-changelog-update --input from=v3.3.1 --input to=v4.0.0-rc.1

# Fix issues from a saved workflow review result
drs workflow run local-fix-review-issues --input-file review=.drs/local-review.json

# Refresh AGENTS.md or equivalent repository guidance
drs workflow run local-update-agents-md

# To use project-specific agents, configure review.agents in .drs/drs.config.yaml
# then run the same workflow.
```

### Most-Used Commands

| Goal | Command |
|---|---|
| Review local unstaged changes | `drs workflow run local-review` |
| Review local staged changes | `drs workflow run local-staged-review` |
| Update changelog from local changes | `drs workflow run local-changelog-update` |
| Update changelog from tag range | `drs workflow run tag-changelog-update` |
| Fix issues from saved review output | `drs workflow run local-fix-review-issues --input-file review=.drs/local-review.json` |
| Update AGENTS.md-style guidance | `drs workflow run local-update-agents-md` |
| Update changelog and review local changes | `drs workflow run local-changelog-review` |
| Review GitHub PR via workflow | `drs workflow run github-pr-review --input owner=<owner> --input repo=<repo> --input pr=<number>` |
| Review GitLab MR via workflow | `drs workflow run gitlab-mr-review --input project=<group/repo> --input mr=<number>` |
| Show GitHub PR review context | `drs workflow run github-pr-show-changes --input owner=<owner> --input repo=<repo> --input pr=<number>` |
| Show GitLab MR review context | `drs workflow run gitlab-mr-show-changes --input project=<group/repo> --input mr=<number>` |
| Review and comment on GitHub PR via workflow | `drs workflow run github-pr-review-post --input owner=<owner> --input repo=<repo> --input pr=<number>` |
| Review and comment on GitLab MR via workflow | `drs workflow run gitlab-mr-review-post --input project=<group/repo> --input mr=<number>` |
| Review GitLab MR and write Code Quality report | `drs workflow run gitlab-mr-review-code-quality --input project=<group/repo> --input mr=<number>` |
| Review/comment GitLab MR and write Code Quality report | `drs workflow run gitlab-mr-review-post-code-quality --input project=<group/repo> --input mr=<number>` |
| Generate PR description | `drs workflow run github-pr-describe --input owner=<owner> --input repo=<repo> --input pr=<number>` |
| Generate MR description | `drs workflow run gitlab-mr-describe --input project=<group/repo> --input mr=<number>` |
| Post or update a PR comment | `drs workflow run github-pr-post-comment --input owner=<owner> --input repo=<repo> --input pr=<number> --input body="..." --input marker=<id>` |
| Post or update an MR comment | `drs workflow run gitlab-mr-post-comment --input project=<group/repo> --input mr=<number> --input body="..." --input marker=<id>` |
| Run any configured agent | `drs run-agent task/docs-updater --prompt "Update release notes"` |
| Run a configured workflow | `drs workflow run release-notes --input-file diff=.drs/diff.md` |
| Run the default project workflow | `drs workflow run` |
| List available workflows | `drs workflow list` |

## Deployment Modes

### Mode 1: Local CLI

Review code locally before pushing:

```bash
# Review local changes
drs workflow run local-review

# Review specific GitLab MR
drs workflow run gitlab-mr-review-post --input project=my-org/my-repo --input mr=123

# Review specific GitHub PR
drs workflow run github-pr-review-post --input owner=octocat --input repo=hello-world --input pr=456

# Review local staged changes
drs workflow run local-staged-review

# Override model/agent behavior through config, then run workflows
drs workflow run github-pr-review --input owner=octocat --input repo=hello-world --input pr=456

# Use ultrathink with workflows
drs workflow run github-pr-review --input owner=octocat --input repo=hello-world --input pr=456 --ultrathink

# Show the diff context passed to agents
drs workflow run github-pr-show-changes --input owner=octocat --input repo=hello-world --input pr=456

# Show diff context for a single file
drs workflow run github-pr-show-changes --input owner=octocat --input repo=hello-world --input pr=456 --input file=src/app.ts

# Generate PR/MR descriptions on demand
drs workflow run github-pr-describe --input owner=octocat --input repo=hello-world --input pr=456
drs workflow run github-pr-describe-post --input owner=octocat --input repo=hello-world --input pr=456
drs workflow run gitlab-mr-describe --input project=my-org/my-repo --input mr=123
drs workflow run gitlab-mr-describe-post --input project=my-org/my-repo --input mr=123

# Post or update a single marked PR/MR comment
drs workflow run github-pr-post-comment --input owner=octocat --input repo=hello-world --input pr=456 --input body="Release notes are ready." --input marker=release-notes
drs workflow run gitlab-mr-post-comment --input project=my-org/my-repo --input mr=123 --input body="Release notes are ready." --input marker=release-notes
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
- Use review-post workflows for critical issues requiring discussion
- Use **code quality reports** (`--code-quality-report`) for comprehensive static analysis
- Use **both together** for maximum visibility

### CLI Usage

```bash
# Use workflow-based MR review with comments
drs workflow run gitlab-mr-review-post --input project=my-org/my-repo --input mr=123

# For code quality artifacts, run a packaged code-quality workflow
drs workflow run gitlab-mr-review-code-quality --input project=my-org/my-repo --input mr=123
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
    - drs workflow run gitlab-mr-review-post --input project=$CI_PROJECT_PATH --input mr=$CI_MERGE_REQUEST_IID
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
drs workflow run local-review
```

### Runtime Mode

DRS uses Pi in-process runtime only.

## Architecture

DRS uses Pi runtime wiring with markdown-based agent definitions. Agents are addressed by fully qualified ids: `<namespace>/<name>`.

```
.pi/
└── agents/
    └── review/
        └── unified-reviewer.md  # Packaged unified reviewer
```

Built-in agent definitions live under `.pi/agents`.

## Customization

> **Full guide**: See [docs/CUSTOM_AGENTS.md](docs/CUSTOM_AGENTS.md) for complete documentation on custom agents, skills, context, per-agent tools, and configuration examples.

### Override Default Agents

Create custom agents in your project:

```bash
# Override the packaged unified reviewer
mkdir -p .drs/agents/review/unified-reviewer
cat > .drs/agents/review/unified-reviewer/agent.md << 'EOF'
---
description: Custom unified reviewer
model: anthropic/claude-sonnet-4-5-20250929
---

You are a reviewer for this specific application.

## Project-Specific Rules
[Add your custom rules here]
EOF
```

### Add Context Without Overriding

Add project-specific guidance to a built-in agent without replacing its prompt:

```bash
mkdir -p .drs/agents/review/unified-reviewer
cat > .drs/agents/review/unified-reviewer/context.md << 'EOF'
# Unified Reviewer Context
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

Then add to config: `review.agents: [review/unified-reviewer, review/api-reviewer]`

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

Define reusable project workflows in `.drs/workflows/*.yaml`.

```yaml
name: release-notes
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
drs workflow run # uses workflow.default from .drs/drs.config.yaml when configured
drs workflow run release-notes --input-file diff=changes.md --json
```

Select the default workflow in `.drs/drs.config.yaml`:

```yaml
workflow:
  default: local-changelog-review
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
  ignorePatterns:
    - "*.test.ts"
    - "*.md"
  describe:
    enabled: true
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
- Review orchestration is workflow-first in v4: use `drs workflow run ...` for local/PR/MR review.
- `describe.model` is used by describe workflows and by review-driven descriptions.
- `contextCompression.thresholdPercent` sets a context-window-aware budget (e.g. `0.15` means 15%).
- `contextCompression.maxTokens` is the fallback cap when context window metadata is unavailable.
- `review.agents` controls exactly which review agents run.
- Packaged built-in review agent ID: `review/unified-reviewer`.
- Add project-specific review agents under `.drs/agents/review/<name>/agent.md` and include them in `review.agents`.
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
REVIEW_AGENTS=review/unified-reviewer
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
