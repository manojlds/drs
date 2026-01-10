# Claude.md - DRS Repository Guide

## Project Overview

**DRS (Diff Review System)** is an AI-powered code review bot for GitLab Merge Requests and GitHub Pull Requests, built on the OpenCode SDK and powered by Claude AI. The system uses specialized AI agents to provide comprehensive code reviews focusing on security, quality, style, and performance.

### Key Features
- Multi-platform support (GitLab MRs and GitHub PRs)
- Specialized review agents with distinct focuses
- Multiple deployment modes (CI/CD, webhook server, local CLI)
- Markdown-based agent definitions for easy customization
- Native OpenCode SDK integration

## Architecture

### Core Technologies
- **Runtime**: Node.js 20+ (TypeScript)
- **AI Framework**: OpenCode SDK (@opencode-ai/sdk)
- **AI Model**: Claude (via Anthropic API)
- **GitLab Integration**: @gitbeaker/node
- **GitHub Integration**: @octokit/rest
- **Web Server**: Hono (for webhook mode)
- **Job Queue**: BullMQ + Redis (for webhook mode)
- **CLI**: Commander.js
- **Git Operations**: simple-git

### Design Principles
1. **Markdown-Based Agents**: All review agents are defined as markdown files with YAML frontmatter
2. **Subagent Architecture**: Specialized reviewers invoked as subagents by orchestrator agents
3. **Repository Customization**: Projects can override default agents in `.drs/agents/` or `.opencode/agent/`
4. **Multiple Deployment Modes**: Flexible deployment supporting CI/CD, webhooks, and local usage
5. **OpenCode Native**: Built directly on OpenCode SDK, not as a wrapper

## Directory Structure

```
drs/
├── .opencode/                    # OpenCode configuration and agents
│   ├── agent/
│   │   ├── review/              # Specialized review agents
│   │   │   ├── security.md      # Security vulnerability detection
│   │   │   ├── quality.md       # Code quality analysis
│   │   │   ├── style.md         # Style and conventions
│   │   │   └── performance.md   # Performance optimization
│   │   ├── gitlab-reviewer.md   # GitLab MR orchestrator
│   │   ├── github-reviewer.md   # GitHub PR orchestrator
│   │   └── local-reviewer.md    # Local diff reviewer
│   └── opencode.jsonc           # OpenCode configuration
│
├── src/
│   ├── cli/                     # CLI commands
│   │   ├── index.ts            # Main CLI entry point
│   │   ├── init.ts             # Project initialization
│   │   ├── review-mr.ts        # GitLab MR review command
│   │   ├── review-pr.ts        # GitHub PR review command
│   │   └── review-local.ts     # Local diff review command
│   │
│   ├── gitlab/                  # GitLab integration
│   │   ├── client.ts           # GitLab API client
│   │   ├── diff-parser.ts      # MR diff parsing
│   │   └── comment-formatter.ts # Comment formatting
│   │
│   ├── github/                  # GitHub integration
│   │   └── client.ts           # GitHub API client
│   │
│   ├── opencode/                # OpenCode SDK integration
│   │   ├── client.ts           # OpenCode client wrapper
│   │   └── agent-loader.ts     # Agent discovery and loading
│   │
│   ├── ci/                      # CI/CD integration
│   │   └── runner.ts           # CI environment detection
│   │
│   └── lib/                     # Shared utilities
│       └── config.ts           # Configuration management
│
├── examples/                    # Example configurations
├── ARCHITECTURE.md             # Detailed architecture documentation
├── DESIGN.md                   # Original design document
└── DEVELOPMENT.md              # Development and testing guide
```

## Key Components

### 1. Review Agents (.opencode/agent/)

**Orchestrator Agents:**
- `gitlab-reviewer.md` - Main GitLab MR review coordinator
- `github-reviewer.md` - Main GitHub PR review coordinator
- `local-reviewer.md` - Local diff analysis coordinator

**Specialized Review Agents:**
- `review/security.md` - Detects security vulnerabilities (OWASP Top 10, injection attacks, auth issues)
- `review/quality.md` - Analyzes code quality (design patterns, complexity, error handling)
- `review/style.md` - Checks code style (naming, formatting, documentation, TypeScript types)
- `review/performance.md` - Identifies performance issues (algorithmic complexity, caching, concurrency)

### 2. CLI Commands (src/cli/)

- `drs init` - Initialize DRS in a project
- `drs review-local` - Review local git changes
- `drs review-mr` - Review specific GitLab MR
- `drs review-pr` - Review specific GitHub PR

### 3. Integration Clients

**GitLab Client (src/gitlab/client.ts):**
- Fetches MR details and diffs
- Posts review comments
- Handles GitLab API authentication

**GitHub Client (src/github/client.ts):**
- Fetches PR details and diffs
- Posts review comments
- Handles GitHub API authentication

**OpenCode Client (src/opencode/client.ts):**
- Manages OpenCode server connection
- Invokes review agents
- Handles in-process or remote OpenCode server

### 4. Configuration System (src/lib/config.ts)

Configuration is loaded from multiple sources (in order of precedence):
1. `.drs/drs.config.yaml` - DRS-specific config
2. `.gitlab-review.yml` - Alternative location
3. `.opencode/opencode.jsonc` - OpenCode config
4. Environment variables

**Key Configuration Options:**
- `review.agents` - Which agents to run
- `review.ignorePatterns` - Files/patterns to exclude
- Custom agent overrides

## Development Workflow

### Setup
```bash
npm install                    # Install dependencies
npm run build                 # Build TypeScript
npm test                      # Run tests
npm run dev                   # Development mode with watch
```

