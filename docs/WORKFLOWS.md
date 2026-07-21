# Workflows

DRS workflows run configured agents and built-in actions as a dependency graph. Use them when a task needs multiple coordinated steps, shared inputs, or artifacts passed between agents.

## Run A Workflow

```bash
drs workflow run release-notes
drs workflow run # uses workflow.default from .drs/drs.config.yaml when configured
drs workflow run release-notes --input title="v1.2.3" --input-file diff=.drs/diff.md
drs workflow run release-notes --json -o .drs/workflow-result.json

# Built-in local review workflows
drs workflow run local-review
drs workflow run local-review --input staged=true --json -o .drs/local-review.json

# Built-in local maintenance workflows
drs workflow run local-changelog-update
drs workflow run tag-changelog-update
drs workflow run local-fix-review-issues
drs workflow run local-update-agents-md
drs workflow run repository-wiki-sync
drs workflow run repository-wiki-sync --input root=docs/wiki --input instructions="Focus on public APIs"
drs workflow run repository-wiki-check

# DRS project-local changelog workflow
drs workflow run local-changelog-review

# Built-in platform review workflows
drs workflow run github-pr-review --input owner=octocat --input repo=hello-world --input pr=456
drs workflow run github-pr-review --input owner=octocat --input repo=hello-world --input pr=456 --input describe=true --input post=true
drs workflow run github-pr-show-changes --input owner=octocat --input repo=hello-world --input pr=456
drs workflow run gitlab-mr-review --input project=group/repo --input mr=123
drs workflow run gitlab-mr-review --input project=group/repo --input mr=123 --input describe=true --input post=true
drs workflow run gitlab-mr-show-changes --input project=group/repo --input mr=123
drs workflow run gitlab-mr-review --input project=group/repo --input mr=123 --input codeQuality=true
drs workflow run gitlab-mr-review --input project=group/repo --input mr=123 --input describe=true --input post=true --input codeQuality=true
```

## Resume Failed Workflows

> **Note:** DRS 4.0 does not currently support workflow resume. If a workflow fails, re-run it from the start — review and fix nodes are LLM calls and are cheap to re-execute. The legacy `--resume` and `--checkpoint-*` flags from the 3.x series have been removed.

If you have a long-running workflow (for example, a multi-iteration fix loop) and want failure recovery without re-running completed work, run the workflow in smaller pieces: dispatch each iteration as its own workflow run with a fixed `fixMaxIterations: '1'` input, and re-dispatch the next iteration only if the previous one failed.

## List Workflows

```bash
drs workflow list
drs workflow list --json
drs workflow show github-pr-review
drs workflow show github-pr-review --json
drs workflow validate
drs workflow validate github-pr-review
drs workflow validate github-pr-review --json
```

`list` shows every available workflow, whether it comes from the packaged set or from `.drs/workflows/*.yaml`, and whether a project workflow overrides a packaged one. `validate` checks workflow schema, dependencies, action options, control targets, and execution waves without running nodes.

Use `drs workflow show <name>` or `drs workflow get <name>` to inspect one workflow's description, inputs, output artifact, and nodes before running it.

## Repository Wiki

The packaged `repository-wiki-sync` workflow generates or updates one repository wiki as an [Open Knowledge Format (OKF) v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) bundle. The default bundle root is `wiki/`; override it with `--input root=docs/wiki` when a repository keeps documentation under `docs/`.

The workflow first computes deterministic source and wiki fingerprints, then chooses one of two branches:

1. Generate/reconcile/update: run `task/okf-wiki-maintainer`, synchronize indexes, validate the bundle, and atomically record `.drs/wiki-state.json`.
2. No-op: skip the model and validate the existing bundle when both fingerprints match the recorded state.

The source fingerprint covers tracked and non-ignored untracked files outside the bundle and state path. The state retains a per-path fingerprint manifest, which keeps delta detection stable when dirty source, wiki, and state are committed together and gives later updates an exact `changedPaths` set. Older state without a manifest falls back to the recorded Git head plus current working-tree changes.

