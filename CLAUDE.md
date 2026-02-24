# CLAUDE.md - DRS Repository Guide

## ⚠️ CRITICAL: Run Checks After EVERY Change

**MANDATORY**: After making ANY code change, immediately run:

```bash
npm run check:all
```

This single command runs: format → lint:fix → build → test → format:check → lint

**What it does:**
- ✅ Formats code with Prettier
- ✅ Fixes auto-fixable lint issues
- ✅ **Type checks and compiles TypeScript** (via `build` which runs `tsc`)
- ✅ Runs all tests
- ✅ Verifies formatting and linting

**Never push code that fails these checks!** This prevents CI failures and maintains code quality.

---

## Project Overview

**DRS (Diff Review System)** is an AI-powered code review bot for GitLab MRs and GitHub PRs, built on Pi SDK and powered by Claude AI.

**Key Technologies:**
- Node.js 20+ (TypeScript)
- Pi SDK (@mariozechner/pi-coding-agent) — bundled, runs in-process
- Claude AI (via Anthropic API)
- GitLab: @gitbeaker/node
- GitHub: @octokit/rest
- Testing: Vitest

---

## Essential Directory Structure

```
drs/
├── .pi/agents/review/           # Built-in review agent definitions
│   ├── security.md              # Security vulnerabilities
│   ├── quality.md               # Code quality
│   ├── style.md                 # Style & conventions
│   ├── performance.md           # Performance issues
│   ├── documentation.md         # Doc accuracy
│   └── unified-reviewer.md     # Unified review agent
│
├── .drs/                        # Project-level customization
│   ├── drs.config.yaml          # Main configuration
│   ├── context.md               # Global project context (injected into all agents)
│   ├── agents/                  # Custom/override agents
│   │   ├── <name>/agent.md      #   Full agent override
│   │   └── <name>/context.md    #   Additive context for built-in agent
│   └── skills/                  # Custom skills
│       └── <name>/SKILL.md      #   Skill definition
│
├── src/
│   ├── cli/                     # CLI commands (review-local, review-mr, review-pr)
│   ├── gitlab/                  # GitLab API integration
│   ├── github/                  # GitHub API integration
│   ├── runtime/                 # Runtime client, agent loader, path config
│   ├── pi/                      # Pi SDK in-process adapter (sdk.ts)
│   └── lib/                     # Shared utilities (config, review logic, logging)
│
└── docs/                        # User-facing documentation
```

---

## Development Workflow

### Setup
```bash
npm install          # Install dependencies
npm run build        # Build TypeScript
npm test             # Run tests
```

### After EVERY Change
```bash
npm run check:all    # ALWAYS run this after any code change
```

Quick type-check only (if needed):
```bash
npm run type-check   # Runs tsc --noEmit (fast validation)
```

### Local Testing
```bash
npm run dev -- review-local                           # Test local changes
npm run dev -- review-mr --project org/repo --mr 123  # Test GitLab MR
npm run dev -- review-pr --owner user --repo name --pr 456  # Test GitHub PR
```

---

## Configuration

**Config files** (in precedence order):
1. `.drs/drs.config.yaml` - DRS config
2. `.gitlab-review.yml` - Alternative location
3. Environment variables

**Key options:**
- `review.agents` - Which agents to run (security, quality, style, etc.)
- `review.default.model` - Default model for all agents
- `review.default.skills` - Default skills loaded for all agents
- `review.ignorePatterns` - Files/patterns to exclude from review
- `review.mode` - Review mode (`multi-agent`, `unified`, `hybrid`)

---

## Environment Variables

### Required (platform-specific)
```bash
GITLAB_TOKEN=glpat-xxx    # For GitLab MR reviews
GITHUB_TOKEN=ghp-xxx      # For GitHub PR reviews

# Model provider (choose one)
ANTHROPIC_API_KEY=sk-ant-xxx   # For Claude models
ZHIPU_API_KEY=xxx              # For ZhipuAI GLM models
OPENAI_API_KEY=sk-xxx          # For OpenAI models
```

### Optional
```bash
REVIEW_AGENTS=security,quality         # Override agents
```

---

## Custom Agents & Skills

See [docs/CUSTOM_AGENTS.md](docs/CUSTOM_AGENTS.md) for full documentation on:
- Overriding built-in agents with `.drs/agents/<name>/agent.md`
- Adding context to built-in agents with `.drs/agents/<name>/context.md`
- Creating brand new custom agents
- Configuring per-agent skills and tools
- Global project context via `.drs/context.md`
- Custom skill definitions in `.drs/skills/`

