---
type: Configuration
title: DRS configuration
description: How DRS loads configuration from .drs/drs.config.yaml, environment variables, and CLI overrides.
tags: [configuration, drs.config.yaml, env, models, agents]
---

# DRS configuration

DRS merges configuration from several sources, with later sources taking precedence. The loader is `src/lib/config.ts`.

## Configuration sources

1. Hard-coded defaults in `src/lib/config.ts`.
2. Packaged workflow files from `.pi/workflows/*.yaml`.
3. Project workflow files from `.drs/workflows/*.yaml`.
4. `.drs/drs.config.yaml`.
5. Legacy `.gitlab-review.yml` alias.
6. Environment variables.
7. CLI overrides.

The file `.drs/drs.config.yaml` is the canonical project configuration. Inline `workflows:` maps at the top level of the config file are rejected and must be moved to `.drs/workflows/*.yaml`.

## Required settings

At least one review agent must be configured and a default model must be resolvable. The CLI will throw if these are missing:

```yaml
agents:
  default:
    model: opencode-go/kimi-k2.7-code

review:
  agents:
    - review/unified-reviewer
```

The default model can also be set with `DRS_DEFAULT_MODEL`.

## Pi runtime and providers

Custom providers are configured under `pi.provider`:

```yaml
pi:
  provider:
    opencode-go:
      apiKey: OPENCODE_API_KEY
      api: openai-completions
      baseUrl: https://opencode.ai/zen/go/v1
      models:
        - id: kimi-k2.7-code
          name: Kimi K2.7 Code
          contextWindow: 262144
          maxTokens: 262144
          cost:
            input: 0.95
            output: 4
```

Model metadata is used for context compression and cost fallback. Provider-wide `compat` settings apply to every model unless overridden per model.

Runtime timeouts are under `pi.runtime`:

```yaml
pi:
  runtime:
    operationTimeoutMs: 300000
    streamTimeoutMs: 900000
    streamPollIntervalMs: 2000
```

Environment overrides exist for each field: `DRS_RUNTIME_OPERATION_TIMEOUT_MS`, `DRS_RUNTIME_STREAM_TIMEOUT_MS`, `DRS_RUNTIME_STREAM_POLL_INTERVAL_MS`.

Provider retry is configured under `pi.retry.provider`:

```yaml
pi:
  retry:
    provider:
      timeoutMs: 45000
      maxRetries: 2
      maxRetryDelayMs: 15000
```

## Agent configuration

```yaml
agents:
  default:
    model: opencode-go/glm-5.1
    skills: [cli-testing]
    thinkingLevel: medium
  namespaces:
    review:
      model: opencode-go/minimax-m3
    visual:
      model: opencode-go/kimi-k2.7-code
    task:
      model: opencode-go/kimi-k2.7-code
  overrides:
    task/docs-updater:
      run:
        prompt: "Summarize the latest API changes"
        output: .drs/docs-summary.json
        json: true
```

Resolution order for an agent model:

1. CLI `--model` / per-agent env var.
2. `agents.overrides.<id>.model`.
3. `agents.namespaces.<namespace>.model`.
4. `agents.default.model`.

The `run` override can supply a prompt, prompt file, output path, and JSON mode.

## Review configuration

```yaml
review:
  agents:
    - review/unified-reviewer
  ignorePatterns:
    - "*.test.ts"
    - "*.spec.ts"
    - "package-lock.json"
  describe:
    enabled: true
  cursorFixLinks:
    enabled: false
```

`ignorePatterns` supports `*` and `**` globbing. `describe.enabled` runs the describe pass before review. `cursorFixLinks` adds deep links to the Cursor editor in summary comments.

## Describe configuration

```yaml
describe:
  model: opencode-go/kimi-k2.7-code
  includeProjectContext: true
```

## Context compression

```yaml
contextCompression:
  enabled: true
  thresholdPercent: 0.15
  maxTokens: 32000
  softBufferTokens: 1500
  hardBufferTokens: 1000
  tokenEstimateDivisor: 4
  summaryThresholdMultiplier: 3
```

When `thresholdPercent > 0` and the model context window is known, the budget is `contextWindow * thresholdPercent`. Otherwise `maxTokens` is used. Diff entries are dropped when they exceed the soft/hard limits; above the hard limit multiplied by `summaryThresholdMultiplier`, all inline diffs are replaced with a summary.

## Pricing overrides

```yaml
pricing:
  models:
    opencode-go/glm-5.1:
      input: 0.0
      output: 0.0
      cacheRead: 0.0
      cacheWrite: 0.0
```

Used when the runtime reports zero cost. Values are USD per 1M tokens.

## Fix checks

```yaml
fix:
  checks:
    - name: typecheck
      command: npm run type-check
      matchPaths: ["src/**/*.ts"]
      timeoutMs: 60000
```

These checks become the `drs_check` tool available to the `task/review-issue-fixer` agent.

## Temporal configuration

```yaml
temporal:
  address: localhost:7233
  namespace: default
  taskQueue: drs-workflows
  workflowIdPrefix: drs
  workspace:
    mode: local
    root: /tmp/drs-temporal-workspaces
```

See [Temporal execution](temporal-execution.md) for details.

## Workflow default

```yaml
workflow:
  default: local-changelog-review
```

Allows `drs workflow run` without a name.

## Environment variables

- `GITLAB_TOKEN` / `GITHUB_TOKEN` — platform tokens.
- `GITLAB_URL` — GitLab URL (defaults to `https://gitlab.com`).
- `GITLAB_COMMIT_EMAIL_DOMAIN` — optional private commit email domain for self-managed GitLab creator attribution; defaults to `users.noreply.<instance-host>`.
- `DRS_DEFAULT_MODEL` / `REVIEW_DEFAULT_MODEL` — default model.
- `DRS_AGENT_<NAMESPACE>_<NAME>_MODEL` / `REVIEW_AGENT_*` — per-agent model.
- `REVIEW_UNIFIED_MODEL` — unified reviewer model.
- `REVIEW_THINKING_LEVEL` — default reasoning effort.
- `REVIEW_AGENTS` — comma-separated review agent ids (legacy alias).
- `DRS_RUNTIME_*` — runtime timeout overrides.
- `DRS_TEMPORAL_*` — Temporal overrides.

## Legacy migrations

`src/lib/config.ts` rejects legacy DRS 3.x keys with a clear migration message:

- `review.default` → `agents.default`.
- `review.defaultModel` → `agents.default.model`.
- `review.paths` → `agents.paths`.
- `review.postErrorComment` and `review.describe.postDescription` — removed; posting is now explicit via workflows.
- `opencode` → `pi` (deprecated alias, still merged with a warning).

## See also

- [Pi runtime](pi-runtime.md) for how configuration drives the runtime.
- [Workflow engine](workflow-engine.md) for workflow defaults and overrides.
- [Review workflows](review-workflows.md) for review settings.
- [Temporal execution](temporal-execution.md) for Temporal settings.