Repository-specific wiki intent — scope, priorities, exclusions, terminology, and audience — can live in a persistent brief at `.drs/wiki-instructions.md` (override the location with `--input instructionsPath=<path>`). The brief is optional, must live outside the portable bundle, and is excluded from source fingerprints; instead its hash is recorded in wiki state, so editing the brief invalidates freshness and forces a reconcile on the next run. The `instructions` input remains a one-run addition: it is appended after the file content for the maintainer prompt, is never recorded in state, and never invalidates freshness. The effective brief content, source (`file`, `input`, `combined`, or `none`), and hash are visible in the `plan-update` node's JSON output.

Concepts can declare their repository evidence with the producer-defined `drs_sources` frontmatter field — repository-relative paths with optional `symbols`:

```yaml
---
type: Architecture
title: Wiki delta planner
drs_sources:
  - path: src/lib/wiki-delta.ts
    symbols: [planWikiUpdate]
  - path: .pi/workflows/repository-wiki-sync.yaml
---
```

Malformed declarations (non-list values, missing paths, absolute or escaping paths) fail validation; cited paths that no longer exist and concepts without provenance are warnings, not failures. `record-wiki-state` stores a `source path -> concept paths` reverse map in wiki state, so `plan-wiki-update` returns `candidateConcepts` — the concepts whose cited sources changed — as the primary scope for update mode. Provenance also renders as a Sources panel on the wiki site and appears in `drs wiki search --json` results.

Clean Git submodules use the checked-out commit as their canonical fingerprint, including when the submodule is not initialized in CI. Dirty submodules are detected during planning but must be committed before DRS records wiki state.

The packaged `repository-wiki-check` workflow recomputes the fingerprints and validates OKF without invoking a model. This repository runs it for the scheduled `drs/wiki-update` pull request, while ordinary feature pull requests validate the bundle through the wiki site build without requiring branch-local state freshness. Run `repository-wiki-sync --input check=true` locally when you want generation followed by a failure if the workflow produced uncommitted wiki or state changes.

Every non-reserved Markdown file is an OKF concept. `index.md` and `log.md` are reserved. The validator requires parseable YAML frontmatter with a non-empty `type` on every concept, permits producer-defined fields, accepts optional `timestamp`, and reports broken internal links as warnings as required by OKF's permissive consumption model. The maintainer's Pi session can write only Markdown below the configured bundle root, cannot write generated indexes, and validates proposed documents before each write or edit.

Run this workflow with the local executor. DRS does not commit or push wiki changes; review the resulting working-tree diff normally.

### Repository wiki search

Search the canonical bundle directly without invoking a model or building the website:

```bash
drs wiki search "temporal retry policy" --limit 5
drs wiki search workflow runtime --json
```

Search validates the OKF bundle first, rejects unsafe roots and symbolic links, and excludes reserved `index.md` and `log.md` files. Ranking deterministically weights title, tags, description, headings, path, type, and body text. Results include repository-relative concept paths, scores, metadata, and matching snippets. Use `--source <path>` for a non-default bundle root.

### Repository wiki website

DRS renders a canonical OKF bundle with its packaged VitePress adapter. The build derives sidebar groups from concept `type` frontmatter, uses `quickstart.md` as the start page when present and otherwise falls back to the first concept, and publishes concept metadata, local search, an internal-link relationship graph, a sitemap, `llms.txt`, and an unchanged raw bundle under `/okf/`. A `log.md` page is optional.

Build and serve commands validate the OKF source before rendering and reject source or output paths that escape through symbolic links. Raw HTML, executable page frontmatter, file include/snippet directives, unsafe resource schemes, and local image imports are disabled at the publishing boundary. In-process build and serve operations are isolated and cannot overlap because VitePress configuration is scoped through temporary process environment values.

```bash
drs wiki build --source wiki --output .drs/wiki-site
drs wiki serve --source wiki
drs wiki check-site https://example.github.io/project/
```

Use `--base`, `--site-url`, `--repository owner/name`, and `--title` to configure hosted output. Pull-request CI always builds the DRS wiki; the dedicated `drs/wiki-update` pull request first runs the strict model-free freshness check. `.github/workflows/wiki-pages.yml` repeats validation, derives the canonical URL and base path from GitHub Pages, deploys `.wiki-site/dist` on relevant pushes to `main`, and then uses `drs wiki check-site` to crawl deployed pages and same-origin assets and verify search, structured graph data and concept links, `llms.txt`, sitemap, and raw OKF outputs.