### Testing
- Test framework: Vitest
- Test files: `*.test.ts` alongside source files
- Run tests: `npm test`

### Building
```bash
npm run build                 # Compile TypeScript to dist/
```

### Local Testing
```bash
# Test local review
npm run dev -- review-local

# Test GitLab MR review
npm run dev -- review-mr --project org/repo --mr 123

# Test GitHub PR review
npm run dev -- review-pr --owner octocat --repo hello-world --pr 456
```

## Important Patterns and Conventions

### 1. Agent Invocation Pattern
Orchestrator agents invoke specialized review agents as subagents:
```typescript
// Example: gitlab-reviewer.md invokes review/security.md
invoke_agent("review/security", { diff: mrDiff })
```

### 2. Configuration Merging
The config system merges settings from multiple sources with proper precedence.
See: `src/lib/config.ts`

### 3. Diff Parsing
GitLab and GitHub diffs are parsed into a standardized format for agent consumption.
See: `src/gitlab/diff-parser.ts`

### 4. Comment Formatting
Review comments are formatted differently for GitLab vs GitHub based on their API requirements.
See: `src/gitlab/comment-formatter.ts`

### 5. OpenCode Server Modes
- **In-process**: DRS starts OpenCode server automatically (requires OpenCode CLI installed)
- **Remote**: DRS connects to existing OpenCode server (set `OPENCODE_SERVER` env var)

## Environment Variables

### Required (depending on platform)
```bash
GITLAB_TOKEN=glpat-xxx          # For GitLab MR reviews
GITHUB_TOKEN=ghp-xxx            # For GitHub PR reviews

# Provider API Keys (set the one for your chosen model provider)
ANTHROPIC_API_KEY=sk-ant-xxx    # For Anthropic Claude models
ZHIPU_API_KEY=xxx               # For ZhipuAI GLM models
OPENAI_API_KEY=sk-xxx           # For OpenAI models
```

### Optional
```bash
OPENCODE_SERVER=http://localhost:3000  # Leave empty for in-process mode
GITLAB_URL=https://gitlab.com          # Custom GitLab instance
REVIEW_AGENTS=security,quality         # Override default agents
```

## Common Development Tasks

### Adding a New Review Agent
1. Create markdown file in `.opencode/agent/review/`
2. Add YAML frontmatter with description and model
3. Write agent instructions in markdown
4. Update orchestrator agents to invoke new agent

### Adding a New CLI Command
1. Create command file in `src/cli/`
2. Add command to `src/cli/index.ts`
3. Implement command logic using OpenCode client
4. Add tests

### Modifying Configuration Schema
1. Update types in `src/lib/config.ts`
2. Update config merging logic
3. Update validation
4. Document in README.md

### Updating Integration APIs
1. GitLab: Update `src/gitlab/client.ts`
2. GitHub: Update `src/github/client.ts`
3. Ensure backward compatibility
4. Add tests for new API features

## Testing Strategy

### Unit Tests
- Configuration loading and merging: `src/lib/config.test.ts`
- Diff parsing logic
- Comment formatting

### Integration Tests
- Full review workflow with mock OpenCode server
- GitLab/GitHub API interactions with mocks
- CLI command execution

### Manual Testing
See `DEVELOPMENT.md` for comprehensive local testing instructions including:
- Local diff reviews
- GitLab MR reviews with test projects
- GitHub PR reviews with test repositories
- Agent customization testing

## Dependencies to Watch

### Critical Dependencies
- `@opencode-ai/sdk` - Core framework, breaking changes impact entire system
- `@anthropic-ai/sdk` - Claude API, model changes may affect agent performance
- `@gitbeaker/node` - GitLab API, updates may add new features
- `@octokit/rest` - GitHub API, updates may add new features

### Version Requirements
- Node.js: >=20.0.0 (required for modern TypeScript features)
- Git: >=2.30 (required for local review mode)
- OpenCode CLI: Latest version (required even for in-process mode)

## Documentation Files

- **README.md** - User-facing documentation and quick start
- **ARCHITECTURE.md** - Detailed technical architecture (OpenCode SDK approach)
- **DESIGN.md** - Original design document (Claude Agent SDK approach, historical)
- **DEVELOPMENT.md** - Local development and testing guide
- **Claude.md** (this file) - AI assistant guide for working with this codebase

## Security Considerations

1. **API Tokens**: Never commit tokens, use environment variables
2. **Input Validation**: Validate all user inputs and API responses
3. **Agent Safety**: Review agents should detect but not introduce security issues
4. **Rate Limiting**: Respect GitLab/GitHub API rate limits
5. **Secrets in Code**: Review agents check for exposed secrets in diffs

## Known Limitations

1. Large diffs may hit OpenCode/Claude context limits
2. Binary files cannot be reviewed
3. Some GitLab/GitHub features may not be supported
4. In-process mode requires OpenCode CLI to be globally installed

## Getting Help

- **Issues**: https://github.com/manojlds/drs/issues
- **Documentation**: See docs/ directory and markdown files
- **OpenCode Docs**: https://opencode.ai/docs
- **GitLab API Docs**: https://docs.gitlab.com/ee/api/
- **GitHub API Docs**: https://docs.github.com/en/rest

## Contributing Guidelines

1. Follow existing code patterns and conventions
2. Add tests for new features
3. Update relevant documentation
4. Ensure TypeScript compiles without errors
5. Run linter before committing: `npm run lint`
6. Keep agents focused on their specific domain
7. Maintain backward compatibility when possible

---

**Last Updated**: 2026-01-09
**Repository**: https://github.com/manojlds/drs
