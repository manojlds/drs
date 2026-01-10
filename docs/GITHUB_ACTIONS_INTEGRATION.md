# GitHub Actions Integration

This document describes how to integrate DRS with GitHub Actions for automated PR reviews.

## Overview

DRS includes a pre-configured GitHub Actions workflow (`.github/workflows/pr-review.yml`) that automatically reviews pull requests using OpenCode agents.

## Setup

### 1. Configure Secrets

In your GitHub repository, go to **Settings → Secrets and variables → Actions** and add the following secrets:

#### Required Secrets

- `GITHUB_TOKEN` - Automatically provided by GitHub Actions (no configuration needed)
- One of the following provider API keys (depending on your model choice):
  - `ANTHROPIC_API_KEY` - For Claude models (e.g., `anthropic/claude-opus-4-5-20251101`)
  - `OPENCODE_ZEN_API_KEY` - For OpenCode Zen models (e.g., `opencode/gpt-5.1-codex`)
  - `ZHIPU_API_KEY` - For ZhipuAI/GLM models (e.g., `zhipuai/glm-4.7`)
  - `OPENAI_API_KEY` - For OpenAI models (e.g., `openai/gpt-4`)

### 2. OpenCode Zen Special Handling

OpenCode Zen requires authentication via an `auth.json` file at `~/.local/share/opencode/auth.json`. The GitHub Actions workflow automatically handles this when `OPENCODE_ZEN_API_KEY` is set.

The workflow includes a dedicated step that:
1. Checks if `OPENCODE_ZEN_API_KEY` is configured
2. Creates the OpenCode auth directory
3. Writes the auth.json file with the proper format:

```json
{
  "opencode": {
    "type": "api",
    "key": "<your-api-key>"
  }
}
```

**Note:** Unlike other providers that use environment variables directly, OpenCode Zen requires this auth.json file. The workflow handles this automatically.

### 3. Configure Review Settings

Edit `.drs/drs.config.yaml` to customize your review agents and models:

```yaml
agents:
  - security
  - quality
  - style
  - performance

# For OpenCode Zen, use models like:
defaultModel: opencode/gpt-5.1-codex

# Or configure per-agent:
# agents:
#   - name: security
#     model: opencode/gpt-5.1-codex
#   - name: quality
#     model: anthropic/claude-opus-4-5-20251101
```

For more details on model configuration, see [MODEL_OVERRIDES.md](./MODEL_OVERRIDES.md).

## Workflow Details

The workflow is triggered on:
- Pull request opened
- Pull request synchronized (new commits pushed)
- Pull request reopened

### Workflow Steps

1. **Checkout code** - Checks out the PR branch
2. **Setup Node.js** - Installs Node.js 20
3. **Install OpenCode CLI** - Installs the OpenCode CLI globally
4. **Install dependencies** - Runs `npm ci`
5. **Build DRS** - Compiles TypeScript to JavaScript
6. **Setup OpenCode Zen Authentication** - (Optional) Creates auth.json if using OpenCode Zen
7. **Review Pull Request** - Runs DRS to review the PR and post comments

## Model Configuration Examples

### Using OpenCode Zen

```yaml
# .drs/drs.config.yaml
agents:
  - security
  - quality

defaultModel: opencode/gpt-5.1-codex
```

GitHub Secrets:
```
OPENCODE_ZEN_API_KEY=your-zen-api-key
```

### Using Anthropic Claude

```yaml
# .drs/drs.config.yaml
agents:
  - security
  - quality

defaultModel: anthropic/claude-opus-4-5-20251101
```

GitHub Secrets:
```
ANTHROPIC_API_KEY=sk-ant-your-key
```

### Mixed Providers

```yaml
# .drs/drs.config.yaml
agents:
  - name: security
    model: opencode/gpt-5.1-codex
  - name: quality
    model: anthropic/claude-opus-4-5-20251101
```

GitHub Secrets:
```
OPENCODE_ZEN_API_KEY=your-zen-api-key
ANTHROPIC_API_KEY=sk-ant-your-key
```

## Troubleshooting

### Authentication Errors

**Problem:** "Missing API key" errors in workflow logs

**Solutions:**
- Verify the secret is set correctly in GitHub Settings → Secrets
- Check that the secret name matches exactly (case-sensitive)
- For OpenCode Zen, ensure the auth.json setup step ran successfully
- Check workflow logs for "Setup OpenCode Zen Authentication" step output

### Model Not Found

**Problem:** Model errors during review

**Solutions:**
- Verify the model name in `.drs/drs.config.yaml` matches the provider format:
  - OpenCode Zen: `opencode/model-name`
  - Anthropic: `anthropic/model-name`
  - OpenAI: `openai/model-name`
  - ZhipuAI: `zhipuai/model-name`
- Ensure the corresponding API key secret is configured

### Review Not Posting

**Problem:** Review completes but no comments appear

**Solutions:**
- Check that the workflow has `pull-requests: write` permission (configured in workflow)
- Verify `GITHUB_TOKEN` has proper access
- Check workflow logs for error messages in the review step

## Customization

### Modify Review Trigger

Edit `.github/workflows/pr-review.yml` to change when reviews run:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened]
    # Add filters:
    paths:
      - 'src/**'
      - 'lib/**'
    # Or specific branches:
    branches:
      - main
      - develop
```

### Add Additional Steps

You can add custom steps before or after the review:

```yaml
- name: Run Tests
  run: npm test

- name: Review Pull Request
  # ... existing review step

- name: Notify Slack
  # ... custom notification step
```

## Security Best Practices

1. **Never commit API keys** - Always use GitHub Secrets
2. **Use repository secrets** for repository-specific keys
3. **Use organization secrets** for shared keys across repositories
4. **Rotate API keys regularly**
5. **Limit workflow permissions** to minimum required (already configured in workflow)

## See Also

- [MODEL_OVERRIDES.md](./MODEL_OVERRIDES.md) - Detailed model configuration guide
- [GitLab CI Integration](./GITLAB_CI_INTEGRATION.md) - GitLab equivalent setup
- [OpenCode Zen Documentation](https://opencode.ai/docs/zen/)