## Workflow Files

Workflows are YAML files. Project workflow files live in `.drs/workflows/*.yaml`:

```yaml
name: release-notes
description: Draft release notes from a diff
inputs:
  title: Upcoming release
nodes:
  diff:
    action: git-diff
    output: diff

  summarize:
    agent: task/change-summarizer
    needs: [diff]
    input: |
      Summarize these changes for release notes.

      {{artifacts.diff}}
    output: summary

  release-notes:
    agent: task/docs-updater
    needs: [summarize]
    input: |
      Title: {{inputs.title}}

      Change summary:
      {{artifacts.summary}}
    output: releaseNotes

  write-release-notes:
    action: write
    needs: [release-notes]
    input: "{{artifacts.releaseNotes}}"
    writes: RELEASE_NOTES.md
```

The `name` field is optional. When omitted, DRS uses the file name without `.yaml` or `.yml`.

Inline `workflows:` maps in `.drs/drs.config.yaml` and `.gitlab-review.yml` are not supported and are rejected at load time. Move each workflow into its own file under `.drs/workflows/*.yaml`.

DRS also ships packaged workflows from `.pi/workflows/*.yaml`. Project workflow files override packaged workflows with the same name.

Use `workflow.default` in `.drs/drs.config.yaml` to select the workflow used by `drs workflow run` when no workflow name is provided:

```yaml
workflow:
  default: local-changelog-review
```

## Inputs

Workflow inputs can use a shorthand string value or typed metadata. CLI values override configured defaults:

```yaml
inputs:
  title:
    type: string
    default: Upcoming release
    description: Release title
  publish:
    type: boolean
    default: false
  severity:
    type: enum
    values: [critical, high, medium, low]
    default: high
  pr:
    type: number
    required: true
  diff:
    file: .drs/diff.md
  instructions:
    value: Keep it concise.
```

CLI values override configured values:

```bash
drs workflow run release-notes --input title="v1.2.3" --input-file diff=changes.md
```

## Nodes

Every node must define exactly one execution type:

| Field | Description |
|-------|-------------|
| `agent` | Run one fully qualified agent id, for example `task/docs-updater` |
| `agentsFrom` | Run a configured agent list. Currently supports `review.agents` |
| `action` | Run a built-in action. Supported actions are validated from the DRS action registry, including git operations, change sources, review/describe/post actions, artifact actions, fix verification, and change-request creation |
| `control` | Route workflow execution with `loop`, `switch`, `passThrough`, or `end` |

Common node fields:

| Field | Description |
|-------|-------------|
| `needs` | Node ids that must complete first |
| `input` | Prompt/content template for the node |
| `output` | Artifact name for the node's primary output |
| `writes` | Repo-relative path to write the node output/content |
| `json` | For agent nodes, write JSON when `writes` is set |
| `with` | Action-specific options |
| `permissions` | Runtime-enforced filesystem and shell capabilities for agent nodes |
| `validation` | Content validators invoked by policy-aware mutation tools |

Workflow files are strictly validated. A node must use exactly one of `agent`, `agentsFrom`, `action`, or `control`; unknown node fields and unknown action options are rejected before execution.

### Agent permissions

Agent nodes can restrict filesystem mutations with literal repository-relative roots and root-relative glob patterns:

```yaml
nodes:
  maintain-docs:
    agent: task/docs-updater
    permissions:
      filesystem:
        write:
          roots: [docs]
          allow: ["**/*.md"]
          deny: ["**/index.md"]
        delete:
          roots: [docs]
          allow: ["**/*.md"]
          deny: ["**/index.md"]
      shell: false
    input: Update documentation.
```

`deny` takes precedence over `allow`. Literal `roots` are kept separate from glob patterns so rendered workflow inputs cannot broaden access through glob metacharacters. Filesystem policies require `shell: false`; otherwise shell commands could bypass path controls. DRS propagates the policy into same-name Pi `read`, `write`, and `edit` tool definitions plus the generic `delete_file` tool, rejects symbolic links and multiply-linked write targets, applies the policy to DRS custom tools, and compares Git-visible workspace files before and after the agent run as defense in depth. A restricted `read` rule disables aggregate `grep`, `find`, `ls`, and `git_diff` tools because those tools can traverse or expose denied descendants; omit `read` when the agent needs unrestricted repository evidence.

