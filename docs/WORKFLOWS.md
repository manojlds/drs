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

Workflow files are strictly validated. A node must use exactly one of `agent`, `agentsFrom`, `action`, or `control`; unknown node fields and unknown action options are rejected before execution.

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
      artifact: persistedReviewArtifact
    output: review
```

The review action reuses existing review configuration, including `review.agents`, ignore patterns, describe settings, context compression, and model overrides.

Set `with.artifact` to also create and save a review artifact under that output name. The raw review remains available through `output`, while the persisted review artifact envelope is available as `artifacts.<artifact>`.

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

Creates a git commit. When `with.path` or `with.paths` is provided, DRS stages and commits only those paths. Without paths, it commits the current index.

```yaml
nodes:
  commit-changelog:
    action: git-commit
    with:
      paths: CHANGELOG.md
      message: "docs: update changelog"
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
