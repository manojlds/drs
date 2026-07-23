---
type: Quickstart
title: DRS repository wiki
description: Entry point for the DRS wiki. Learn what DRS does, how it is organized, and where to find the key concepts.
tags: [quickstart, overview, drs]
drs_sources:
  - path: README.md
  - path: src/cli/index.ts
  - path: package.json
---

# DRS repository wiki

DRS (Diff Review System) is a workflow-first AI code-maintenance tool for GitHub pull requests, GitLab merge requests, local diffs, and agentic repository upkeep. As of version 5.0.0, the published npm package is a CLI application; programmatic imports and deep imports from `dist/` are not a supported API. The CLI runs packaged YAML workflows that compose agents and built-in actions into a dependency graph.

## What this wiki covers

- [Architecture](architecture.md) — how the CLI, workflow engine, runtime, agents, and platform adapters fit together.
- [Pi runtime](pi-runtime.md) — how DRS runs the Pi SDK in-process, loads agents, and resolves models/skills.
- [Workflow engine](workflow-engine.md) — how YAML workflows are compiled, scheduled, and executed locally or through Temporal.
- [Review workflows](review-workflows.md) — how DRS reviews code, persists findings, and posts results to platforms.
- [Maintenance workflows](maintenance-workflows.md) — changelog updates, agent guidance refresh, and fix workflows.
- [Repository wiki](repository-wiki.md) — generate and maintain an OKF v0.1 wiki bundle with deterministic delta checks.
- [Configuration](configuration.md) — `.drs/drs.config.yaml`, environment variables, models, compression, and runtime timeouts.
- [Integrations](integrations.md) — GitHub/GitLab clients and CI/CD wrappers.
- [Temporal execution](temporal-execution.md) — durable workflow execution with a Temporal worker.
- [Testing](testing.md) — unit tests, quality gate, and opt-in smoke coverage.
- [Migration from 4.1 to 5.0](migration.md) — removed commands, CLI-only package, split GitHub review posting, and changed defaults.

## Quick orientation

The CLI entry point is `src/cli/index.ts`. It loads `.env` from the working directory, loads configuration from `.drs/drs.config.yaml`, and dispatches commands through `src/cli/workflow.ts` and `src/cli/run-agent.ts`. The default executor is the local in-process `LocalWorkflowExecutor`, which runs nodes in `src/cli/workflow.ts`. A Temporal backend is available via `src/cli/workflow-executor-selection.ts` and `src/temporal/executor.ts`.

DRS ships packaged workflows in `.pi/workflows/*.yaml` and packaged agents in `.pi/agents/**/*.md`. Project overrides live in `.drs/agents`, `.drs/workflows`, and `.drs/drs.config.yaml`.

## Most common commands

```bash
# Review local unstaged changes
npm run dev:cli -- workflow run local-review

# Review a GitHub PR
npm run dev:cli -- workflow run github-pr-review --input owner=<owner> --input repo=<repo> --input pr=<number>

# Review a GitLab MR
npm run dev:cli -- workflow run gitlab-mr-review --input project=<group>/<repo> --input mr=<number>

# Update CHANGELOG.md from local changes
npm run dev:cli -- workflow run local-changelog-update

# Generate or update the repository wiki (ends with a structural, usage, cost, and elapsed-time summary)
npm run dev:cli -- workflow run repository-wiki-sync

# Check the repository wiki is current (model-free)
npm run dev:cli -- workflow run repository-wiki-check

# Search the repository wiki (model-free)
npm run dev:cli -- wiki search "temporal retry policy" --limit 5

# Build or locally serve the human-readable wiki website
npm run dev:cli -- wiki build --source wiki --output .drs/wiki-site
npm run dev:cli -- wiki serve --source wiki

# Verify a deployed wiki site
npm run dev:cli -- wiki check-site https://example.github.io/project/

# Run a single agent
npm run dev:cli -- run-agent review/unified-reviewer --prompt "Review src/lib/config.ts"
```

After any code change, run the mandatory quality gate:

```bash
npm run check:all
```

## Where to read next

- To understand the execution pipeline, start with [Architecture](architecture.md) and [Workflow engine](workflow-engine.md).
- To customize agents, models, or skills, read [Pi runtime](pi-runtime.md) and [Configuration](configuration.md).
- To add DRS to a CI/CD pipeline, read [Integrations](integrations.md).
- To generate or maintain the repository wiki, read [Repository wiki](repository-wiki.md).
- To upgrade from DRS 4.1, read [Migration from 4.1 to 5.0](migration.md).
