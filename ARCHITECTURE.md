# DRS Architecture

> Note: This document reflects the current Pi-based implementation.

## Overview

DRS (Diff Review System) is a multi-platform code review tool that runs as:

- **CLI** for local diffs
- **CI job** for GitLab merge requests
- **On-demand reviews** for GitLab MRs and GitHub PRs via API

The system uses Pi runtime agents for analysis and a platform-agnostic review pipeline that posts results back to GitLab/GitHub or prints them locally.

## High-level Flow

1. **Collect changed files** from the source (local git diff, GitLab MR, GitHub PR).
2. **Filter files** using ignore/include patterns.
3. **Run review agents** (security/quality/style/performance/documentation).
4. **Parse issues** from agent output.
5. **Summarize and publish** results (terminal, MR/PR comments, or code quality report).

## Core Modules

- `src/lib/unified-review-executor.ts`
  - Platform-agnostic review execution for GitLab/GitHub.
- `src/lib/review-orchestrator.ts`
  - Shared review pipeline used by local diff reviews.
- `src/opencode/client.ts`
  - Internal runtime client wrapper used to talk to Pi SDK.
- `src/opencode/agent-loader.ts`
  - Agent discovery from `.drs/agents` and built-in `.pi/agents`.
- `src/gitlab/platform-adapter.ts`
  - GitLab API adapter implementing the platform client interface.
- `src/github/platform-adapter.ts`
  - GitHub API adapter implementing the platform client interface.
- `src/cli/*`
  - CLI commands (`review-local`, `review-mr`, `review-pr`).
- `src/ci/runner.ts`
  - GitLab CI entrypoint.

## Configuration

Configuration is loaded from defaults, `.drs/drs.config.yaml`, `.gitlab-review.yml`, environment variables, and CLI overrides.

- Agent selection: `review.agents`
- Model overrides: `review.defaultModel` and per-agent overrides
- Runtime endpoint: `pi.serverUrl` (optional; in-process by default)

See `src/lib/config.ts` for details.