---

## Testing with Vitest

**Test framework:** Vitest
**Test files:** `*.test.ts` alongside source files
**Run tests:** `npm test`

**Common patterns:**
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocking modules
vi.mock('./module.js', () => ({
  func: vi.fn(() => 'mocked'),
}));

// Type assertions for test mocks
const mockObj = {
  required: 'value',
  optional: 123,
} as any;  // Use for complex partial types

const config = {
  partial: 'config',
} as unknown as FullType;  // For config objects
```

**Important interface requirements in tests:**
- `SessionMessage`: Must have `id`, `role`, `content`, `timestamp`
- `Session`: Must have `id`, `agent`, `createdAt`
- `CustomProvider`: Must have `npm`, `name`, `models`, `options`

---

## Common Tasks

### Adding a Review Agent
1. Create `.pi/agents/review/newagent.md` (built-in) or `.drs/agents/newagent/agent.md` (project override/custom)
2. Add YAML frontmatter (description, model, tools)
3. Write agent instructions
4. Add agent name to `review.agents` in config
5. **Run `npm run check:all`**

### Adding a CLI Command
1. Create file in `src/cli/`
2. Register in `src/cli/index.ts`
3. Add tests (`.test.ts`)
4. **Run `npm run check:all`**

### Fixing Type Errors
- Type errors are caught during `npm run build` (runs `tsc`)
- Use `npm run type-check` for quick validation
- Fix errors before running tests

### Fixing Lint Errors
```bash
npm run lint:fix     # Auto-fix what's possible
npm run lint         # Check remaining issues
```

---

## Architecture Notes

### Agent Loading Pipeline
1. Built-in agents loaded from `.pi/agents/review/`
2. Custom agents loaded from `.drs/agents/` (auto-prefixed with `review/`)
3. Overrides replace built-in prompts; context.md is additive
4. Per-agent tools from frontmatter override global tool config
5. Per-agent skills merged with `review.default.skills`

### Process Exit Pattern
- Library code uses `exitProcess()` from `src/lib/exit.ts` (testable)
- CLI entry point (`src/cli/index.ts`) uses `process.exit()` directly
- Tests use `installTestExitHandler()` to capture exit codes

### Logging
- `src/lib/logger.ts` provides structured logging (human + JSON formats)
- CI/runtime code (`runner.ts`, `client.ts`) uses `getLogger()`
- CLI display code uses `console` + `chalk` (user-facing terminal output)

---

## Quality Checks Reference

| Command | What It Does |
|---------|--------------|
| `npm run check:all` | **ALL checks** (format + lint + build + test) |
| `npm run format` | Auto-format with Prettier |
| `npm run lint:fix` | Fix auto-fixable lint issues |
| `npm run build` | **Compile TypeScript + type check** |
| `npm run type-check` | Type check only (no build) |
| `npm test` | Run all Vitest tests |
| `npm run format:check` | Verify formatting |
| `npm run lint` | Check linting (errors + warnings) |

**The `build` command includes full type checking via `tsc`** - you don't need to run `type-check` separately if you're running `check:all`.

---

## Key Principles

1. **Run `check:all` after EVERY change** - not just before pushing
2. **All tests must pass** - fix failures immediately
3. **Zero TypeScript errors** - type checking is part of `build`
4. **Minimal warnings** - fix lint warnings when practical
5. **Consistent formatting** - Prettier handles this automatically

---

## Documentation Files

- **README.md** - User guide and quick start
- **ARCHITECTURE.md** - Technical architecture details
- **DEVELOPMENT.md** - Local testing guide
- **docs/CUSTOM_AGENTS.md** - Custom agents, skills, and context guide
- **docs/GITLAB_CI_INTEGRATION.md** - GitLab CI setup
- **docs/GITHUB_ACTIONS_INTEGRATION.md** - GitHub Actions setup
- **docs/MODEL_OVERRIDES.md** - Per-agent model configuration
- **AGENTS.md** - This file (AI assistant reference)

---

## Security Notes

1. **Never commit API tokens** - use environment variables only
2. **Validate inputs** - all user inputs and API responses
3. **Check for secrets** - agents detect exposed secrets in diffs
4. **Respect rate limits** - GitLab/GitHub API limits

---

**Last Updated**: 2026-02-24
**Repository**: https://github.com/manojlds/drs