An optional write validator can reject invalid content before modification and return full post-write validation feedback to the agent:

```yaml
    validation:
      afterMutation:
        - name: okf-document
          root: "{{inputs.root}}"
```

The initial validator registry contains `okf-document`. Workflow actions remain outside the agent permission boundary, allowing deterministic nodes to generate indexes or state after the agent completes.

## Conditions

Executable nodes and `control: loop` nodes support `if`. Other control nodes do not. Use `control: loop` for repeated execution; `switch` and `passThrough` are branch routers and can only jump forward.

Conditions can reference values directly:

```yaml
if: inputs.post == true
if: artifacts.reviewThreshold.matched == true
if: artifacts.verify-fix.fixFiles > 0
```

The template-wrapped form is also accepted:

```yaml
if: "{{inputs.post}} == true"
```

Use quotes when comparing values that may contain operators or whitespace:

```yaml
if: '"{{inputs.mode}}" == "safe && fast"'
```

## Built-In Actions

### `change-source`

Loads a structured change source artifact. This is the preferred input for workflow-based review nodes.

```yaml
nodes:
  change:
    action: change-source
    with:
      type: local
      staged: false
    output: change
```

Currently supported source types:

| Type | Description |
|------|-------------|
| `local` | Load local git diff from the workflow working directory |
| `git-range` | Load a git diff and commit list between two refs or inferred tags |
| `github-pr` | Load GitHub PR metadata and changed files |
| `gitlab-mr` | Load GitLab MR metadata and changed files |

Git range source:

```yaml
nodes:
  change:
    action: change-source
    with:
      type: git-range
      from: v3.3.1
      to: v4.0.0-rc.1
    output: change
```

When `from` and `to` are omitted, `git-range` infers `to` from a GitHub Actions tag event (`GITHUB_REF_NAME`) or the tag currently checked out at `HEAD`, then infers `from` from the previous reachable stable semver tag. Set `with.includePrereleaseFrom: true` if an RC-to-RC range is desired.

GitHub PR source:

```yaml
nodes:
  change:
    action: change-source
    with:
      type: github-pr
      owner: octocat
      repo: hello-world
      pr: 456
    output: change
```

GitLab MR source:

```yaml
nodes:
  change:
    action: change-source
    with:
      type: gitlab-mr
      project: group/repo
      mr: 123
    output: change
```

### `review`

Runs the existing DRS review orchestrator against a `change-source` artifact.

```yaml
nodes:
  review:
    action: review
    needs: [change]
    with:
      source: change
    output: review
```

The review action reuses existing review configuration, including `review.agents`, ignore patterns, describe settings, context compression, and model overrides.

The review action always saves a canonical review artifact. The raw review remains available through `output`, while the persisted review artifact envelope is available as `artifacts.<nodeId>Artifact` by default, such as `artifacts.reviewArtifact` for a node named `review`.

Set `with.artifact` to override that named workflow artifact output. Verification re-review nodes that set `with.reviewArtifact` do not create the implicit `<nodeId>Artifact` output; they use the supplied artifact for verification context instead.

### `review-context`

Builds and outputs the review instructions/context for a `change-source` artifact without running review agents. This is useful for debugging what DRS will send to agents.

```yaml
nodes:
  context:
    action: review-context
    needs: [change]
    with:
      source: change
      file: src/app.ts
    output: reviewContext
```

Packaged workflows: `github-pr-show-changes`, `gitlab-mr-show-changes`.

### `code-quality-report`

Writes a GitLab Code Quality report from a `review` artifact. Use the packaged `gitlab-mr-review` workflow with `codeQuality=true` when you want GitLab CI artifacts.

```yaml
nodes:
  code-quality:
    action: code-quality-report
    needs: [review]
    with:
      review: review
      path: gl-code-quality-report.json
    output: codeQualityReport
```

You can make the report path configurable through workflow inputs:

```yaml
inputs:
  codeQualityReport: gl-code-quality-report.json
nodes:
  code-quality:
    action: code-quality-report
    with:
      review: review
      path: "{{inputs.codeQualityReport}}"
```

