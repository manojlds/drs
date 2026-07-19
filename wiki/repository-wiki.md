---
type: Workflow
title: Repository wiki
description: Generate and maintain an OKF v0.1 repository wiki bundle with deterministic delta fingerprints, model-free checks, and CI validation.
tags: [wiki, okf, documentation, maintenance, ci]
---

# Repository wiki

DRS can generate and maintain a portable [Open Knowledge Format (OKF) v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) repository wiki under `wiki/` (or any configured subdirectory). The wiki is composed of Markdown concept pages with YAML frontmatter, deterministic directory indexes, and a state file that tracks source and content fingerprints.

## Workflows

Two packaged workflows manage the wiki:

| Workflow | Purpose |
|----------|---------|
| `repository-wiki-sync` | Generate, reconcile, or update the wiki bundle and record state. |
| `repository-wiki-check` | Verify delta state and OKF v0.1 conformance without invoking a model. |

Run the sync workflow locally:

```bash
# Generate or update wiki/
drs workflow run repository-wiki-sync

# Use a different bundle root
drs workflow run repository-wiki-sync --input root=docs/wiki

# Add project-specific guidance for the maintainer agent
drs workflow run repository-wiki-sync --input instructions="Focus on public APIs."

# Use a different state path outside the bundle
drs workflow run repository-wiki-sync --input root=docs/wiki --input statePath=.drs/docs-wiki-state.json

# Fail if the workflow produces uncommitted changes
drs workflow run repository-wiki-sync --input check=true
```

Run the model-free check:

```bash
# Verify the wiki is current and valid
drs workflow run repository-wiki-check
```

The sync workflow runs the `task/okf-wiki-maintainer` agent only when the delta plan decides work is needed. If both source and wiki content match the recorded state, the agent node is skipped and the current bundle is validated instead.

## Deterministic delta fingerprints

The delta planner in `src/lib/wiki-delta.ts` fingerprints the repository and the wiki bundle so DRS can decide whether the wiki needs to be regenerated, reconciled, updated, or left unchanged.

- `sourceHash` — SHA-256 over tracked and non-ignored untracked files outside the bundle and state file. The hash includes file paths, content, symlink targets, and executable mode, so renames, deletions, and mode changes are detected. Because the bundle and state path are excluded, the fingerprint stays stable when source, wiki, and state are committed together.
- `wikiHash` — SHA-256 over the bundle directory contents.
- `gitHead` — the current `HEAD` commit at the time state is recorded.
- `changedPaths` — the exact paths whose per-path source fingerprints changed. State created before the manifest was introduced falls back to the recorded `gitHead`, working-tree changes, and untracked files.

The planner returns one of four modes:

| Mode | Trigger | Behavior |
|------|---------|----------|
| `generate` | The bundle does not exist. | Create the initial wiki. |
| `reconcile` | The state file is missing/invalid, the bundle root changed, or the wiki content changed without a state update. | Repair state or bundle drift. |
| `update` | The `sourceHash` differs from the recorded state. | Edit directly affected concepts based on `changedPaths`. |
| `noop` | Both source and wiki content match the recorded state. | Skip the agent and validate the current bundle. |

The `changedPaths` list is capped at 500 entries and is the primary scope for update mode. The agent is expected to map each source change to the affected wiki concepts rather than rewriting the whole bundle.

## State file

The state file `.drs/wiki-state.json` is kept outside the bundle so it does not pollute the portable OKF content. It records:

```json
{
  "version": 1,
  "okfVersion": "0.1",
  "root": "wiki",
  "gitHead": "<commit>",
  "sourceHash": "<sha256>",
  "sourceFiles": {
    "src/example.ts": "<sha256>"
  },
  "wikiHash": "<sha256>",
  "updatedAt": "<ISO 8601>"
}
```

The `record-wiki-state` action writes this atomically after a successful sync. Missing tracked paths are omitted from the manifest, so deletions and renames remain stable after they are committed. Clean Git submodules use their checked-out commit as a canonical fingerprint that also works in CI when submodules are not initialized. Planning detects dirty submodules, but they must be committed before state can be recorded. Symbolic links in bundle or state ancestors are rejected. The `.gitignore` keeps most of `.drs/` ignored but explicitly tracks `.drs/wiki-state.json`, so the state is committed with the source it describes. The wiki bundle itself is committed alongside the source unless the project chooses to ignore it.

The `check-wiki-clean` action fails when the bundle or state file has tracked, untracked, or ignored working-tree changes. `repository-wiki-sync --input check=true` uses it to catch generated output that has not been committed.

## OKF bundle structure

Every Markdown file inside the bundle root is either a concept or a reserved file:

- **Concepts** — any `*.md` other than `index.md` and `log.md`. They must start with parseable YAML frontmatter containing a non-empty `type` field. Optional fields include `title`, `description`, `resource`, `tags`, and `timestamp`. Producer-defined fields are allowed.
- **`index.md`** — generated directory indexes. Only the bundle-root `index.md` may contain frontmatter declaring `okf_version: "0.1"`.
- **`log.md`** — optional human-authored update log with `## YYYY-MM-DD` headings and no frontmatter.

