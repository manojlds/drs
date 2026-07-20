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

Common node fields include `needs`, `if`, `input`, `output`, `writes`, and `json`. Agent nodes can also declare runtime-enforced `permissions` and mutation `validation`; action nodes use `with` for action-specific options.

## Agent permissions

Agent workflow nodes can constrain filesystem effects through generic permission rules. Each read, write, or delete rule uses literal repository-relative `roots`, root-relative `allow` glob patterns, and optional `deny` patterns. Denials take precedence, path traversal and symbolic links are rejected, and a filesystem policy requires `shell: false` so shell execution cannot bypass the boundary.

```yaml
nodes:
  maintain-docs:
    agent: task/docs-updater
    permissions:
      filesystem:
        read:
          roots: ['.']
          allow: ['**']
        write:
          roots: [docs]
          allow: ['**/*.md']
          deny: ['**/index.md']
        delete:
          roots: [docs]
          allow: ['**/*.md']
          deny: ['**/index.md']
      shell: false
    validation:
      afterMutation:
        - name: okf-document
          root: '{{inputs.root}}'
    input: Update documentation.
```

`src/lib/agent-permissions.ts` validates and renders policies, authorizes tool paths, and fingerprints tracked and non-ignored untracked files before and after an agent run. [The Pi runtime](pi-runtime.md) installs policy-aware tools under Pi's original tool names, so enforcement occurs before filesystem access. The post-run comparison rejects residual changes outside the same write policy while tolerating source changes that existed before the agent started.

Agent nodes may also configure an `afterMutation` validator. The `okf-document` validator checks proposed concept or log content before writes and returns full bundle validation feedback after a successful write, edit, or deletion. Deterministic workflow actions are outside the agent boundary, so they can safely generate derived files after the agent exits.

Permission rules have important restrictions:

- `permissions` and `validation` are allowed only on `agent` and single-agent nodes, not on `agentsFrom` nodes.
- `agentsFrom` nodes cannot grant filesystem `write` or `delete` permissions; use explicit single-agent nodes when mutation is required.
- A node cannot combine `permissions` with the `writes` field; deterministic `write` action nodes should persist output instead.
- `validation.afterMutation` requires filesystem `write` or `delete` permissions, because validators run inside policy-aware mutation tools.

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

Nodes that can mutate the workspace — actions, agent nodes with a `writes` path, and agent nodes with filesystem `write`/`delete` permissions — are detected by `isPotentialWorkspaceMutation` in `src/lib/workflow/planning.ts`. The local executor serializes such nodes within a wave with a workspace lock, and the [Temporal executor](temporal-execution.md) serializes the whole wave when any runnable node is a potential mutation. This prevents conflicting filesystem edits from running concurrently without requiring every node to declare locks up front.

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

`git-commit` creates a commit from staged changes or from `path`/`paths` that it stages itself. Set `useChangeRequestAuthor: true` to attribute the commit to the creator of a GitHub PR or GitLab MR loaded by a `change-source` action. The source artifact defaults to `change`; override it with `source`. DRS preserves a public creator email when available and otherwise synthesizes a platform no-reply address. Self-managed GitLab instances can override their derived private commit email domain with `GITLAB_COMMIT_EMAIL_DOMAIN`. The action validates the identity and fails before staging if the source has no platform creator context. Repository Git configuration is not modified, and the authenticated token remains the pusher. Disable creator committer attribution when repository push rules require the committer email to belong to the token owner.

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
