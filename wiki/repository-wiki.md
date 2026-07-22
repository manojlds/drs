---
type: Workflow
title: Repository wiki
description: Generate and maintain an OKF v0.1 repository wiki bundle with deterministic delta fingerprints, model-free checks, and CI validation.
tags: [wiki, okf, documentation, maintenance, ci]
drs_sources:
  - path: .pi/agents/task/okf-wiki-maintainer.md
  - path: .pi/workflows/repository-wiki-check.yaml
  - path: .pi/workflows/repository-wiki-sync.yaml
  - path: .github/workflows/wiki-update.yml
  - path: .wiki-site/.vitepress/config.mts
  - path: .wiki-site/.vitepress/theme/PageLead.vue
  - path: src/cli/workflow.ts
  - path: src/lib/okf-wiki.ts
    symbols: [synchronizeOkfIndexes, validateOkfBundle, validateOkfDocument, loadOkfProvenanceMap, parseOkfConceptSources]
  - path: src/lib/wiki-delta.ts
    symbols: [planWikiUpdate, recordWikiState, checkWikiClean, resolveWikiInstructions]
  - path: src/lib/wiki-search.ts
    symbols: [searchWiki]
  - path: src/lib/wiki-run-summary.ts
    symbols: [createWikiRunSummary, formatWikiRunSummaryHuman, formatWikiRunSummaryMarkdown, getWikiRunSummary]
  - path: src/lib/wiki-site-safety.ts
    symbols: [neutralizeWikiSiteMarkdown, sanitizeWikiSiteFrontmatter, isSafeWikiSiteRemoteUrl, readWikiSiteOkfVersion]
  - path: src/cli/workflow.test.ts
  - path: src/lib/okf-wiki.test.ts
  - path: src/lib/wiki-delta.test.ts
  - path: src/lib/wiki-search.test.ts
  - path: src/lib/wiki-run-summary.test.ts
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

# Add one-run guidance for the maintainer agent
drs workflow run repository-wiki-sync --input instructions="Focus on public APIs."

# Use a different state path outside the bundle
drs workflow run repository-wiki-sync --input root=docs/wiki --input statePath=.drs/docs-wiki-state.json

# Fail if the workflow produces uncommitted changes
drs workflow run repository-wiki-sync --input check=true
```

## Persistent wiki brief

Repository-specific scope, priorities, exclusions, terminology, and audience can live in a persistent brief at `.drs/wiki-instructions.md` (override with `--input instructionsPath=<path>`). The brief is optional and must live outside the portable bundle. The maintainer receives the effective instructions on every run: the persistent brief content with any one-run `instructions` input appended after it, so precedence stays explicit and deterministic.

The brief is excluded from source fingerprints. Instead, `record-wiki-state` stores its hash as `instructionsHash` in the state file, so editing the brief invalidates freshness and the planner returns `reconcile` on the next run. One-run `instructions` inputs are never recorded and never invalidate freshness. The planner output exposes the effective instructions, their source (`file`, `input`, `combined`, or `none`), and the effective hash in workflow JSON output.

## Source provenance

Concepts declare the repository evidence behind them with the producer-defined `drs_sources` frontmatter field — repository-relative paths with optional `symbols`:

```yaml
---
type: Architecture
title: Wiki delta planner
drs_sources:
  - path: src/lib/wiki-delta.ts
    symbols: [planWikiUpdate]
