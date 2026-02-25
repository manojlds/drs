# Custom Agents, Skills & Context

DRS ships with built-in review agents (security, quality, style, performance, documentation) under `.pi/agents/review/`. You can customize every aspect of the review pipeline without modifying DRS itself.

## Quick Reference

| What | Where | Effect |
|------|-------|--------|
| Override a built-in agent | `.drs/agents/<name>/agent.md` | Replaces the built-in prompt entirely |
| Add context to a built-in agent | `.drs/agents/<name>/context.md` | Injected alongside the built-in prompt |
| Create a new agent | `.drs/agents/<name>/agent.md` + add to config | Runs as an additional reviewer |
| Global project context | `.drs/context.md` | Injected into every agent's prompt |
| Custom skill | `.drs/skills/<name>/SKILL.md` | Available to agents via config |

---

## Overriding Built-in Agents

Create `.drs/agents/<name>/agent.md` where `<name>` matches a built-in agent (e.g., `security`, `quality`):

```bash
mkdir -p .drs/agents/security
```

```markdown
<!-- .drs/agents/security/agent.md -->
---
description: Custom security reviewer for our fintech stack
model: anthropic/claude-sonnet-4-5-20250929
tools:
  Read: true
  Grep: true
  Bash: false
---

You are a security reviewer specializing in fintech applications.

## Focus Areas
- PCI-DSS compliance in payment flows
- JWT token handling and expiry
- SQL injection in our ORM layer (TypeORM)
- Rate limiting on public endpoints
```