Internal links between concepts use standard Markdown links. Broken links are reported as warnings, not errors, because OKF consumers must tolerate them.

## Index synchronization

The `sync-okf-indexes` action in `src/lib/okf-wiki.ts` generates stable progressive-disclosure indexes for every non-empty bundle directory. It writes an `index.md` only when the generated content differs from the existing file, so repeated runs are idempotent.

## Validation

The `validate-okf-wiki` action checks conformance without modifying the bundle:

- Required frontmatter and non-empty `type` on every concept.
- Reserved file rules (`index.md` and `log.md`).
- Valid date headings in `log.md`.
- Unsafe bundle roots and symbolic links are rejected.
- Internal links are validated and broken links are reported as warnings.

The `repository-wiki-check` workflow combines `check-wiki-state` with `validate-okf-wiki`. It throws if the wiki is stale, so it can be used as a CI gate without requiring a model provider.

## CI integration

`.github/workflows/ci.yml` runs the model-free check after tests and build:

```yaml
- name: Check repository wiki delta
  run: node dist/cli/index.js workflow run repository-wiki-check --executor local --json
```

This ensures the wiki is up to date and OKF-conformant on every pull request.

`.github/workflows/pr-review.yml` also synchronizes the wiki for trusted contributors: after a successful review, it runs `repository-wiki-sync` and commits only `wiki/` and `.drs/wiki-state.json` changes back to the PR branch. The patch is guarded so non-wiki changes are rejected, and the push uses `force-with-lease` against the reviewed head to avoid overwriting concurrent updates.

## Human-readable website

The canonical `wiki/` bundle is also the source for a VitePress website. DRS packages the adapter and theme under `.wiki-site/`, outside the bundle, so publishing concerns do not alter portable OKF content and other repositories can use the same renderer.

```bash
drs wiki build --source wiki --output .drs/wiki-site
drs wiki serve --source wiki
drs wiki check-site https://example.github.io/project/
```

`drs wiki build` accepts `--base`, `--site-url`, `--repository owner/name`, and `--title` for hosted output. `drs wiki serve` starts the same packaged adapter as a local development server. `drs wiki check-site` retries while a deployment propagates, then crawls sitemap pages and same-origin assets and verifies the graph, local search marker, raw OKF index, and `llms.txt`.

The adapter scans concept frontmatter to generate type-grouped navigation and displays `type`, `description`, tags, resources, and timestamps as concept metadata. It uses `quickstart.md` as the start concept when present, falls back to the first concept otherwise, and treats `log.md` as optional. It escapes DRS workflow template expressions such as `{{artifacts.change}}` during rendering without modifying their source Markdown.

The publishing boundary treats bundle content as untrusted. Build and serve commands validate the source bundle and reject symbolic-link source/output escapes. Rendering disables raw HTML, executable page frontmatter, file include/snippet directives, non-HTTP resource links, and local image imports so wiki content cannot read runner files or inject executable markup into the published origin. Overlapping in-process builds and servers are rejected to keep their temporary VitePress configuration isolated.

Every build also emits:

- A local full-text search index and `sitemap.xml` for human discovery.
- An interactive `graph.html` generated from internal Markdown links between concepts.
- `llms.txt` with concept summaries and public URLs.
- An unchanged copy of the canonical bundle under `/okf/` for agents and downloads.

Pull-request CI builds the site without deploying it. `.github/workflows/wiki-pages.yml` validates the wiki, derives its canonical URL and base path from GitHub Pages, publishes `.wiki-site/dist` after relevant changes merge to `main`, and runs the deployed-site smoke check. Generated `.wiki-site/dist` content is excluded from the reusable npm package.

## Agent and skills

The bundled agent `task/okf-wiki-maintainer` (`.pi/agents/task/okf-wiki-maintainer.md`) edits concept pages in place based on the deterministic delta plan. It is invoked only when the planner returns `shouldRun: true`.

Run the writing workflow with the local executor. The maintainer edits a dynamic file tree directly, so its agent node does not declare a fixed `writes` path and is not yet protected from Temporal activity retries. The model-free `repository-wiki-check` workflow is safe for normal PR CI.

## Tests

Wiki behavior is covered by:

- `src/lib/okf-wiki.test.ts` — index synchronization and validation.
- `src/lib/wiki-delta.test.ts` — delta planning, fingerprinting, state recording, and clean checks.
- `src/lib/wiki-site*.test.ts` — graph extraction, publishing safety, reusable build/serve setup, and deployed-site smoke checks.
- `src/cli/workflow.test.ts` — end-to-end `repository-wiki-sync` and `repository-wiki-check` workflow runs.
- `src/temporal/retry-policy.test.ts` — Temporal retry classification for wiki actions (`sync-okf-indexes` and `record-wiki-state` are no-retry; `plan-wiki-update`, `validate-okf-wiki`, `check-wiki-state`, and `check-wiki-clean` are retryable).

## See also

- [Maintenance workflows](maintenance-workflows.md) for other repository upkeep workflows.
- [Workflow engine](workflow-engine.md) for the actions and scheduling used by the wiki workflows.
- [Testing](testing.md) for the test suite and quality gate.
- [Temporal execution](temporal-execution.md) for retry policy details.
