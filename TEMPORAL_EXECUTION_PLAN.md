# Temporal Execution Mode Plan

## Goal

Add an execution backend that runs existing DRS workflow YAML through Temporal. DRS workflow nodes should run as Temporal activities, while DRS control flow should be interpreted deterministically inside a generic Temporal workflow.

## Core Architecture

DRS workflow YAML remains the source of truth.

```text
DRS YAML DSL -> validated compiled workflow plan -> Temporal workflow interpreter -> node activities
```

Do not generate TypeScript Temporal workflow source for each DRS workflow. Use one generic Temporal workflow implementation, for example `drsWorkflow`, that receives a JSON-serializable compiled plan.

## Design Constraints

- [x] Keep the existing DRS workflow DSL as the source of truth; do not create a second Temporal-specific DSL.
- [x] Keep Temporal workflow code deterministic.
- [x] Put side effects in activities only.
- [x] Run agents, built-in actions, git operations, platform calls, file writes, artifact operations, and Pi runtime calls as activities.
- [x] Avoid storing large diffs, review outputs, or model responses directly in Temporal history.
- [ ] Treat side-effecting activities as retryable only after idempotency behavior is explicit.

## Temporal Workflow Responsibilities

- Dependency scheduling.
- Wave and segment execution.
- `if` condition evaluation.
- Template rendering required for orchestration decisions.
- `loop`, `switch`, `passThrough`, and `end` control nodes.
- Loop state and `maxIterations` enforcement.
- Activity scheduling and retry policy assignment.
- Result assembly matching current `WorkflowRunResult`.

## Temporal Activity Responsibilities

- `agent` nodes.
- `agentsFrom` nodes.
- Built-in `action` nodes.
- Git operations.
- GitHub/GitLab API calls.
- File writes.
- Artifact load/save/update operations.
- Review/describe/post actions.
- Pi runtime/model calls.

## Phase 0: Design Spike

- [x] Pick Temporal SDK package/version and supported Node runtime.
- [x] Define `CompiledWorkflowPlan` with normalized nodes, execution order, waves, segments, output key, input metadata, and workflow source metadata.
- [x] Define artifact reference format for large payloads.
- [x] Decide MVP workflow set.
- [x] Document initial non-goals.

Recommended MVP workflows:

- `local-review`
- `github-pr-show-changes`
- `gitlab-mr-show-changes`

Recommended initial exclusions:

- Stacked fix workflows.
- Internal fix loops with git commits/pushes.
- Release workflows.
- PR/MR creation workflows.

Done when: agents can point to a short design note that explains the Temporal architecture, supported workflows, and non-goals.

## Phase 1: Executor Abstraction

- [x] Introduce a `WorkflowExecutor` interface for workflow backends.
- [x] Move the current runner into a `LocalWorkflowExecutor` without behavior changes.
- [x] Extract deterministic planning helpers from `src/cli/workflow.ts`.
- [x] Extract side-effecting node execution behind a `NodeExecutor` boundary.
- [x] Preserve current `drs workflow run` behavior as the default local executor.

Helpers to extract:

- Workflow node normalization.
- Execution order.
- Execution waves.
- Control-flow segments.
- Condition evaluation.
- Template rendering needed by orchestration.

Done when: all existing tests pass and `drs workflow run <name>` is behaviorally unchanged.

## Phase 2: Compiled Workflow Plan

- [x] Add `compileWorkflowPlan(config, workflowName, options)`.
- [x] Ensure the compiled plan is JSON-serializable and does not embed process-local objects, clients, or functions.
- [x] Include enough data for Temporal workflow code to schedule nodes without loading repo config again.
- [x] Add tests for plan stability across packaged and project workflows.
- [ ] Consider exposing plan metadata through `drs workflow show --json` or `drs workflow validate --json`.

Done when: local execution can optionally run from `CompiledWorkflowPlan`, and plan tests cover DAG-only and control-flow workflows.

## Phase 3: Temporal MVP Runner

- [x] Add Temporal dependencies behind the Temporal executor path.
- [x] Add `drs temporal worker` command.
- [x] Register one generic Temporal workflow, for example `drsWorkflow`.
- [x] Register `runWorkflowNodeActivity`.
- [x] Add CLI option: `drs workflow run <name> --executor temporal`.
- [x] Support wait-for-result mode by default.
- [x] Add `--no-wait` for async dispatch.