### `sync-okf-indexes`

Generates an official OKF v0.1 `index.md` in every non-empty directory of a bundle. The bundle-root index declares `okf_version: "0.1"`; nested indexes contain no frontmatter. Existing indexes are rewritten only when generated content changes.

```yaml
nodes:
  sync-indexes:
    action: sync-okf-indexes
    with:
      root: wiki
      version: "0.1"
    output: wikiIndexes
```

### `plan-wiki-update`

Computes source and bundle fingerprints and returns `generate`, `reconcile`, `update`, or `noop`. It accepts `root` and `statePath`; update results include the exact changed source paths, capped at 500 entries, plus `candidateConcepts` — the concepts whose cited `drs_sources` changed, derived from the recorded reverse provenance map. It also accepts `instructionsPath` (default `.drs/wiki-instructions.md`) and a one-run `instructions` value: the persistent brief is excluded from source fingerprints, a changed brief hash returns `reconcile`, and the effective combined instructions, source, and hash are included in the node output.

### `record-wiki-state`

Atomically writes `.drs/wiki-state.json` after successful index synchronization and validation. The state records the OKF version, bundle root, Git head, aggregate source hash, per-path source fingerprints, wiki hash, persistent wiki brief hash (when a brief exists), the `drs_sources` reverse provenance map (when concepts declare sources), and update time. Accepts the same `instructionsPath` and `instructions` options as `plan-wiki-update`; one-run instructions are never recorded.

### `check-wiki-state`

Runs the same delta planner without a model and fails unless it returns `noop`, including when the persistent wiki brief changed since the recorded state. The packaged `repository-wiki-check` workflow uses this action in CI.

### `check-wiki-clean`

Fails when the bundle or state path has tracked, untracked, or ignored working-tree changes. `repository-wiki-sync` uses it when `check=true`.

### `validate-okf-wiki`

Validates an OKF bundle without modifying it. Invalid concept frontmatter, malformed `drs_sources` declarations, reserved-file structure, unsafe roots, and symbolic links fail the node. Broken internal links remain warnings because OKF consumers must tolerate them; cited source paths that no longer exist and concepts without provenance are also warnings, so coverage can grow incrementally.

```yaml
nodes:
  validate-wiki:
    action: validate-okf-wiki
    with:
      root: wiki
      version: "0.1"
    output: wikiValidation
```

### `summarize-wiki-run`

Combines a `plan-wiki-update` artifact, final `validate-okf-wiki` artifact, and wiki maintainer node metadata into a deterministic run summary. The summary reports delta mode, changed sources, net concept additions/edits/deletions, validation and graph metrics, provenance coverage, model invocation and usage, estimated cost, elapsed time, and the effective instructions hash. It does not include prompts, repository content, or the maintainer's prose response.

The action preserves the validation fields and adds `summary` plus escaped `summaryMarkdown`. `repository-wiki-sync` uses this enriched object as its final output. Human CLI runs render the same summary, while the scheduled GitHub workflow places `summaryMarkdown` in the job summary and updates the reusable wiki pull request body without posting comments.

```yaml
nodes:
  summarize-wiki:
    action: summarize-wiki-run
    needs: [record-state]
    with:
      plan: wikiDelta
      validation: wikiValidation
      agentNode: maintain-wiki
    output: wikiResult
```

### `describe`

Generates a PR/MR description from a platform `change-source` artifact. Set `with.post: true` to update the PR/MR description on the platform.

```yaml
nodes:
  describe:
    action: describe
    needs: [change]
    with:
      source: change
      post: true
    output: description
```

### `post-comment`

Posts a general PR/MR comment. Use `with.marker` to update an existing DRS-managed comment instead of creating duplicates.

```yaml
nodes:
  announce:
    action: post-comment
    input: "Release notes are ready."
    with:
      platform: github
      owner: octocat
      repo: hello-world
      pr: 456
      marker: release-notes
```

When a workflow already has a platform `change-source` artifact, `post-comment` can reuse it:

```yaml
nodes:
  announce:
    action: post-comment
    input: "Release notes are ready."
    with:
      source: change
      marker: release-notes
```

