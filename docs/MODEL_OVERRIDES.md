# Model Overrides

DRS supports model overrides at global, unified-review, describer, and per-agent levels.

## 1) Global Default

```yaml
review:
  default:
    model: anthropic/claude-sonnet-4-5-20250929
```

## 2) Per-Agent Override

```yaml
review:
  agents:
    - name: security
      model: anthropic/claude-opus-4-5-20251101
    - quality
```

## 3) Unified Reviewer Override

```yaml
review:
  mode: unified
  unified:
    model: anthropic/claude-sonnet-4-5-20250929
```

## 4) Describer Override

```yaml
describe:
  model: anthropic/claude-sonnet-4-5-20250929
```

## 5) Environment Variable Overrides

```bash
REVIEW_DEFAULT_MODEL=anthropic/claude-sonnet-4-5-20250929
REVIEW_UNIFIED_MODEL=anthropic/claude-opus-4-5-20251101
DESCRIBE_MODEL=anthropic/claude-sonnet-4-5-20250929
REVIEW_AGENT_SECURITY_MODEL=anthropic/claude-opus-4-5-20251101
```

## Runtime Mode

DRS uses Pi in-process runtime only. No runtime endpoint configuration is required.
