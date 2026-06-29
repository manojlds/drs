# Temporal Execution

DRS can run workflow YAML through Temporal. The YAML remains the source of truth: DRS compiles it to a JSON plan, the generic Temporal workflow schedules nodes deterministically, and node work runs in activities.

Temporal mode is intended for longer-running repository maintenance workflows where you want durable execution, a worker process, Temporal UI visibility, and retry/cancellation semantics.

## Configuration

Configure Temporal in `.drs/drs.config.yaml` when the defaults do not match your environment:

```yaml
temporal:
  address: localhost:7233
  namespace: default
  taskQueue: drs-workflows
  workflowIdPrefix: drs
```

Defaults are suitable for local development with a Temporal server listening on `localhost:7233`.

## Worker Deployment

Run the worker from the repository where activities should execute:

```bash
drs temporal worker
```

For production-like deployments:

- Build the package before starting the worker: `npm run build`.
- Run one or more worker processes with the same `temporal.taskQueue` configured in project config.
- Set the worker working directory to the repository root so git actions, file writes, artifact paths, and `.env` loading resolve correctly.
- Provide the same environment variables that local DRS runs need, including model provider keys and `GITHUB_TOKEN` or `GITLAB_TOKEN` for platform workflows.
- Keep workers close to the repository filesystem they mutate. Git mutation workflows assume a working tree on local disk.
- Use process supervision from your platform, for example systemd, Kubernetes, Docker Compose, or a CI runner service process.
- Start with read-only workflows before enabling workflows with git pushes, comments, or change-request creation.

Example systemd service shape:

```ini
[Unit]
Description=DRS Temporal worker
After=network-online.target

[Service]
WorkingDirectory=/srv/repos/my-repo
EnvironmentFile=/srv/repos/my-repo/.env
ExecStart=/usr/bin/node /srv/drs/dist/cli/index.js temporal worker --log-format json
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Example container command:

```bash
node dist/cli/index.js temporal worker --log-format json
```

Mount the target repository as the container working directory and provide `.drs/drs.config.yaml`, `.env`, and git credentials through your deployment platform.

## Running Workflows

Start a worker, then dispatch a workflow:

```bash
drs workflow run local-review --executor temporal
drs workflow run github-pr-show-changes --executor temporal --input owner=octocat --input repo=hello-world --input pr=456
```

Use `--no-wait` to dispatch and return immediately:

```bash
drs workflow run local-review --executor temporal --no-wait
```

Use `--trace` to save a Temporal workflow trace artifact after a waited run completes:

```bash
drs workflow run local-review --executor temporal --trace
```

Trace artifacts are written through the normal DRS workflow artifact store under `.drs/artifacts/temporal/<workflow>/trace/`.

## Workflow Queries

DRS registers these Temporal workflow queries:

| Query | Purpose |
|-------|---------|
| `drsWorkflowStatus` | Current node status, running node ids, completed node ids, cancellation flag, workflow id, and run id |
| `drsWorkflowLoopState` | Current loop state for `control: loop` nodes |
| `drsWorkflowArtifacts` | Known artifact keys and external artifact refs |

Example with Temporal CLI:

```bash
temporal workflow query \
  --workflow-id <workflow-id> \
  --type drsWorkflowStatus
```

Use the workflow id printed by `--no-wait` or visible in Temporal UI.

## Temporal UI Troubleshooting

Use Temporal UI to inspect workflow history, pending activities, retries, and cancellations.

Common checks:

- Workflow is stuck in `Running`: confirm a DRS worker is running on the configured task queue.
- Activity is pending: confirm worker logs show polling and the worker process has access to the repository working directory.
- Activity failed with config or token errors: check `.env`, platform tokens, model provider keys, and `.drs/drs.config.yaml` in the worker working directory.
- Activity retries repeatedly: inspect the activity failure in Temporal UI and DRS structured logs. Read-only actions are retryable; unsafe side effects are scheduled with `maximumAttempts: 1`.
- Workflow was cancelled: query `drsWorkflowStatus`; `cancelled` should be `true` and `runningNodeIds` should be empty after cancellation propagates.
- Large output is missing from history: this is expected. Temporal mode offloads large values as artifact refs under `.drs/artifacts/temporal/`.
- Comments or change requests duplicate unexpectedly: verify the workflow uses the built-in posting/change-request actions, which use markers or branch reuse semantics.

Useful worker command while debugging:

```bash
drs temporal worker --debug --log-format json
```

Structured logs include workflow id, run id, node id, activity attempt, action/agent, and duration where available.

## Local Smoke Coverage

Normal `npm test` does not require a Temporal server. To run the opt-in local smoke test, start Temporal locally and run:

```bash
npm run test:temporal:smoke
```

Optional environment variables:

```bash
DRS_TEMPORAL_ADDRESS=localhost:7233
DRS_TEMPORAL_NAMESPACE=default
```

The smoke test starts a real worker with a unique task queue, dispatches a safe local `write` workflow through Temporal, waits for completion, and removes its temporary working directory.

CI systems can use this as a separate job after provisioning a Temporal test server. Keep it separate from the default unit test job so contributors do not need Temporal for normal development.
