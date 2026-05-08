# Model Overrides

DRS supports model overrides at global, unified-review, describer, and per-agent levels.

## 1) Global Default

```yaml
agents:
  default:
    model: anthropic/claude-sonnet-4-5-20250929
```

## 2) Per-Agent Override

```yaml
review:
  agents:
    - name: review/security
      model: anthropic/claude-opus-4-5-20251101
    - review/quality
```

## 3) Unified Reviewer Override

```yaml
review:
  agents:
    - review/unified-reviewer
  unified:
    model: anthropic/claude-sonnet-4-5-20250929
```

## 4) Describer Override

```yaml
describe:
  model: anthropic/claude-sonnet-4-5-20250929
```

## 5) Reasoning Effort / Extended Thinking

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

## 6) Environment Variable Overrides

```bash
REVIEW_DEFAULT_MODEL=anthropic/claude-sonnet-4-5-20250929
REVIEW_UNIFIED_MODEL=anthropic/claude-opus-4-5-20251101
DESCRIBE_MODEL=anthropic/claude-sonnet-4-5-20250929
REVIEW_AGENT_REVIEW_SECURITY_MODEL=anthropic/claude-opus-4-5-20251101
REVIEW_THINKING_LEVEL=medium
```

`REVIEW_DEFAULT_MODEL` remains the environment variable for `agents.default.model`. Per-agent model variables are derived from the fully qualified agent id by replacing non-alphanumeric characters with `_`; for `review/security`, use `REVIEW_AGENT_REVIEW_SECURITY_MODEL`.

## Runtime Mode

DRS uses Pi in-process runtime only. No runtime endpoint configuration is required.