---
```

Malformed declarations (non-list values, missing paths, absolute or escaping paths) are validation errors; cited paths that no longer exist and concepts without provenance are warnings, so coverage grows incrementally without blocking maintenance. Index synchronization rewrites only generated `index.md` files, so provenance survives untouched.

`record-wiki-state` inverts the citations into a `sourceConcepts` reverse map (source path to concept paths) in the state file. In update mode the planner intersects `changedPaths` with that map and returns `candidateConcepts` — the concepts whose cited sources changed — as the primary scope for the maintainer. Changed paths without provenance still reach the agent through `changedPaths` for judgment calls. Provenance also renders as a Sources panel on each concept page of the wiki site and appears in `drs wiki search --json` results.

Run the model-free check:

```bash
# Verify the wiki is current and valid
drs workflow run repository-wiki-check
```

The sync workflow runs the `task/okf-wiki-maintainer` agent only when the delta plan decides work is needed. If both source and wiki content match the recorded state, the agent node is skipped and the current bundle is validated instead. The workflow output is `wikiResult`: the final validation object enriched with `summary` and escaped `summaryMarkdown`.

## Run summary

Every `repository-wiki-sync` run ends with a deterministic summary in normal terminal output and under `output.summary` in JSON. It reports the delta mode and changed-source count; final concept total and net additions, edits, and deletions; validation warnings and errors; directed graph counts; provenance coverage; whether a model was invoked; model identity, turns, token usage, and estimated cost; elapsed time; and the effective instructions hash. A no-op explicitly reports that no model was invoked and uses zero model usage and concept changes.

Net concept changes come from the same before/after workspace fingerprint used by the agent permission postcondition. Generated `index.md` files and `log.md` are excluded. The summary contains metrics and identifiers only, not prompts, concept bodies, or the maintainer's prose response. The final output preserves the existing validation fields and adds `summary` plus an escaped `summaryMarkdown` rendering.

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
| `reconcile` | The state file is missing/invalid, the bundle root changed, the wiki content changed without a state update, or the persistent wiki brief changed. | Repair state or bundle drift. |
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
  "instructionsHash": "<sha256>",
  "sourceConcepts": {
    "src/example.ts": ["example-concept.md"]
  },
  "updatedAt": "<ISO 8601>"
}
```

`instructionsHash` is present only when a persistent wiki brief exists; state files recorded before the brief was introduced continue to load, and adding a brief later reconciles once. `sourceConcepts` is present only when concepts declare `drs_sources`; it is rebuilt from the bundle at record time, so hand-edited citations are absorbed on the next sync.

The `record-wiki-state` action writes this atomically after a successful sync. Missing tracked paths are omitted from the manifest, so deletions and renames remain stable after they are committed. Clean Git submodules use their checked-out commit as a canonical fingerprint that also works in CI when submodules are not initialized. Planning detects dirty submodules, but they must be committed before state can be recorded. Symbolic links in bundle or state ancestors are rejected. The `.gitignore` keeps most of `.drs/` ignored but explicitly tracks `.drs/wiki-state.json`, so the state is committed with the source it describes. The wiki bundle itself is committed alongside the source unless the project chooses to ignore it.

The `check-wiki-clean` action fails when the bundle or state file has tracked, untracked, or ignored working-tree changes. `repository-wiki-sync --input check=true` uses it to catch generated output that has not been committed.

## OKF bundle structure

Every Markdown file inside the bundle root is either a concept or a reserved file:

- **Concepts** — any `*.md` other than `index.md` and `log.md`. They must start with parseable YAML frontmatter containing a non-empty `type` field. Optional fields include `title`, `description`, `resource`, `tags`, and `timestamp`. Producer-defined fields are allowed.
- **`index.md`** — generated directory indexes. Only the bundle-root `index.md` may contain frontmatter declaring `okf_version: "0.1"`.
- **`log.md`** — optional human-authored update log with `## YYYY-MM-DD` headings and no frontmatter.

Internal links between concepts use standard Markdown links. Broken links are reported as warnings, not errors, because OKF consumers must tolerate them.

## Index synchronization

The `sync-okf-indexes` action in `src/lib/okf-wiki.ts` generates stable progressive-disclosure indexes for every non-empty bundle directory. It writes an `index.md` only when the generated content differs from the existing file, so repeated runs are idempotent. Writes use a temporary file and atomic rename to avoid partial indexes on failure, and empty directories have any stale `index.md` removed.

## Validation

The `validate-okf-wiki` action checks conformance without modifying the bundle:

- Required frontmatter and non-empty `type` on every concept.
- Reserved file rules (`index.md` and `log.md`).
- Valid date headings in `log.md`.
- Unsafe bundle roots and symbolic links are rejected.
- Internal links are validated and broken links are reported as warnings.
- Semantic links between concepts are analyzed as directed edges. Validation reports deterministic node, directed-edge, orphan, and weak-connection counts and warns for every orphan concept.

Generated indexes, `log.md`, links in frontmatter, and links inside code do not participate in semantic graph metrics. An orphan has no incoming or outgoing concept link. A weakly connected concept has exactly one distinct neighbor after edge direction is ignored.

