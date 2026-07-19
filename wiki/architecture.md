---
type: Architecture
title: DRS architecture
description: High-level system architecture of DRS — CLI, workflow engine, runtime, agents, and platform integrations.
tags: [architecture, overview, runtime, workflow]
---

# DRS architecture

DRS is a Node.js TypeScript CLI that turns YAML workflows into a coordinated sequence of agent calls and built-in actions. The same workflow engine runs locally in-process or dispatches to Temporal, and the same agent definitions are used by every mode.

## High-level layers

```
┌─────────────────────────────────────────┐
│ CLI (src/cli/index.ts)                  │
├─────────────────────────────────────────┤
│ Workflow engine                         │
│ (src/cli/workflow.ts,                   │
│  src/lib/workflow/*.ts)                 │
├─────────────────────────────────────────┤
│ Runtime client                          │
│ (src/runtime/client.ts, src/pi/sdk.ts)  │
├─────────────────────────────────────────┤
│ Agent loader + agents                     │
│ (src/runtime/agent-loader.ts, .pi)      │
├─────────────────────────────────────────┤
│ Platform adapters                       │
│ (src/github/*, src/gitlab/*)            │
└─────────────────────────────────────────┘
```

## CLI layer

`src/cli/index.ts` is the `commander` entry point. It defines five top-level command groups:

- `run-agent` / `run` — run a single agent by fully qualified id (`src/cli/run-agent.ts`).
- `workflow` — list, show, validate, and run workflows (`src/cli/workflow.ts`).
- `temporal` — start a Temporal worker (`src/temporal/worker.ts`).
- `wiki` — search, build, serve, and verify the OKF repository wiki (`src/cli/wiki.ts`).
- `init` / `doctor` — initialize project configuration and check its setup status.

The `wiki` command has subcommands `search`, `build`, `serve`, and `check-site`. `search` performs a deterministic, model-free lookup over the canonical OKF bundle using `src/lib/wiki-search.ts`; `build` and `serve` render the bundle as a VitePress site via `src/lib/wiki-site.ts`; and `check-site` verifies a deployed site.

See [Repository wiki](repository-wiki.md) for OKF bundle generation, the `wiki` subcommands, and CI validation.

The CLI loads `.env` from the working directory (`loadDotenv()`), then loads config via `src/lib/config.ts`.

## Workflow engine

Workflows are the central abstraction. A workflow is a YAML file that declares `inputs`, `nodes`, and an optional `output`. Nodes can be:

- `agent` — call a single agent.
- `agentsFrom` — fan out to a configured agent list, currently `review.agents`.
- `action` — call a built-in action (change source, review, git, post, artifact, etc.).
- `control` — route execution with `loop`, `switch`, `passThrough`, or `end`.

The engine compiles the workflow into a deterministic plan in `src/lib/workflow/compiled-plan.ts`, validates it in `src/lib/workflow/planning.ts`, and executes it. The local executor is `LocalWorkflowExecutor` in `src/cli/workflow.ts`. The Temporal executor implements the same `WorkflowExecutor` interface in `src/temporal/executor.ts`. The dispatch logic is in `src/cli/workflow-executor-selection.ts`.

See [Workflow engine](workflow-engine.md) for the DSL and execution details, and [Temporal execution](temporal-execution.md) for the durable backend.

## Runtime and agents

DRS runs the Pi SDK in-process by default. The `RuntimeClient` in `src/runtime/client.ts` creates a `PiInProcessServer` via `src/pi/sdk.ts`, builds a runtime configuration from the DRS config, loads agents, resolves models, and provides a session API (`createSession`, `streamMessages`, `closeSession`).

Agents are discovered by `src/runtime/agent-loader.ts` from:

1. `.drs/agents/<namespace>/<name>/agent.md` (project overrides).
2. `.pi/agents/<namespace>/<name>.md` (packaged built-ins).

Each agent is a Markdown file with YAML frontmatter containing `description`, `model`, `tools`, and `skills`, followed by the prompt body. The agent id is `<namespace>/<name>`.

See [Pi runtime](pi-runtime.md) for the runtime lifecycle and agent resolution.

## Platform integrations

Platform-specific workflows use `change-source` actions (`src/cli/workflow.ts`) to load GitHub PR or GitLab MR metadata, then pass a `ReviewSource` to the shared review orchestrator. The review orchestrator is `src/lib/review-orchestrator.ts`; it filters files, compresses diffs, and runs the review pipeline from `src/lib/review-core.ts`. Posting is handled by `src/lib/comment-poster.ts` using platform adapters:

- `src/github/client.ts` and `src/github/platform-adapter.ts`.
- `src/gitlab/client.ts` and `src/gitlab/platform-adapter.ts`.

Both adapters implement the `PlatformClient` interface in `src/lib/platform-client.ts`.

See [Integrations](integrations.md) and [Review workflows](review-workflows.md).

## Configuration

Configuration is loaded from `.drs/drs.config.yaml` (and the legacy `.gitlab-review.yml` alias) and merged with environment variables and defaults in `src/lib/config.ts`. It defines the Pi runtime, agent defaults/overrides, review agents, workflow files, Temporal settings, and platform tokens.

See [Configuration](configuration.md).

## Key design choices

- **Workflow-first**: every review, maintenance, and platform task is a workflow. The same DSL runs local diffs, GitHub PRs, GitLab MRs, and custom repository automation.
- **In-process runtime**: no separate service is required. Pi starts inside the CLI process via `src/pi/sdk.ts`.
- **Deterministic planning**: workflows are validated and compiled into a plan with dependency waves and control-flow segments before any node runs.
- **Shared core**: `src/lib/review-orchestrator.ts` and `src/lib/review-core.ts` are reused by every review workflow.
- **Artifact store**: workflow artifacts and review findings are persisted under `.drs/artifacts` by `src/lib/workflow-artifacts.ts` and `src/lib/review-artifact-store.ts`.
