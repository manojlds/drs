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

**DRS (Diff Review System)** is an AI-powered code review bot for GitLab MRs and GitHub PRs, built on OpenCode SDK and powered by Claude AI.

**Key Technologies:**
- Node.js 20+ (TypeScript)
- OpenCode SDK (@opencode-ai/sdk)
- Claude AI (via Anthropic API)
- GitLab: @gitbeaker/node
- GitHub: @octokit/rest
- Testing: Vitest

---

## Essential Directory Structure

```
drs/
├── .opencode/agent/review/      # Review agent definitions
│   ├── security.md              # Security vulnerabilities
│   ├── quality.md               # Code quality
│   ├── style.md                 # Style & conventions
│   ├── performance.md           # Performance issues
│   └── documentation.md         # Doc accuracy
│
├── src/
│   ├── cli/                     # CLI commands (review-local, review-mr, review-pr)
│   ├── gitlab/                  # GitLab API integration
│   ├── github/                  # GitHub API integration
│   ├── opencode/                # OpenCode SDK wrapper
│   └── lib/                     # Shared utilities (config, review logic)
│
└── tests/                       # Test files (*.test.ts)
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
3. `.opencode/opencode.jsonc` - OpenCode config
4. Environment variables

**Key options:**
- `review.agents` - Which agents to run (security, quality, style, etc.)
- `review.ignorePatterns` - Files/patterns to exclude from review

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
OPENCODE_SERVER=http://localhost:3000  # Remote server (empty = in-process)
GITLAB_URL=https://gitlab.com          # Custom GitLab instance
REVIEW_AGENTS=security,quality         # Override agents
```

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
1. Create `.opencode/agent/review/newagent.md`
2. Add YAML frontmatter (description, model)
3. Write agent instructions
4. Update config to include new agent

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
- **CLAUDE.md** - This file (AI assistant reference)

---

## Security Notes

1. **Never commit API tokens** - use environment variables only
2. **Validate inputs** - all user inputs and API responses
3. **Check for secrets** - agents detect exposed secrets in diffs
4. **Respect rate limits** - GitLab/GitHub API limits

---

**Last Updated**: 2026-01-17
**Repository**: https://github.com/manojlds/drs