The `repository-wiki-check` workflow combines `check-wiki-state` with `validate-okf-wiki`. It throws if the wiki is stale, so it can be used as a CI gate without requiring a model provider.

## CI integration

`.github/workflows/ci.yml` runs the strict model-free check for the dedicated scheduled wiki branch:

```yaml
- name: Check scheduled repository wiki freshness
  if: github.event_name == 'pull_request' && github.head_ref == 'drs/wiki-update'
  run: node dist/cli/index.js workflow run repository-wiki-check --executor local --json
```

Ordinary feature pull requests do not update `.drs/wiki-state.json`. Their wiki site build still validates OKF conformance, publishing safety, and rendering, but allows the canonical wiki to remain temporarily stale until scheduled maintenance runs. This avoids deterministic-state conflicts between parallel source branches.

`.github/workflows/wiki-update.yml` runs daily at 04:00 UTC and on manual dispatch. It checks out the latest default branch, runs `repository-wiki-sync --executor local`, rejects changes outside `wiki/` and `.drs/wiki-state.json`, and creates or updates one `drs/wiki-update` pull request. The generation job writes the escaped run summary to `$GITHUB_STEP_SUMMARY`; when wiki files changed, the publish job uses the same Markdown as the pull request body instead of posting recurring comments. Reusing one branch serializes generated wiki maintenance instead of producing one state file per feature branch. If the base branch moves before merge, rerun the workflow to regenerate the wiki and state from the new combined source tree.

Configure `DRS_PROVIDER_API_KEY` (or the legacy `OPENCODE_API_KEY` fallback) for generation. Configure a fine-grained `DRS_WIKI_SYNC_TOKEN` with repository Contents and pull requests read/write access for the final bot-PR step. Model execution and path guards run in a token-free job that exports only a binary patch and sanitized summary Markdown; full workflow JSON is not transferred to the token-bearing job. A fresh checkout reapplies and verifies that patch before the write token is supplied only to the pinned `peter-evans/create-pull-request` action. The bot PR runs the strict freshness check, and GitHub Pages repeats it before deployment.

## Model-free search

`drs wiki search` retrieves concepts directly from the canonical OKF bundle without a model, database, vector index, or website build:

```bash
drs wiki search "temporal retry policy" --limit 5
drs wiki search workflow runtime --json
```

The command is implemented in `src/cli/wiki.ts` and uses the `searchWiki` ranking in `src/lib/wiki-search.ts`, which loads the validated bundle through `loadOkfConcepts` in `src/lib/okf-wiki.ts`. It validates the bundle before reading it, rejects unsafe roots and symbolic links, and excludes reserved `index.md` and `log.md` documents. Ranking deterministically weights title, tags, description, headings, path, type, and body matches, with extra weight for complete phrase matches and exact title hits. Headings are extracted from normal Markdown only, so fenced code blocks are not treated as document structure; backtick fences whose info string contains an embedded backtick are also skipped so malformed fences do not hide headings. Snippets are selected from the best-matching source (description, body, headings, tags, or metadata) and excerpted around the matched terms. Search text is normalized with NFKC before tokenizing, and long snippets are cut at Unicode code-point boundaries so mixed-script or emoji runs cannot produce isolated surrogate pairs. Empty queries and invalid limits are rejected before ranking. `--source <path>` selects a non-default bundle root.

## Human-readable website

The canonical `wiki/` bundle is also the source for a VitePress website. DRS packages the adapter and theme under `.wiki-site/`, outside the bundle, so publishing concerns do not alter portable OKF content and other repositories can use the same renderer.

```bash
drs wiki build --source wiki --output .drs/wiki-site
drs wiki serve --source wiki
drs wiki check-site https://example.github.io/project/
```

`drs wiki build` accepts `--base`, `--site-url`, `--repository owner/name`, and `--title` for hosted output. `drs wiki serve` starts the same packaged adapter as a local development server. `drs wiki check-site` retries while a deployment propagates, then crawls sitemap pages and same-origin assets and verifies the graph, local search marker, raw OKF index, and `llms.txt`.

