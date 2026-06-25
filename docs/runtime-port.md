# Runtime Port — Workflow DSL on Durable Engines

## Goal

Let packaged `.pi/workflows/*.yaml` definitions ship with the DSL unchanged, but
execute on either the current in-process wave scheduler **or** an external
durable execution engine (Temporal, Restate, WorkflowKit, etc.). The YAML is the
source of truth; the runtime is a swappable backend.

## Why now

Today `runWorkflow` lives in `src/cli/workflow.ts` as a single procedural pass
that mixes DAG scheduling, template rendering, action execution, and artifact
persistence. Any of these is reasonable to run on a worker, but **scheduling
+ state machine** is the part that benefits most from a durable runtime
(long-running review loops, retries, audit, multi-day fix flows).

## Non-goals

- Reimplementing the action vocabulary. Git, review, comment-posting, and
  artifact work stay in DRS.
- Breaking existing authored workflows. Round-trip a YAML through both runtimes
  must produce identical `WorkflowRunResult` for any deterministic action.
- Hiding the runtime choice from power users. A user can explicitly target a
  remote runtime per-workflow.

## Boundary

| Layer | Stays in DRS | Goes to runtime |
|-------|--------------|------------------|
| YAML parsing + validation | yes | — |
| `WorkflowNodeConfig` schema | yes | — |
| `runAgent` (Pi runtime, model calls) | yes | — |
| `runGit*`, `runReview*`, `runPost*` actions | yes (file/network IO) | — |
| Artifact persistence (`.drs/artifacts/`) | yes (local FS) | — |
| **Cycle detection** (`getWorkflowExecutionOrder`) | — | yes |
| **Wave / step scheduling** | — | yes |
| **Control evaluation** (`if`, `loop`, `switch`, `passThrough`, `end`) | — | yes |
| **Template binding** (`{{inputs.x}}`, `{{nodes.id.…}}`, `{{artifacts.x}}`) | DRS-owned lexing | runtime dispatches |

DRS stays a **worker**: when the runtime says "execute node X", DRS runs the
declared action locally and returns a serialised `WorkflowNodeResult`.

## Interface sketch (boundary only)

```ts
type RemoteRuntimeOptions = {
  /** Target cluster. Examples: `temporal`: namespace + task queue; `workflowkit`: API URL. */
  backend: 'temporal' | 'workflowkit' | 'in-process';
  endpoint?: string;
  identity?: string;
};

interface WorkflowRuntime {
  /** Compile a workflow into the runtime's internal representation and return an opaque RunID. */
  start(
    workflowId: string,
    definition: WorkflowConfig,
    inputs: Record<string, string>,
  ): Promise<string /* RunId */>;

  /** Called by the DRS worker when an action node finishes; persists result, lets runtime evaluate next. */
  signal(
    runId: string,
    nodeId: string,
    result: WorkflowNodeResult,
  ): Promise<void>;

  /** Await a specific node's result (used by templates like {{artifacts.x}}). */
  awaitNode(
    runId: string,
    nodeId: string,
  ): Promise<WorkflowNodeResult>;

  /** Block until the workflow's `control: end` node fires. */
  awaitEnd(
    runId: string,
  ): Promise<WorkflowRunResult>;

  /** Optional for partial reruns / signal-from-outside. */
  cancel?(runId: string, reason?: string): Promise<void>;
}
```

Concretely for **Temporal**:

- `start` → `client.start(workflow, ...)`; the temporal workflow body
  re-implements `getWorkflowExecutionWaves` as a list of activity timers per
  wave.
- `signal` → a Temporal signal channel `node-result(nodeId, json-encoded result)`.
- `awaitNode` → a Temporal query.
- `awaitEnd` → `await client.result(runId)`.

A `BackwardCompatRuntime` wraps the existing in-process wave executor to keep
`runWorkflow` callers working without a remote cluster. Today: the in-process
executor is the only backend. Once the interface exists, swapping is
mechanical.

## Recommended path

1. Introduce `WorkflowRuntime` in `src/runtime/` with the `BackwardCompatRuntime`
   being the existing engine behind it.
2. Port one packaged workflow (the longest fix loop) to Temporal as a
   reference.
3. Add a `runtime:` input field to every workflow YAML; when absent, default
   to `in-process`.
4. Document the boundary in this file.

## Tradeoffs considered

| Option | Pro | Con |
|--------|-----|-----|
| **Plain interface (above)** | Smallest contract, runtime-agnostic | Re-implementing waves per backend |
| **Reuse Temporal Workflow primitives directly** | Native retry/timers/serde | Couples DSL to one backend |
| **Full re-implementation of waves on Temporal** | Pure port | High effort, ~3 months, leaky abstractions |

The **plain interface** wins because it preserves the option to swap to other
durable engines later (Restate, WorkflowKit, AWS Step Functions) and gives us a
clean seam to push the smallest possible change today.

## Status — 2026-06-21

- ✅ New control kind `passThrough` lands the discipline that any future
  cross-runtime control evaluation will need: a control node that **only**
  claims a DAG slot is now first-class.
- ⏳ Interface + `BackwardCompatRuntime` follow-up PR.
- ⏳ Reference Temporal port follow-up PR.
