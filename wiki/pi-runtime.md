---
type: Architecture
title: Pi runtime and agents
description: How DRS runs the Pi SDK in-process, discovers agents, resolves models, attaches skills, and exposes custom tools.
tags: [runtime, pi, agents, models, skills]
---

# Pi runtime and agents

DRS uses the Pi SDK (`@earendil-works/pi-coding-agent`) as its sole agent runtime. By default, the SDK runs in-process inside the CLI. The `RuntimeClient` in `src/runtime/client.ts` wraps it and exposes a session-based API used by the [workflow engine](workflow-engine.md) and the `run-agent` command.

## In-process runtime

`src/runtime/client.ts` builds a runtime configuration record, then calls `createPiInProcessServer` in `src/pi/sdk.ts`. The returned server advertises `server.url: 'pi://in-process'` and a client that implements the session API.

The runtime configuration is built from the DRS config and includes:

- **Tools** (`src/runtime/client.ts` and `src/pi/sdk.ts`): a fixed allowlist of `Read`, `Glob`, `Grep`, `Bash`, `write_json_output`, and optionally `Write`, `Edit`, `skill`, `git_diff`, `read_artifact`, `drs_check`, and `write_artifact_output` when enabled per agent.
- **Agent entries** (`src/runtime/client.ts`): one entry per loaded agent with resolved `model`, `prompt`, `description`, `color`, and `tools`.
- **Custom providers** (`src/runtime/client.ts`, `src/pi/sdk.ts`): `pi.provider.*` entries from `drs.config.yaml` are registered with the Pi `ModelRegistry`.
- **Model overrides** (`src/runtime/client.ts`): per-agent model overrides from `agents.overrides.<id>.model`, `agents.namespaces.<namespace>.model`, environment variables, and review-specific overrides.
- **Skills** (`src/runtime/client.ts`): per-agent skill lists resolved by `src/lib/config.ts` and attached to the runtime as `agentSkills`.
- **Fix checks** (`src/pi/sdk.ts`): `fix.checks` become the `drs_check` tool, filtered by `matchPaths` against changed files.
- **Trace collector** (`src/runtime/client.ts`): when `--trace` is enabled, traces are attached to sessions and persisted as workflow artifacts.
- **Agent permissions** (`src/lib/agent-permissions.ts`): optional workflow-node policies become Pi tool definitions with runtime-enforced filesystem roots, allow/deny patterns, symbolic-link rejection, and shell isolation.

## Agent loading

`src/runtime/agent-loader.ts` discovers agent Markdown files:

1. Project overrides: `.drs/agents/<namespace>/<name>/agent.md`.
2. Packaged built-ins: `.pi/agents/<namespace>/<name>.md`.

The first definition wins, so projects can override a packaged agent without replacing the whole file. A project can also add context without overriding the agent prompt by placing a `context.md` next to `agent.md`. Global project context is loaded from `.drs/context.md` and injected into every agent prompt.

An agent id is always fully qualified: `<namespace>/<name>`. The built-in review agent is `review/unified-reviewer`. Other namespaces include `task`, `describe`, and `visual`.

## Model resolution

`src/lib/config.ts` resolves the effective model for an agent using this precedence:

1. Explicit model from the CLI (`--model`).
2. Environment variable `DRS_AGENT_<NAMESPACE>_<NAME>_MODEL` or the legacy `REVIEW_AGENT_*` form.
3. `agents.overrides.<id>.model`.
4. `agents.namespaces.<namespace>.model`.
5. `agents.default.model` (or `DRS_DEFAULT_MODEL`).

For the unified reviewer, `review.unified.model` and `REVIEW_UNIFIED_MODEL` take precedence. For the describer, `describe.model` or `DESCRIBE_MODEL` is checked first.

## Skills

Skills are Markdown files in `SKILL.md` format. DRS searches for them in `agents.paths.skills` if configured, otherwise in `.drs/skills`, `.agents/skills`, and `.pi/skills` (in that order). The same skill name in an earlier path wins.

Agents declare skills in their frontmatter or in the config under `agents.default.skills`, `agents.namespaces.<namespace>.skills`, or `agents.overrides.<id>.skills`. The Pi runtime loads the skill content via the `read` tool and injects it into the agent context.

## Custom tools

`src/pi/sdk.ts` registers custom `ToolDefinition` objects that are not part of the base Pi SDK:

- `write_json_output` — always enabled; validates and writes a JSON describe-output artifact.
- `write_artifact_output` — enabled per-agent when `tools.write_artifact_output` is true; writes a self-contained HTML artifact.
- `git_diff` — enabled per-agent when `tools.git_diff` is true; returns a capped git diff for a single file.
- `read_artifact` — enabled per-agent when `tools.read_artifact` is true; returns a review artifact manifest or a specific finding.
- `drs_check` — enabled when `fix.checks` is configured; runs the matching validation commands.

These tools are how the review agent emits structured output and how the fix agent reads and verifies review artifacts.

When an agent workflow node declares filesystem permissions, `src/pi/sdk.ts` supplies same-name policy-aware definitions for Pi's built-in `read`, `write`, and `edit` tools plus a scoped `delete_file` tool. Pi natively limits tools by name but does not expose path allowlists, so DRS uses Pi's pluggable tool operations to enforce paths inside tool execution. DRS custom tools use the same authorizer, and unrestricted shell/check tools are removed from scoped sessions. Restricted reads also remove aggregate `grep`, `find`, `ls`, and `git_diff` tools rather than risk traversing or exposing a denied descendant.

## Session lifecycle

`RuntimeClient` exposes:

- `createSession` — creates a session and sends the initial prompt.
- `streamMessages` — polls the Pi session until the last assistant message is marked complete.
- `waitForCompletion` — collects all messages into an array.
- `closeSession` — disposes the session.
- `shutdown` — closes the in-process server.

Timeouts are controlled by `pi.runtime.operationTimeoutMs`, `pi.runtime.streamTimeoutMs`, and `pi.runtime.streamPollIntervalMs`, with environment overrides (`DRS_RUNTIME_*`).

## Cost reporting

When the runtime reports usage, `src/runtime/client.ts` uses `pricing.models.<model>` as a fallback if the runtime cost is zero. Prices are in USD per 1M tokens.

## See also

- [Architecture](architecture.md) for the system context.
- [Configuration](configuration.md) for model and runtime settings.
- [Workflow engine](workflow-engine.md) for how agents are invoked from workflows.
- [Review workflows](review-workflows.md) for the review agent pipeline.
