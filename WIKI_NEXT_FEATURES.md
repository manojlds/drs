# Repository Wiki Next Features

## Next-session handoff

Baseline: `main` at merge commit `f55211e` (PR #186).

The repository wiki now has:

- Deterministic source and wiki fingerprints in `.drs/wiki-state.json`.
- Model-based `repository-wiki-sync` and model-free `repository-wiki-check` workflows.
- Scheduled default-branch synchronization through one token-backed `drs/wiki-update` pull request.
- An OKF v0.1 canonical bundle under `wiki/` with validation and generated indexes.
- A reusable VitePress site, local search, raw OKF output, `llms.txt`, and a concept graph.
- Model-free `drs wiki search <query...>` with ranked human and JSON results.

This roadmap captures the remaining useful ideas from the OpenWiki comparison. The recommended order prioritizes security and deterministic evidence before adding more model-driven behavior.

## Product principles

1. Keep `wiki/` as the portable canonical artifact. Site and agent features consume it rather than replacing it.
2. Keep freshness, validation, and CI gates deterministic and model-free.
3. Treat repository and wiki content as untrusted at tool, rendering, and terminal boundaries.
4. Keep external/fork workflows read-only and isolate write credentials from model execution.
5. Prefer conceptual learning from OpenWiki. Do not copy framework-specific code unless there is a clear benefit and its MIT notice is retained.

## Priority 1: Scoped wiki mutation and in-run validation

Status: implemented through generic workflow-agent permissions, with the wiki maintainer as the first consumer.

### Goal

Prevent the wiki maintainer from modifying repository files outside the approved bundle before a post-run guard notices the change. Return validation failures to the agent while it can still repair them.

### Implementation outline

1. Add generic agent `permissions` and `validation` fields to workflow nodes and propagate them into Pi sessions.
2. Scope write, edit, and deletion operations with literal roots and root-relative allow/deny patterns.
3. Reject traversal, symbolic links, and writes to generated `index.md` or `.drs/wiki-state.json`.
4. Remove unrestricted shell execution from this agent, or replace it with bounded read-only Git/source evidence tools.
5. Validate changed concepts after each mutation and return actionable OKF errors to the agent.
6. Retain a deterministic before/after workspace postcondition that rejects residual changes outside the same write policy.

### Likely files

- `.pi/agents/task/okf-wiki-maintainer.md`
- `.pi/workflows/repository-wiki-sync.yaml`
- `src/runtime/client.ts`
- `src/pi/sdk.ts`
- `src/lib/okf-wiki.ts`
- `src/cli/workflow.ts`

### Acceptance criteria

- An attempted write outside the configured bundle fails before modifying the file.
- Traversal and symlink targets are rejected.
- The maintainer cannot directly write generated indexes or state.
- Invalid frontmatter is reported during the run and can be corrected by the agent.
- Final workflow guards still reject any unexpected path as defense in depth.
- Unit tests cover allowed writes, denied paths, symlinks, and validation feedback.

### Recommended first branch

`feat/agent-workspace-permissions`

## Priority 2: Persistent repository wiki brief

Status: implemented. `.drs/wiki-instructions.md` is loaded by `repository-wiki-sync` on every run, combined with the one-run `instructions` input (file content first, input appended), and surfaced in `plan-update` JSON output as `instructions`, `instructionsSource`, and `instructionsHash`. The brief is excluded from source fingerprints; `record-wiki-state` persists the brief-only hash, so editing the brief reconciles while one-run inputs never invalidate freshness. The optional `drs init` discovery block (outline item 5) remains unimplemented.

### Goal

Persist repository-specific scope, priorities, exclusions, terminology, and audience so every synchronization uses the same intent.

### Implementation outline

1. Introduce `.drs/wiki-instructions.md` as an optional control file outside the portable bundle.
2. Load it automatically in `repository-wiki-sync`.
3. Treat the existing `instructions` workflow input as a one-run addition or override with explicit precedence.
4. Include the effective instructions hash in state or run output for observability.
5. Optionally add an explicit setup command that inserts a marker-delimited wiki discovery block into `AGENTS.md` or `CLAUDE.md`.

### Likely files

- `.pi/workflows/repository-wiki-sync.yaml`
- `.pi/agents/task/okf-wiki-maintainer.md`
- `src/cli/workflow.ts`
- `src/lib/wiki-delta.ts`
- `src/cli/init.ts`

### Acceptance criteria

- Synchronization works when the file is absent.
- Persistent and one-run instructions combine deterministically.
- Changing the brief invalidates wiki freshness.
- The effective instructions source is visible in JSON workflow output.
- Agent discovery edits are explicit and idempotent, not performed on every synchronization.

## Priority 3: Structured source provenance

Status: implemented. Concepts declare `drs_sources` (repository-relative paths, optional `symbols`); malformed declarations are validation errors while missing cited paths and missing provenance are warnings. `record-wiki-state` persists a `source path -> concept paths` reverse map in `.drs/wiki-state.json`, `plan-wiki-update` returns `candidateConcepts` for update mode, the wiki site renders a Sources panel per concept, and `drs wiki search --json` includes citations.

### Goal

Record which repository evidence supports each concept, render those citations, and use the reverse map to improve incremental updates.

### Proposed format

Use a producer-defined OKF extension such as:

```yaml
drs_sources:
  - path: src/lib/wiki-delta.ts
    symbols: [planWikiUpdate]
  - path: .pi/workflows/repository-wiki-sync.yaml
```

### Implementation outline

1. Parse and validate `drs_sources` without weakening OKF extension support.
2. Require repository-relative paths and reject traversal.
3. Record a `source path -> concept paths` reverse map in `.drs/wiki-state.json`.
4. Preserve compatibility with existing persisted state that lacks the new map.
5. Feed concepts associated with `changedPaths` to the maintainer as update candidates.
6. Render a Sources panel and include provenance in search JSON.
7. Warn about missing source paths and concepts with no provenance, without initially making coverage a hard failure.

### Likely files

- `src/lib/okf-wiki.ts`
- `src/lib/wiki-delta.ts`
- `src/lib/wiki-search.ts`
- `.wiki-site/.vitepress/config.mts`
- `.wiki-site/.vitepress/theme/PageLead.vue`
- `.pi/agents/task/okf-wiki-maintainer.md`

### Acceptance criteria

- Valid provenance survives index synchronization unchanged.
- Invalid or escaping paths are rejected or reported deterministically.
- Existing state files continue to load.
- A changed source path identifies its previously dependent concepts.
- Site and JSON search results expose citations.

## Priority 4: Directed graph semantics and quality checks

### Goal

Preserve the direction of semantic Markdown links and expose useful graph-quality signals.

### Implementation outline

1. Stop sorting link endpoints into undirected pairs in `src/lib/wiki-site-graph.ts`.
2. Render arrowheads and separate incoming from outgoing neighbors.
3. Exclude generated navigation/index links from semantic graph metrics.
4. Add deterministic counts for nodes, directed edges, orphan concepts, and weakly connected concepts.
5. Add warnings to wiki validation or site checks for true orphans.
6. Optionally capture the surrounding sentence as a human-readable relationship explanation.

### Acceptance criteria

- `A -> B` and `B -> A` remain distinct edges.
- Duplicate links in one direction collapse deterministically.
- Graph JSON, rendering, and smoke tests agree on direction.
- Orphan counts exclude reserved documents and generated indexes.
- Existing sites remain keyboard- and mobile-usable.

## Priority 5: Read-only `drs wiki ask`

### Goal

Build an optional grounded question-answering command on top of model-free search without creating a vector database or allowing writes.

### Implementation outline

1. Retrieve top concepts with `searchWiki`.
2. Send only the retrieved concept text and metadata to a read-only Pi session.
3. Require repository-relative concept citations in every answer.
4. Reject citations that were not present in the retrieved set.
5. Support `--limit`, `--model`, and `--json`.
6. Return retrieval metadata and model usage separately from the answer.

### Likely files

- `src/cli/wiki.ts`
- `src/lib/wiki-search.ts`
- A small read-only answer executor under `src/lib/`
- A packaged answer agent under `.pi/agents/task/`

### Acceptance criteria

- Retrieval remains available without a provider key through `drs wiki search`.
- `ask` cannot write files or execute shell commands.
- Answers contain only validated citations from retrieved concepts.
- Unit tests use a mocked runtime; live model tests remain opt-in.

## Priority 6: Wiki run metrics and self-correction

### Goal

Make wiki maintenance quality and cost visible without adopting default telemetry.

### Metrics

- Delta mode and changed-source count.
- Concepts added, edited, and deleted.
- Validation failures and repair attempts.
- Directed nodes, edges, and orphans.
- Provenance coverage once Priority 3 exists.
- Model, token usage, estimated cost, and elapsed time.
- Effective instructions hash.

### Acceptance criteria

- Human and JSON outputs expose the same deterministic structural metrics.
- Detailed prompts and repository content remain only in opt-in traces.
- A no-op run clearly reports that no model was invoked.

## Deferred work

These ideas should wait until a concrete repository-maintenance use case exists:

- External source connectors for issue trackers, chat, email, or personal knowledge.
- OAuth, scheduling, personal memory, or anonymous telemetry.
- Vector databases or hosted retrieval infrastructure.
- GitLab/Bitbucket scheduled wiki update and Pages templates.
- Generic ingestion adapters for linked repositories or generated API catalogs.

DRS already has stronger deterministic state, OKF validation, static publishing, and deployment checks than OpenWiki. Do not replace those systems with OpenWiki's `.last-update.json`, index format, validator, or CI scripts.

## Recommended implementation order

1. Scoped wiki mutation and in-run validation.
2. Persistent repository wiki brief.
3. Structured source provenance and reverse map.
4. Directed graph semantics and graph-quality checks.
5. Read-only `drs wiki ask`.
6. Wiki metrics and self-correction reporting.

Each priority should be a separate PR unless implementation proves very small. Complete the security boundary before adding `wiki ask` or external ingestion.

## Definition of done for every wiki feature

1. Add focused unit and CLI tests, including unsafe path and malformed input cases.
2. Run `npm run check:all`.
3. Run a local `repository-wiki-sync` smoke test when provider credentials are available.
4. Validate and build the canonical wiki bundle on the feature branch.
5. Build the reusable wiki site when bundle or rendering behavior changes.
6. Update `CHANGELOG.md`, user documentation, and canonical wiki concepts. Let the scheduled wiki-update pull request record post-merge `.drs/wiki-state.json` freshness.
7. Push a feature branch, open a PR, and verify Node 22/24 CI plus trusted DRS review.

## Suggested prompt for the next session

```text
Read WIKI_NEXT_FEATURES.md and implement Priority 4 leftovers (arrowhead rendering, incoming/outgoing neighbor separation, relationship explanations) or Priority 5: Read-only `drs wiki ask`. Start from current main, inspect the graph analysis in src/lib/wiki-site-graph.ts and model-free retrieval in src/lib/wiki-search.ts before editing, keep the change minimal, add security-focused tests, update and synchronize the canonical wiki, run npm run check:all, and open a PR.
```
