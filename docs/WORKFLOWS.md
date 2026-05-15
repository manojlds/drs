# Workflows

DRS workflows run configured agents and built-in actions as a dependency graph. Use them when a task needs multiple coordinated steps, shared inputs, or artifacts passed between agents.

## Run A Workflow

```bash
drs workflow run release-notes
drs workflow run release-notes --input title="v1.2.3" --input-file diff=.drs/diff.md
drs workflow run release-notes --json -o .drs/workflow-result.json
```

## Config Example

```yaml
workflows:
  release-notes:
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
| `action` | Run a built-in action. Currently supports `write` and `git-diff` |

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

## Review Agent Fan-Out

Use `agentsFrom: review.agents` to reuse the configured review agent list in a workflow:

```yaml
workflows:
  custom-review:
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