The site adapter in `.wiki-site/.vitepress/config.mts` scans concept frontmatter to generate type-grouped navigation and displays `type`, `description`, tags, resources, and timestamps as concept metadata. It uses `quickstart.md` as the start concept when present, falls back to the first concept otherwise, and treats `log.md` as optional. `.wiki-site/.vitepress/theme/PageLead.vue` renders the concept metadata and Sources panel, and the adapter escapes DRS workflow template expressions such as `{{artifacts.change}}` during rendering without modifying their source Markdown.

The publishing boundary treats bundle content as untrusted. `src/lib/wiki-site-safety.ts` neutralizes file include directives, executable SFC blocks, unsafe frontmatter, and non-HTTP resource links before VitePress renders the page, so wiki content cannot read runner files or inject executable markup into the published origin. Build and serve commands validate the source bundle and reject symbolic-link source/output escapes, and overlapping in-process builds and servers are rejected to keep their temporary VitePress configuration isolated.

Every build also emits:

- A local full-text search index and `sitemap.xml` for human discovery.
- An interactive directed `graph.html` generated from semantic Markdown links between concepts. Arrowheads preserve link direction, and selecting a concept separates its outgoing links from incoming references.
- `llms.txt` with concept summaries and public URLs.
- An unchanged copy of the canonical bundle under `/okf/` for agents and downloads.

Pull-request CI builds the site without deploying it. `.github/workflows/wiki-pages.yml` validates the wiki, derives its canonical URL and base path from GitHub Pages, publishes `.wiki-site/dist` after relevant changes merge to `main`, and runs the deployed-site smoke check. Generated `.wiki-site/dist` content is excluded from the reusable npm package.

## Agent and skills

The bundled agent `task/okf-wiki-maintainer` (`.pi/agents/task/okf-wiki-maintainer.md`) edits concept pages in place based on the deterministic delta plan. It is invoked only when the planner returns `shouldRun: true`. Generic workflow-agent permissions restrict its Pi `write`, `edit`, and `delete_file` tools to Markdown below the configured bundle root, deny generated indexes, reject symbolic links and traversal, and remove shell access. The scoped `git_diff` tool remains available for source evidence. Proposed documents receive immediate OKF validation before mutation, followed by bundle feedback that the agent can repair in the same run.

Run the writing workflow with the local executor. A before/after workspace fingerprint rejects residual changes outside the configured write policy as defense in depth. Deterministic downstream actions remain responsible for generated indexes and `.drs/wiki-state.json`. The model-free `repository-wiki-check` workflow is used for the scheduled bot PR and remains available for local verification.

## Tests

Wiki behavior is covered by:

- `src/lib/okf-wiki.test.ts` — index synchronization, validation, and graph-quality warnings.
- `src/lib/agent-permissions.test.ts` and `src/pi/sdk.test.ts` — policy validation, path and symbolic-link denial, Pi tool enforcement, in-run validation feedback, and post-run mutation checks.
- `src/lib/wiki-search.test.ts` and `src/cli/wiki.test.ts` — deterministic concept ranking, phrase matching, fenced-code-block-aware heading extraction (including invalid backtick fences), Unicode-normalized code-point-safe snippets, limits, empty-query rejection, unsafe-bundle rejection, and JSON CLI output.
- `src/lib/wiki-delta.test.ts` — delta planning, fingerprinting, state recording, and clean checks.
- `src/lib/wiki-run-summary.test.ts` — structural metrics, net concept-change classification, model-free no-op reporting, and Markdown escaping.
- `src/lib/wiki-site*.test.ts` — directed graph extraction and metrics, publishing safety, reusable build/serve setup, and deployed-site smoke checks.
- `src/cli/workflow.test.ts` — end-to-end `repository-wiki-sync` and `repository-wiki-check` workflow runs.
- `src/temporal/retry-policy.test.ts` — Temporal retry classification for wiki actions (`sync-okf-indexes` and `record-wiki-state` are no-retry; `plan-wiki-update`, `validate-okf-wiki`, `summarize-wiki-run`, `check-wiki-state`, and `check-wiki-clean` are retryable).

## See also

- [Maintenance workflows](maintenance-workflows.md) for other repository upkeep workflows.
- [Workflow engine](workflow-engine.md) for the actions and scheduling used by the wiki workflows.
- [Testing](testing.md) for the test suite and quality gate.
- [Temporal execution](temporal-execution.md) for retry policy details.