Packaged workflows: `github-pr-post-comment`, `gitlab-mr-post-comment`.

### `post-review-comments`

Posts DRS review results to GitHub or GitLab using the same summary marker and issue fingerprints as the packaged `*-review-post` workflows.

```yaml
nodes:
  post-comments:
    action: post-review-comments
    needs: [review]
    with:
      source: change
      review: review
```

The `source` must be a platform `change-source` artifact and `review` must be the output artifact from an `action: review` node.

Optional flags:

- `with.removeErrorComment` (default `true`): set to `false` to keep any existing DRS error comment instead of removing it before posting review comments.

### `git-diff`

Loads the local git diff from the workflow working directory.

```yaml
nodes:
  diff:
    action: git-diff
    output: diff
```

Use staged changes with `with.staged`:

```yaml
nodes:
  diff:
    action: git-diff
    with:
      staged: true
    output: diff
```

### `git-add`

Stages repo-relative paths. Use `with.path` for one path or `with.paths` for comma/newline-separated paths.

```yaml
nodes:
  stage-changelog:
    action: git-add
    with:
      paths: CHANGELOG.md, README.md
```

### `git-commit`

Creates a git commit. When `with.path` or `with.paths` is provided, DRS stages and commits only those paths. Without paths, it commits the current index. Set `with.useChangeRequestAuthor: true` to use the creator from a GitHub PR or GitLab MR `change-source` artifact as both the Git author and committer. The source artifact defaults to `change`; override it with `with.source`. DRS uses a public creator email when available and otherwise uses the platform's no-reply address. Self-managed GitLab instances can set `GITLAB_COMMIT_EMAIL_DOMAIN` when their private commit email domain differs from `users.noreply.<instance-host>`. The option fails before staging when the source has no platform creator identity. The authenticated token remains the pusher.

Packaged GitHub/GitLab fix and agent-guidance workflows expose a `useChangeRequestAuthor` input that defaults to `true`. Set `--input useChangeRequestAuthor=false` when repository push rules require the committer email to belong to the authenticated token owner.

```yaml
nodes:
  commit-changelog:
    action: git-commit
    with:
      paths: CHANGELOG.md
      message: "docs: update changelog"
      useChangeRequestAuthor: true
```

### `write`

Writes rendered input to a repo-relative file.

```yaml
nodes:
  write-summary:
    action: write
    input: "{{artifacts.summary}}"
    writes: SUMMARY.md
```

## Templates

Node inputs and write paths support `{{...}}` references:

| Reference | Meaning |
|-----------|---------|
| `{{inputs.diff}}` | Workflow input named `diff` |
| `{{nodes.summarize.response}}` | Raw response from node `summarize` |
| `{{artifacts.summary}}` | Artifact named `summary` |

Non-string values are inserted as pretty JSON.

## Built-In Review Workflows

DRS ships with built-in review workflows for local diffs, GitHub PRs, and GitLab MRs:

```bash
drs workflow run local-review
drs workflow run local-review --input staged=true
drs workflow run github-pr-review --input owner=octocat --input repo=hello-world --input pr=456
drs workflow run github-pr-review --input owner=octocat --input repo=hello-world --input pr=456 --input describe=true --input post=true
drs workflow run gitlab-mr-review --input project=group/repo --input mr=123
drs workflow run gitlab-mr-review --input project=group/repo --input mr=123 --input describe=true --input post=true
```

They are packaged as `.pi/workflows/*.yaml` files with this shape:

```yaml
name: local-review
nodes:
  change:
    action: change-source
    with:
      type: local
      staged: false
    output: change
  review:
    action: review
    needs: [change]
    with:
      source: change
    output: review
```

Platform workflows use the same file shape with inputs:

```yaml
name: github-pr-review
inputs:
  owner: ""
  repo: ""
  pr: ""
  describe: "false"
  post: "false"
nodes:
  change:
    action: change-source
    with:
      type: github-pr
      owner: "{{inputs.owner}}"
      repo: "{{inputs.repo}}"
      pr: "{{inputs.pr}}"
    output: change
  describe:
    action: describe
    needs: [change]
    if: "{{inputs.describe}} == true"
    with:
      source: change
      post: true
  review:
    action: review
    needs: [change]
    with:
      source: change
    output: review
```

