---
type: Architecture
title: Workflow engine
description: How DRS compiles, validates, schedules, and executes YAML workflows, including built-in actions and control nodes.
tags: [workflow, engine, planning, execution, temporal]
---

# Workflow engine

Workflows are the central abstraction in DRS. A workflow YAML file defines a dependency graph of agents and built-in actions. The engine validates the graph, compiles it into a deterministic plan, and executes it either locally or through Temporal.

## Workflow definition

Workflows are YAML files. Packaged workflows live in `.pi/workflows/*.yaml`. Project workflows (or overrides) live in `.drs/workflows/*.yaml`. Each workflow file defines exactly one workflow. A `name` field is optional; if omitted, the filename is used.

A workflow has:

- `inputs` — typed inputs, optional defaults, file inputs, or shorthand strings.
- `nodes` — a map of node ids to node definitions.
- `output` — an artifact key to expose as the workflow result (defaults to the last node output).
- `metadata` — optional tags and review metadata.

Every node must define exactly one execution type:

- `agent` — run a single agent by id.
- `agentsFrom` — run a configured list, currently only `review.agents`.
- `action` — run a built-in action.
- `control` — route execution with `loop`, `switch`, `passThrough`, or `end`.

Common node fields include `needs`, `if`, `input`, `output`, `writes`, and `json`. Action nodes use `with` for action-specific options.

## Validation and compilation

`src/lib/config.ts` loads workflow files and validates that every `action` value belongs to the canonical `SUPPORTED_WORKFLOW_ACTIONS` tuple. If an action is unknown, it throws with a Levenshtein-based "did you mean" hint.

`src/lib/workflow/planning.ts` validates the graph:

- Each node must have exactly one of `agent`, `agentsFrom`, `action`, or `control`.
- `needs` references must resolve to known nodes.
- There must be no dependency cycles.
- Control targets (`target`, `exit`, `cases`, `default`) must reference existing nodes.
- `switch` and `passThrough` cannot jump backward; only `loop` can repeat.
- Each action has an allowed `with` option set.

`src/lib/workflow/compiled-plan.ts` produces a `CompiledWorkflowPlan` with schema version 1, execution order, parallel waves, and control segments. The plan is JSON-serializable so the Temporal backend can receive the same workflow definition without re-reading files.

## Execution

The local executor is `LocalWorkflowExecutor` in `src/cli/workflow.ts`. It resolves inputs, builds the template context (`inputs`, `nodes`, `artifacts`, `loop`), and walks the execution plan:

1. DAG segments run in parallel waves based on `needs`.
2. A node is skipped if any dependency was skipped or if its `if` condition evaluates to false.
3. Agent nodes call `runAgent` (`src/cli/run-agent.ts`) after rendering the prompt template.
4. Action nodes dispatch to action runners in `src/cli/workflow.ts`.
5. Control nodes route to the next segment; `loop` repeats until its condition is false or `maxIterations` is reached.
6. Outputs are stored as artifacts for later nodes to reference.

Template references use `{{...}}` syntax:

- `{{inputs.diff}}` — workflow input.
- `{{nodes.summarize.response}}` — raw response from a previous node.
- `{{artifacts.summary}}` — artifact produced by a previous node.

## Control nodes

- `loop` — repeats a target node while `if` is true, bounded by `maxIterations`. It tracks state in `context.loop`.
- `switch` — branches on a rendered value using `cases` and `default`.
- `passThrough` — unconditionally forwards to `target`.
- `end` — terminates the workflow.

## Built-in actions

The full list of actions is in `src/lib/config.ts` (`SUPPORTED_WORKFLOW_ACTIONS`). Important categories include:

- **Change sources**: `change-source` with types `local`, `git-range`, `github-pr`, `gitlab-mr`, and `fix-verification`.
- **Review**: `review`, `review-context`, `review-threshold`, `verify-fix`, `create-review-artifact`, `review-artifact-status`, `review-artifact-add-finding`, `review-artifact-update-findings`, `review-artifact-promote-finding`, `review-artifact-resolve-finding`.
- **Describe / post**: `describe`, `post-comment`, `post-review-comments`, `post-fix-status`, `code-quality-report`.
- **Wiki / OKF**: `plan-wiki-update`, `sync-okf-indexes`, `validate-okf-wiki`, `record-wiki-state`, `check-wiki-state`, `check-wiki-clean`.
- **Git**: `git-diff`, `git-add`, `git-branch`, `git-commit`, `git-push`, `has-diff`, `change-source`, `stack-guard`.
- **Artifacts**: `save-artifact`, `load-artifact`, `artifact-exists`.
- **Change requests**: `create-change-request`, `create-pr`, `create-mr`.
- **Write**: `write`.

## Executors

The `WorkflowExecutor` interface in `src/lib/workflow/executor.ts` has a single `run` method. Two implementations exist:

- `LocalWorkflowExecutor` (`src/cli/workflow.ts`) — runs everything in the CLI process.
- `TemporalWorkflowExecutor` (`src/temporal/executor.ts`) — dispatches a compiled plan to a Temporal worker.

`src/cli/workflow-executor-selection.ts` creates the chosen executor based on the `--executor` flag. Only Temporal supports `--no-wait`.

## CLI commands

- `drs workflow list` — show packaged and project workflows, marking overrides.
- `drs workflow show <name>` — show inputs, nodes, and routes.
- `drs workflow graph <name>` — render the graph as text, JSON, or Mermaid.
- `drs workflow validate [name]` — validate all workflows or one workflow.
- `drs workflow run [name]` — run a workflow or `workflow.default`.

## See also

- [Architecture](architecture.md) for the system context.
- [Review workflows](review-workflows.md) for review-specific actions.
- [Maintenance workflows](maintenance-workflows.md) for changelog and fix flows.
- [Repository wiki](repository-wiki.md) for OKF wiki generation and validation.
- [Temporal execution](temporal-execution.md) for the durable backend.
- [Configuration](configuration.md) for workflow defaults and overrides.