Proposed config fields:

```yaml
temporal:
  address: localhost:7233
  namespace: default
  taskQueue: drs-workflows
  workflowIdPrefix: drs
```

Done when: a read-only workflow runs end-to-end through Temporal and returns the same top-level `WorkflowRunResult` shape as local mode.

## Phase 4: Artifact Store

- [x] Add `WorkflowArtifactStore` abstraction.
- [x] Add local filesystem store for development under `.drs/artifacts/temporal/<workflowId>/...`.
- [ ] Add an object-store design for CI/production, preferably S3-compatible.
- [x] Add an inline-size threshold so small artifacts can remain in Temporal history and large artifacts become refs.
- [x] Hydrate artifact refs when template rendering needs artifact content.
- [x] Persist enough metadata to verify artifact integrity with `sha256`.

Suggested ref shape:

```ts
type TemporalArtifactRef = {
  kind: 'artifact-ref';
  key: string;
  uri: string;
  contentType?: string;
  sizeBytes?: number;
  sha256?: string;
};
```

Done when: large git-range diffs and review outputs no longer bloat Temporal history, and resumed workflows can still read prior artifacts.

## Phase 5: Control-Flow Support

- [x] Implement `loop` in Temporal workflow code using existing bounded `maxIterations` semantics.
- [x] Implement `switch` as deterministic forward routing.
- [x] Implement `passThrough` as deterministic forward routing.
- [x] Implement `end` as deterministic workflow termination.
- [x] Preserve inactive-branch skipped-node results.
- [x] Add tests for branch skipping, loop iteration state, `onMaxIterations`, and forward-only router validation.

Done when: workflows with DRS control nodes execute correctly in Temporal with the same results as local mode for equivalent mocked node outputs.

## Phase 6: Idempotent Side Effects And Retry Policy

- [ ] Add activity idempotency context.
- [ ] Define retry policies per node/action kind.
- [ ] Audit side-effecting actions for retry safety.
- [ ] Make comment-posting actions marker/fingerprint based so retries update or reuse comments instead of duplicating them.
- [ ] Make change-request creation reuse existing branches/PRs/MRs on retry.
- [ ] Define safe behavior for git commits created before an activity failure.
- [ ] Add retry-after-side-effect tests.

Activity idempotency context:

```ts
type ActivityIdempotencyContext = {
  workflowId: string;
  runId: string;
  nodeId: string;
  attempt: number;
  idempotencyKey: string;
};
```

Actions requiring explicit audit:

- `write`
- `git-add`
- `git-commit`
- `git-push`
- `post-comment`
- `post-review-comments`
- `post-fix-status`
- `create-change-request`
- `create-pr`
- `create-mr`

Done when: Temporal retries cannot duplicate comments, commits, PRs, or MRs for supported workflows.

## Phase 7: Production Hardening

- [ ] Add worker deployment docs.
- [ ] Add Temporal UI troubleshooting docs.
- [ ] Add workflow queries for current node status, loop state, and artifact refs.
- [ ] Add cancellation handling.
- [ ] Integrate Temporal execution with existing DRS trace artifacts.
- [ ] Add structured logs that include workflow id, run id, node id, and activity attempt.
- [ ] Add CI coverage with a local Temporal test server if feasible.

Done when: Temporal mode is documented, inspectable, and safe enough for real repository workflows.

## Suggested Release Path

- [ ] `4.1.0`: executor abstraction and compiled plan, no Temporal runtime required.
- [ ] `4.2.0`: experimental Temporal runner for read-only workflows.
- [ ] `4.3.0`: artifact store and control-flow support.
- [ ] `4.4.0`: side-effecting workflow support with idempotency hardening.
- [ ] Later: mark Temporal executor stable.

## Agent Handoff Notes

- Start by refactoring, not by adding Temporal. The first useful PR should make the local executor cleaner with no behavior change.
- Keep Temporal workflow code deterministic. Do not call git, filesystem, HTTP, model providers, or `Date.now()` directly from Temporal workflow code.
- Reuse existing DRS validation. Temporal mode should reject the same invalid workflow files as local mode.
- Keep the Temporal workflow generic. DRS workflow YAML should compile to data, not generated source code.
- Do not enable stacked fix workflows in Temporal until side-effect idempotency tests exist.