The override **completely replaces** the built-in prompt. The frontmatter supports:

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Agent description (shown in logs) |
| `model` | string | Model override (e.g., `anthropic/claude-sonnet-4-5-20250929`) |
| `color` | string | Hex color for display (e.g., `"#E53E3E"`) |
| `hidden` | boolean | Hide from agent listings |
| `tools` | object | Per-agent tool overrides (see [Tools](#per-agent-tools)) |

---

## Adding Context to Built-in Agents

If you want to keep the built-in prompt but add project-specific guidance, create a `context.md`:

```bash
mkdir -p .drs/agents/quality
```

```markdown
<!-- .drs/agents/quality/context.md -->
# Quality Agent Context

## Project-Specific Rules
- Functions over 200 lines should be flagged HIGH, not MEDIUM
- We use TypeORM — flag raw SQL queries
- Ignore console.log in CLI files (src/cli/)
- Our error handling pattern: try-catch with graceful fallback + log
```

This context is **injected alongside** the built-in quality prompt, not replacing it. You can have both `agent.md` (override) and `context.md` in the same directory — but if `agent.md` exists, it takes precedence and `context.md` is not used.

---

## Creating Brand New Agents

You can add agents that don't correspond to any built-in:

```bash
mkdir -p .drs/agents/api-reviewer
```

```markdown
<!-- .drs/agents/api-reviewer/agent.md -->
---
description: REST API contract reviewer
tools:
  Read: true
  Grep: true
---

You review REST API changes for backward compatibility.

## Check For
- Breaking changes to request/response schemas
- Missing API versioning
- Undocumented endpoints
- Missing rate limiting
- Inconsistent error response format
```

Then add it to your config:

```yaml
# .drs/drs.config.yaml
review:
  agents:
    - security
    - quality
    - api-reviewer  # Your custom agent
```

Custom agents are auto-prefixed with `review/` internally (becomes `review/api-reviewer`). They're validated at startup — if an agent in `review.agents` doesn't have a corresponding definition, DRS throws an error listing available agents.

---

## Global Project Context

`.drs/context.md` is injected into **every** agent's prompt (both built-in and custom):

```markdown
<!-- .drs/context.md -->
# Project Context

## What This Project Is
Node.js microservice for payment processing. Uses TypeORM, Express, Redis.

## Architecture
- `src/api/` — REST endpoints
- `src/services/` — Business logic
- `src/models/` — TypeORM entities

## Review Focus
- Review only the diff and its direct impact
- Prioritize correctness, safety, and clarity
```

This is useful for giving all agents shared knowledge about your project structure, conventions, and priorities.

---

## Per-Agent Tools

Agent frontmatter can enable or disable specific tools. Per-agent settings override the global tool config:

```markdown
---
tools:
  Read: true    # Can read files
  Grep: true    # Can search with grep
  Bash: false   # Cannot run shell commands
  Edit: false   # Cannot edit files (default)
  Write: false  # Cannot write files (default)
  Glob: true    # Can list/find files
---
```

**Global defaults** (set in `src/runtime/client.ts`):

| Tool | Default | Description |
|------|---------|-------------|
| `Read` | ✅ enabled | Read file contents |
| `Bash` | ✅ enabled | Execute shell commands |
| `Grep` | ✅ enabled | Search file contents |
| `Glob` | ✅ enabled | Find/list files |
| `Edit` | ❌ disabled | Edit files in place |
| `Write` | ❌ disabled | Write new files |

Per-agent overrides only affect that agent's session. Other agents still use the global config.

---

## Per-Agent Skills

Skills are reusable instruction sets that agents can load. Configure them per-agent or as defaults:

### Skill Definition

```markdown
<!-- .drs/skills/sql-patterns/SKILL.md -->
---
name: sql-patterns
description: SQL injection pattern detection rules
---

# SQL Injection Patterns

When reviewing database code, check for:
- String concatenation in SQL queries
- Missing parameterized queries
- Raw SQL in ORM calls (e.g., `query()` instead of query builder)
- User input passed directly to `WHERE` clauses
```

### Config: Default Skills (All Agents)

```yaml
review:
  default:
    skills:
      - sql-patterns   # Loaded by every agent
```

### Config: Per-Agent Skills

```yaml
review:
  agents:
    - name: security
      skills:
        - sql-patterns      # Only for security agent
        - auth-bypass
    - quality               # Uses only default skills
```

Per-agent skills are **merged** with default skills. If `default.skills` is `['baseline']` and security has `skills: ['sql-patterns']`, then security gets both `['baseline', 'sql-patterns']`.

### Skill Search Paths

Skills are discovered from:
1. `.drs/skills/` — project-level (takes precedence)
2. `.pi/skills/` — Pi-native skills

Override with:
```yaml
review:
  paths:
    skills: config/review-skills
```

---

## Config Reference

Full agent configuration example:

```yaml
# .drs/drs.config.yaml
review:
  # Default model and skills for all agents
  default:
    model: anthropic/claude-sonnet-4-5-20250929
    skills:
      - cli-testing

  # Review mode: multi-agent | unified | hybrid
  mode: multi-agent

  # Agents to run
  agents:
    # Simple format (uses default model, no per-agent skills)
    - security
    - quality

    # Detailed format (per-agent model and skills)
    - name: style
      model: openai/gpt-4o
    - name: api-reviewer
      skills:
        - rest-conventions

  # Files to skip
  ignorePatterns:
    - "*.test.ts"
    - "package-lock.json"

  # Custom agent/skill paths (optional)
  paths:
    agents: config/agents
    skills: config/skills
```

---

## Resolution Order

When DRS loads an agent named `security`:

1. Check `.drs/agents/security/agent.md` — if found, use as **full override**
2. Otherwise, use built-in `.pi/agents/review/security.md`
3. Check `.drs/agents/security/context.md` — if found, **inject alongside** built-in prompt
4. Load `.drs/context.md` — inject **global context** into prompt
5. Apply per-agent `tools` from frontmatter (overriding global tool config)
6. Load per-agent `skills` merged with `default.skills`

---

## Examples

### Minimal: Just Add Context

```
.drs/
  context.md               # "We use PostgreSQL and Express"
  drs.config.yaml          # Default agents
```

### Override + New Agent

```
.drs/
  context.md
  drs.config.yaml          # agents: [security, quality, api-reviewer]
  agents/
    security/
      agent.md             # Full override of security agent
    quality/
      context.md           # Extra context for quality (keeps built-in)
    api-reviewer/
      agent.md             # Brand new agent
  skills/
    rest-conventions/
      SKILL.md             # Custom skill for api-reviewer
```

Config:
```yaml
review:
  default:
    model: anthropic/claude-sonnet-4-5-20250929
  agents:
    - security
    - quality
    - name: api-reviewer
      skills:
        - rest-conventions
```
