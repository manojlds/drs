# Model Overrides

DRS supports model overrides at global, namespace, exact-agent, review, and describe levels.

## 1) Global Default

```yaml
agents:
  default:
    model: anthropic/claude-sonnet-4-5-20250929
```

## 2) Namespace And Exact-Agent Overrides

Use `agents.namespaces` for all agents in a namespace and `agents.overrides` for one fully qualified agent id. This applies to review agents and generic agents run with `drs run-agent`.

```yaml
agents:
  namespaces:
    review:
      model: anthropic/claude-sonnet-4-5-20250929
    task:
      model: openai/gpt-4o
  overrides:
    task/docs-updater:
      model: anthropic/claude-opus-4-5-20251101
```

## 3) Review Agent Inline Override

```yaml
review:
  agents:
    - name: review/security
      model: anthropic/claude-opus-4-5-20251101
    - review/quality
```

## 4) Unified Reviewer Override

```yaml
review:
  agents:
    - review/unified-reviewer
  unified:
    model: anthropic/claude-sonnet-4-5-20250929
```

## 5) Describer Override

```yaml
describe:
  model: anthropic/claude-sonnet-4-5-20250929
```

## 6) Reasoning Effort / Extended Thinking

Control how deeply the model reasons during reviews.

### Config file

```yaml
agents:
  default:
    thinkingLevel: medium  # off, minimal, low, medium, high, xhigh
```

### CLI flags

```bash
drs review-pr --owner octocat --repo hello-world --pr 456 --reasoning-effort high
drs review-mr --project my-org/my-repo --mr 123 --ultrathink  # alias for --reasoning-effort high
```

### Environment variable

```bash
REVIEW_THINKING_LEVEL=medium
```

**Precedence**: CLI flag > environment variable > config file.

## 7) Environment Variable Overrides

```bash
DRS_DEFAULT_MODEL=anthropic/claude-sonnet-4-5-20250929
DRS_AGENT_REVIEW_SECURITY_MODEL=anthropic/claude-opus-4-5-20251101
DRS_AGENT_TASK_DOCS_UPDATER_MODEL=openai/gpt-4o
REVIEW_UNIFIED_MODEL=anthropic/claude-opus-4-5-20251101
DESCRIBE_MODEL=anthropic/claude-sonnet-4-5-20250929
REVIEW_THINKING_LEVEL=medium
```

Per-agent model variables are derived from the fully qualified agent id by replacing non-alphanumeric characters with `_`; for `review/security`, use `DRS_AGENT_REVIEW_SECURITY_MODEL`. Legacy `REVIEW_DEFAULT_MODEL` and `REVIEW_AGENT_<ID>_MODEL` aliases are still supported for review-era configurations.

## Runtime Mode

DRS uses Pi in-process runtime only. No runtime endpoint configuration is required.
