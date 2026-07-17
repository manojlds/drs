---
type: Architecture
title: Temporal execution
description: Durable workflow execution through Temporal, including worker deployment, workspace modes, and queries.
tags: [temporal, durable, worker, executor]
---

# Temporal execution

DRS can run the same YAML workflows through Temporal for durable execution, visibility, retry semantics, and long-running repository maintenance. The workflow YAML remains the source of truth; the engine compiles it to a JSON plan and a generic Temporal workflow schedules the nodes.

## When to use Temporal

Temporal mode is intended for longer-running workflows where you want:

- Durable execution across worker restarts.
- Temporal UI visibility into node status, retries, and cancellation.
- A separate worker process that runs on a repository host.
- Retry and cancellation semantics for long loops or maintenance tasks.

Local in-process execution is the default and is sufficient for most CLI and CI use cases.

## Configuration

Temporal is configured in `.drs/drs.config.yaml` under the `temporal` key:

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

Environment overrides:

- `DRS_TEMPORAL_WORKSPACE_MODE` — `local` or `managed`.
- `DRS_TEMPORAL_WORKSPACE_ROOT` — managed workspace root.
- `DRS_TEMPORAL_WORKSPACE_REPO_URL` and `DRS_TEMPORAL_WORKSPACE_REF` — managed checkout source.

## Worker

Start a worker with:

```bash
npm run build
node dist/cli/index.js temporal worker
```

The worker command is implemented in `src/temporal/worker.ts`. It loads project config, connects to the configured Temporal server, and registers:

- A generic workflow that runs the compiled plan (`src/temporal/workflows.ts`).
- Activities that call the same node execution code used by the local executor (`src/temporal/activities.ts`).

In `local` workspace mode, activities run in the worker's working directory. In `managed` mode, the worker clones/fetches the repository into `<root>/<workflowId>/<runId>/repo` before running activities.

## Running workflows

Dispatch a workflow through Temporal:

```bash
drs workflow run local-review --executor temporal
drs workflow run github-pr-show-changes --executor temporal --input owner=octocat --input repo=hello-world --input pr=456
```

Use `--no-wait` to dispatch and return immediately:

```bash
drs workflow run local-review --executor temporal --no-wait
```

Use `--trace` to save a Temporal workflow trace artifact after the run completes.

The `TemporalWorkflowExecutor` in `src/temporal/executor.ts` implements the same `WorkflowExecutor` interface as the local executor.

## Workflow queries

DRS registers these Temporal workflow queries:

| Query | Purpose |
|-------|---------|
| `drsWorkflowStatus` | Current node status, running node ids, completed node ids, cancellation flag, workflow id, and run id. |
| `drsWorkflowLoopState` | Current loop state for `control: loop` nodes. |
| `drsWorkflowArtifacts` | Known artifact keys and external artifact refs. |

Example:

```bash
temporal workflow query --workflow-id <id> --type drsWorkflowStatus
```

## Safety and retries

- Read-only actions are retryable.
- Unsafe side effects (git pushes, comments, change-request creation) are scheduled with `maximumAttempts: 1`.
- Large values are offloaded to the artifact store under `.drs/artifacts/temporal/`.
- Cancellation is honored: the workflow queries expose `cancelled` and running node ids.

## Smoke testing

Normal `npm test` does not require a Temporal server. The opt-in smoke test runs a real worker with a unique task queue and dispatches a safe `write` workflow:

```bash
npm run test:temporal:smoke
```

Optional overrides:

```bash
DRS_TEMPORAL_ADDRESS=localhost:7233
DRS_TEMPORAL_NAMESPACE=default
```

Keep this as a separate CI job because contributors do not need Temporal for regular development.

## See also

- [Workflow engine](workflow-engine.md) for the compiled plan and executor interface.
- [Architecture](architecture.md) for the overall system.
- [Configuration](configuration.md) for Temporal settings.
