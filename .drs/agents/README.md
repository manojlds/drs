# DRS Agent Customization

DRS supports three levels of agent customization:

## 1. Global Context (.drs/context.md)

Project-wide context applied to ALL agents. Use this for:
- Architecture overview
- Technology stack
- Trust boundaries
- General review guidelines

## 2. Agent-Specific Context (.drs/agents/{name}/context.md)

**Additive** - Enhances the default agent with project-specific rules.

Example: `.drs/agents/security/context.md`
```markdown
# Security Agent Context

## What NOT to Flag
- process.env for configuration (standard practice)
- Data from trusted APIs

## What TO Flag
- SQL injection vulnerabilities
- XSS in user-facing endpoints
```

## 3. Full Agent Override (.drs/agents/{name}/agent.md)

**Replacement** - Completely replaces the default agent.

Example: `.drs/agents/security/agent.md`
```markdown
---
description: Custom security reviewer
model: claude-sonnet-4-5
tools:
  Read: true
  Grep: true
---

You are a security expert specialized in [your domain].

[Complete custom instructions here]
```

## Custom Agents

Create a new folder for custom agents:
`.drs/agents/rails-reviewer/agent.md`

Then add to `.drs/drs.config.yaml`:
```yaml
review:
  agents:
    - security
    - quality
    - rails-reviewer  # Your custom agent
```

## Future: Skills (Coming Soon)

`.drs/agents/security/skills/python.md`
`.drs/agents/security/skills/nodejs.md`

Skills will be auto-loaded based on detected languages.

## Learn More

- [DRS Documentation](https://github.com/your-org/drs)
- [OpenCode Agent Guide](https://opencode.ai/docs/agents)
