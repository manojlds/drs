# Model Override Configuration

DRS provides flexible model configuration with a clear precedence order, allowing you to override AI models at multiple levels.

## Precedence Order

Models are selected based on the following precedence (highest to lowest):

1. **Per-agent model in DRS config** (`.drs/drs.config.yaml`)
2. **Environment variable** `REVIEW_AGENT_<NAME>_MODEL`
3. **Default model in DRS config** (`.drs/drs.config.yaml`)
4. **Environment variable** `REVIEW_DEFAULT_MODEL`
5. **Agent config in opencode.jsonc** (`.opencode/opencode.jsonc`)
6. **Global model in opencode.jsonc** (`.opencode/opencode.jsonc`)
7. **OpenCode SDK defaults**

## Configuration Examples

### 1. Simple Configuration (Use OpenCode Defaults)

```yaml
# .drs/drs.config.yaml
review:
  agents:
    - security
    - quality
    - style
    - performance
```

All agents use models from `.opencode/opencode.jsonc`.

---

### 2. Set Default Model for All Agents

```yaml
# .drs/drs.config.yaml
review:
  defaultModel: zhipuai/glm-4.7
  agents:
    - security
    - quality
    - style
    - performance
```

All agents use `zhipuai/glm-4.7`.

---

### 3. Per-Agent Model Overrides

```yaml
# .drs/drs.config.yaml
review:
  defaultModel: zhipuai/glm-4.7
  agents:
    - name: security
      model: anthropic/claude-opus-4-5-20251101
    - quality  # uses defaultModel
    - name: style
      model: anthropic/claude-sonnet-4-5-20250929
    - performance  # uses defaultModel
```

Result:
- `security`: Uses Opus (per-agent override)
- `quality`: Uses GLM-4.7 (default)
- `style`: Uses Sonnet (per-agent override)
- `performance`: Uses GLM-4.7 (default)

---

### 4. Environment Variable Overrides

Set a default for all agents:

```bash
export REVIEW_DEFAULT_MODEL=zhipuai/glm-4.7
```

Override specific agents:

```bash
export REVIEW_AGENT_SECURITY_MODEL=anthropic/claude-opus-4-5-20251101
export REVIEW_AGENT_QUALITY_MODEL=zhipuai/glm-4.7
```

---

### 5. Complete Example with All Levels

```yaml
# .drs/drs.config.yaml
review:
  defaultModel: zhipuai/glm-4.7
  agents:
    - name: security
      model: anthropic/claude-opus-4-5-20251101
    - quality
    - style
```

```bash
# Environment variables
export REVIEW_DEFAULT_MODEL=provider/fallback-model
export REVIEW_AGENT_QUALITY_MODEL=provider/quality-model
```

**Result:**
- `security`: `anthropic/claude-opus-4-5-20251101` (per-agent config wins)
- `quality`: `provider/quality-model` (env var wins over config default)
- `style`: `zhipuai/glm-4.7` (config default wins over env default)

---

## Environment Variable Naming

Agent-specific environment variables use uppercase names with underscores:

- `security` → `REVIEW_AGENT_SECURITY_MODEL`
- `quality` → `REVIEW_AGENT_QUALITY_MODEL`
- `custom-agent` → `REVIEW_AGENT_CUSTOM_AGENT_MODEL`

Special characters are replaced with underscores.

---

## OpenCode Configuration

The `.opencode/opencode.jsonc` file serves as the base configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",

  // Global default (lowest priority)
  "model": "anthropic/claude-opus-4-20250514",

  "agent": {
    "review/security": {
      "model": "zhipuai/glm-4.7"
    },
    "review/quality": {
      "model": "zhipuai/glm-4.7"
    }
  }
}
```

**Note:** Agent markdown frontmatter (`model:` field) has been **removed** to ensure DRS config overrides work properly. Previously, frontmatter models would take precedence over all configuration.

---

## Migration from Frontmatter Models

Previously, agent markdown files had model definitions in their frontmatter:

```markdown
---
description: Security reviewer
model: anthropic/claude-sonnet-4-5-20250929  # ❌ Removed
---
```

This has been **removed** because:
1. Frontmatter models took precedence over all config
2. Prevented users from overriding models via DRS config
3. Required editing multiple files to change models

Now use DRS config or opencode.jsonc instead.

---

## Testing

Comprehensive tests verify the precedence order:

```bash
npm test -- config-model-overrides.test.ts
```

Tests cover:
- No overrides scenario
- Default model application
- Per-agent overrides
- Environment variable precedence
- Mixed configuration scenarios
- Edge cases

---

## Use Cases

### Development: Use Fast/Cheap Models

```yaml
review:
  defaultModel: zhipuai/glm-4.7
```

### Production: Use Premium Models for Critical Agents

```yaml
review:
  defaultModel: zhipuai/glm-4.7
  agents:
    - name: security
      model: anthropic/claude-opus-4-5-20251101
    - quality
    - style
    - performance
```

### CI/CD: Environment-Specific Models

```bash
# In CI environment
export REVIEW_DEFAULT_MODEL=zhipuai/glm-4.7
export REVIEW_AGENT_SECURITY_MODEL=anthropic/claude-opus-4-5-20251101
```

---

## Best Practices

1. **Use DRS config for project defaults** - Keep model configuration in `.drs/drs.config.yaml`
2. **Use env vars for environment-specific overrides** - Different models for dev/staging/prod
3. **Use per-agent overrides sparingly** - Only when specific agents need different models
4. **Document your choices** - Explain why certain agents use specific models
5. **Test with cheaper models first** - Verify functionality before using expensive models

---

## Troubleshooting

### Models not being used?

1. Check precedence order - higher priority configs override lower ones
2. Verify agent names match exactly (case-sensitive)
3. Check environment variables are set correctly
4. Look for typos in model identifiers

### Unexpected API charges?

1. Verify all agent frontmatter `model:` fields are removed
2. Check `.opencode/opencode.jsonc` agent configurations
3. Review environment variables
4. Enable DRS logging to see which models are being used

### Want to see which model is used?

When OpenCode starts, DRS logs:
```
Applied model overrides for agents: security, quality, style, performance
```

---

## Summary

The model override system provides maximum flexibility while maintaining clear precedence rules. You can:

- Set defaults at multiple levels
- Override on a per-agent basis
- Use environment variables for dynamic configuration
- Keep all configuration in one place (DRS config)
- Avoid editing agent markdown files

This design ensures the model override feature is both powerful and predictable.
