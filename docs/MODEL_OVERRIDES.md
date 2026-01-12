# Model Configuration

DRS provides flexible model configuration with support for built-in and custom AI providers.

## Quick Start

Run `drs init` to interactively configure your project:

```bash
drs init
```

This will guide you through:
1. Custom provider setup (if needed)
2. Default model selection
3. Agent selection
4. Per-agent model overrides

## Configuration Location

All configuration is in `.drs/drs.config.yaml`:

```yaml
# Optional: Custom provider (only if needed)
opencode:
  provider:
    custom-provider:
      npm: "@ai-sdk/openai-compatible"
      name: "Custom Provider"
      options:
        baseURL: "https://your-api.example.com/v1"
        apiKey: "{env:CUSTOM_API_KEY}"
      models:
        model-name:
          name: "Model Display Name"

review:
  # Required: Default model for all agents
  defaultModel: anthropic/claude-sonnet-4-5-20250929
  
  agents:
    - security
    - quality
    - style
    - performance
```

## Built-in Providers

DRS supports these providers out of the box (via OpenCode SDK):

| Provider | Model Examples | API Key Env Var |
|----------|---------------|-----------------|
| Anthropic | `anthropic/claude-sonnet-4-5-20250929`, `anthropic/claude-opus-4-5-20251101` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai/gpt-4o`, `openai/gpt-4-turbo` | `OPENAI_API_KEY` |
| ZhipuAI | `zhipuai/glm-4.7` | `ZHIPU_API_KEY` |

## Custom OpenAI-Compatible Providers

For internal/custom AI endpoints that are OpenAI-compatible:

```yaml
opencode:
  provider:
    alfa:
      npm: "@ai-sdk/openai-compatible"
      name: "Alfa"
      options:
        baseURL: "https://alfa.gamma.qa.us-west-2.aws.avalara.io/v1"
        apiKey: "{env:OPENAI_API_KEY}"
      models:
        claude-4-sonnet:
          name: "Claude Sonnet 4"

review:
  defaultModel: alfa/claude-4-sonnet
  agents:
    - security
    - quality
```

## Model Override Precedence

Models are selected based on the following precedence (highest to lowest):

1. **Per-agent model in DRS config** (`.drs/drs.config.yaml`)
2. **Environment variable** `REVIEW_AGENT_<NAME>_MODEL`
3. **Default model in DRS config** (`.drs/drs.config.yaml`)
4. **Environment variable** `REVIEW_DEFAULT_MODEL`

## Configuration Examples

### 1. Simple Configuration (All Agents Use Same Model)

```yaml
review:
  defaultModel: anthropic/claude-sonnet-4-5-20250929
  agents:
    - security
    - quality
    - style
    - performance
```

### 2. Per-Agent Model Overrides

```yaml
review:
  defaultModel: zhipuai/glm-4.7
  agents:
    - name: security
      model: anthropic/claude-opus-4-5-20251101  # Premium model for security
    - quality                                     # Uses defaultModel
    - name: style
      model: anthropic/claude-sonnet-4-5-20250929
    - performance                                 # Uses defaultModel
```

Result:
- `security`: Uses Opus (per-agent override)
- `quality`: Uses GLM-4.7 (default)
- `style`: Uses Sonnet (per-agent override)
- `performance`: Uses GLM-4.7 (default)

### 3. Environment Variable Overrides

Set a default for all agents:

```bash
export REVIEW_DEFAULT_MODEL=zhipuai/glm-4.7
```

Override specific agents:

```bash
export REVIEW_AGENT_SECURITY_MODEL=anthropic/claude-opus-4-5-20251101
export REVIEW_AGENT_QUALITY_MODEL=openai/gpt-4o
```

## Environment Variable Naming

Agent-specific environment variables use uppercase names with underscores:

| Agent Name | Environment Variable |
|------------|---------------------|
| `security` | `REVIEW_AGENT_SECURITY_MODEL` |
| `quality` | `REVIEW_AGENT_QUALITY_MODEL` |
| `custom-agent` | `REVIEW_AGENT_CUSTOM_AGENT_MODEL` |

Special characters are replaced with underscores.

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

## Best Practices

1. **Use `drs init`** - Interactive setup ensures correct configuration
2. **Start with defaults** - Use the default model for most agents
3. **Premium for security** - Consider using a more capable model for security reviews
4. **Use env vars for CI/CD** - Different models for dev/staging/prod
5. **Test with cheaper models first** - Verify functionality before using expensive models

## Troubleshooting

### Models not being used?

1. Check precedence order - higher priority configs override lower ones
2. Verify agent names match exactly (case-sensitive)
3. Check environment variables are set correctly
4. Look for typos in model identifiers

### Custom provider not working?

1. Ensure the provider is configured in `opencode.provider` section
2. Verify the base URL is correct
3. Check the API key environment variable is set
4. Confirm the model identifier matches: `provider-name/model-name`

### Want to see which model is used?

When DRS starts, it logs the model configuration:

```
📦 Custom provider configured: alfa
📋 Agent model configuration:
  • review/security: alfa/claude-4-sonnet
  • review/quality: alfa/claude-4-sonnet
```
