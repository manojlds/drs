# Development Guide

This guide describes local development for DRS on the Pi runtime.

## Prerequisites

- Node.js 20+
- npm
- Git
- Provider API key (for example `ANTHROPIC_API_KEY`)

## Setup

```bash
npm install
npm run build
npm test
```

## Daily Workflow

After every code change, run the full quality gate:

```bash
npm run check:all
```

This runs formatting, linting, TypeScript build, tests, and verification checks.

## Running Commands Locally

```bash
# Review local changes
npm run dev -- review-local

# Review a GitLab merge request
npm run dev -- review-mr --project org/repo --mr 123

# Review a GitHub pull request
npm run dev -- review-pr --owner octocat --repo hello-world --pr 456

# Generate PR/MR descriptions
npm run dev -- describe-pr --owner octocat --repo hello-world --pr 456
npm run dev -- describe-mr --project org/repo --mr 123
```

## Environment Variables

Required (platform/model dependent):

```bash
GITLAB_TOKEN=glpat-xxx
GITHUB_TOKEN=ghp-xxx

ANTHROPIC_API_KEY=sk-ant-xxx
# or OPENAI_API_KEY / ZHIPU_API_KEY etc.
```

Optional runtime endpoint:

```bash
PI_SERVER=http://localhost:3000
# Legacy alias still accepted: OPENCODE_SERVER
```

## Configuration

DRS configuration precedence:

1. `.drs/drs.config.yaml`
2. `.gitlab-review.yml`
3. Environment variables
4. CLI overrides

Useful keys:

```yaml
pi:
  serverUrl: http://localhost:3000 # optional

review:
  agents:
    - security
    - quality
  ignorePatterns:
    - "*.test.ts"
```

## Built-in Agents

Built-in Pi-native agents are stored in:

```text
.pi/agents/review/
```

Project overrides/custom agents:

```text
.drs/agents/<name>/agent.md
```

## Troubleshooting

- **No model available**: verify API keys and model name.
- **Auth failures**: confirm token/API key scopes.
- **No review output**: run with `--debug` to inspect runtime payload wiring.
- **Path errors**: check `review.paths.agents` and `review.paths.skills` values.

## Notes

- Keep changes focused and covered by tests.
- Prefer updating existing tests when behavior changes.
- Do not bypass quality checks.