`gitlab-mr-review` follows the same shape with `project` and `mr` inputs, plus `codeQuality` for GitLab Code Quality output.

## Built-In Maintenance Workflows

DRS 4.0 ships maintenance workflows alongside review workflows:

| Workflow | Purpose |
|----------|---------|
| `local-changelog-update` | Update `CHANGELOG.md` from local unstaged changes using `task/changelog-updater` |
| `tag-changelog-update` | Update `CHANGELOG.md` from changes between the previous tag and current tag, or explicit refs |
| `release-changelog-finalize` | Finalize `CHANGELOG.md` for a release from an explicit git range before tagging |
| `local-fix-review-issues` | Fix actionable issues from a saved DRS review result using `task/review-issue-fixer`, then re-run local review |
| `local-update-agents-md` | Update `AGENTS.md` or equivalent agent guidance using `task/agents-md-updater` |

Examples:

```bash
drs workflow run local-changelog-update
drs workflow run tag-changelog-update --input from=v3.3.1 --input to=v4.0.0-rc.1
drs workflow run release-changelog-finalize --input from=v3.3.1 --input to=HEAD --input version=4.0.0 --input date=2026-06-27
drs workflow run local-fix-review-issues
drs workflow run local-update-agents-md --input path=AGENTS.md
```

These workflows are intentionally local and do not commit changes. Compose them with `git-add`, `git-commit`, review, or platform posting nodes in project workflows when your repository wants stronger automation.

### Release Changelog In GitHub Actions

For final releases, use `.github/workflows/release-changelog.yml` before publishing. It is manually triggered, runs `release-changelog-finalize`, commits the changelog to the default branch, and can optionally create the final `v<version>` tag after the changelog commit. The tag push then triggers the publish workflow from a commit that already contains the finalized changelog.

Typical final release inputs:

```text
version: 4.0.0
from: v3.3.1
to: HEAD
releaseDate: 2026-06-27
createTag: true
```

### RC Tag Changelog In GitHub Actions

`tag-changelog-update` is designed for release-candidate tag-triggered GitHub Actions. When `from` and `to` are omitted, it uses `GITHUB_REF_NAME` as the current tag and asks git for the previous reachable stable semver tag. This means `v4.0.0-rc.1` compares against the previous stable tag, not an older release-candidate tag. Final releases should use the manual release changelog workflow above so the final tag includes the changelog commit.

```yaml
name: Update changelog from tag

on:
  push:
    tags:
      - "v*-rc.*"

jobs:
  changelog:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          fetch-tags: true

      - uses: actions/setup-node@v4
        with:
          node-version: '22.19.0'

      - run: npm ci
      - run: npm run build

      - run: node dist/cli/index.js workflow run tag-changelog-update
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

      - run: |
          if git diff --quiet -- CHANGELOG.md; then
            echo "No changelog update needed"
            exit 0
          fi
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add CHANGELOG.md
          git commit -m "docs: update changelog for $GITHUB_REF_NAME"
          git push
```

For release-candidate testing before final `v4.0.0`, create and push an RC tag:

```bash
git tag v4.0.0-rc.1
git push origin v4.0.0-rc.1
```

For local dry-runs, pass explicit refs:

```bash
drs workflow run tag-changelog-update --input from=v3.3.1 --input to=v4.0.0-rc.1
```

## DRS Local Changelog Workflow

This repository defines a project-local workflow at `.drs/workflows/local-changelog-review.yaml`:

```bash
drs workflow run local-changelog-review
```

It loads the local unstaged diff, runs `task/changelog-updater` to edit `CHANGELOG.md` in place, reloads the local diff, runs the normal DRS review action on the final changes, then commits only `CHANGELOG.md` with `docs: update changelog`.

## Review Agent Fan-Out

Use `agentsFrom: review.agents` to reuse the configured review agent list in a workflow:

```yaml
name: custom-review
inputs:
  diff:
    file: .drs/diff.md
nodes:
  review:
    agentsFrom: review.agents
    input: |
      Review this diff and report only actionable findings.

      {{inputs.diff}}
    output: reviewResult
```

The node output is a Markdown string with one section per agent. Detailed per-agent responses are also available at `nodes.review.responses`.
