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
drs workflow run local-staged-review --json -o .drs/local-review.json

# DRS project-local changelog workflow
drs workflow run local-changelog-review

# Built-in platform review workflows
drs workflow run github-pr-review --input owner=octocat --input repo=hello-world --input pr=456
drs workflow run gitlab-mr-review --input project=group/repo --input mr=123
```

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

DRS also ships packaged workflows from `.pi/workflows/*.yaml`. Project workflow files override packaged workflows with the same name.

Use `workflow.default` in `.drs/drs.config.yaml` to select the workflow used by `drs workflow run` when no workflow name is provided:

```yaml
workflow:
  default: local-changelog-review
```

## Inputs

Workflow inputs are strings. They can be configured inline or read from repo-relative files:

```yaml
inputs:
  title: Upcoming release
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
| `action` | Run a built-in action. Currently supports `write`, `git-diff`, `git-add`, `git-commit`, `change-source`, and `review` |

Common node fields:

| Field | Description |
|-------|-------------|
| `needs` | Node ids that must complete first |
| `input` | Prompt/content template for the node |
| `output` | Artifact name for the node's primary output |
| `writes` | Repo-relative path to write the node output/content |
| `json` | For agent nodes, write JSON when `writes` is set |
| `with` | Action-specific options |

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
| `github-pr` | Load GitHub PR metadata and changed files |
| `gitlab-mr` | Load GitLab MR metadata and changed files |

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

DRS ships with local review workflows equivalent to the local diff source loading used by `drs review-local`:

```bash
drs workflow run local-review
drs workflow run local-staged-review
drs workflow run github-pr-review --input owner=octocat --input repo=hello-world --input pr=456
drs workflow run gitlab-mr-review --input project=group/repo --input mr=123
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
nodes:
  change:
    action: change-source
    with:
      type: github-pr
      owner: "{{inputs.owner}}"
      repo: "{{inputs.repo}}"
      pr: "{{inputs.pr}}"
    output: change
  review:
    action: review
    needs: [change]
    with:
      source: change
    output: review
```

`gitlab-mr-review` follows the same shape with `project` and `mr` inputs.

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
