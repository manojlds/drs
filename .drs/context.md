# DRS Project Context

## Architecture
DRS (Diff Review System) is a code review automation tool that integrates with GitHub and GitLab. It uses OpenCode agents to perform AI-powered code reviews on pull requests and merge requests.

### Key Components
- **CLI Tool**: Command-line interface for running reviews
- **GitHub Client**: Wrapper around Octokit for GitHub API interactions
- **Review Agents**: Specialized AI agents (security, quality, style, performance)
- **OpenCode Integration**: Uses OpenCode SDK to communicate with AI agents

## Technology Stack
- **Language**: TypeScript (Node.js)
- **GitHub API**: Octokit (@octokit/rest)
- **AI Framework**: OpenCode SDK (@opencode-ai/sdk)
- **CLI Framework**: Commander.js
- **Build Tool**: TypeScript compiler (tsc)

## Trust Boundaries

### Trusted Inputs
- **GitHub API responses**: All PR data, file paths, and diff content come from GitHub's API (already validated)
- **Environment variables**: Tokens and configuration from env vars are standard practice for CLI tools
- **Local file system**: The tool reads files from the local repository (developer's machine)

### User Inputs (Limited)
- **CLI flags**: Owner, repo, PR number, etc. (validated by Commander.js)
- **Configuration files**: `.drs/drs.config.yaml` (YAML parsing with validation)

### NOT Web-Facing
- This is a CLI tool used by developers in trusted environments
- No public web interface or untrusted user inputs
- Not designed to handle malicious or adversarial inputs

## Security Context

### Standard Practices (NOT Security Issues)
- ✅ `process.env.GITHUB_TOKEN` - Correct way to handle GitHub tokens
- ✅ `process.env.OPENCODE_SERVER` - Standard configuration approach
- ✅ File paths from GitHub API - These are validated by GitHub
- ✅ Markdown content in GitHub comments - Safely rendered by GitHub
- ✅ Simple regex for parsing git diffs - No ReDoS risk
- ✅ HTML comments for bot identification - Industry standard (Danger, Reviewdog)

### What Actually Matters
- Command injection if we add shell command execution
- Arbitrary code execution vulnerabilities
- Leaking tokens in logs or error messages
- Path traversal with user-controlled file paths (not GitHub API paths)

## Review Guidelines

### Focus Areas
- Code quality and maintainability
- Proper error handling
- Type safety (avoid `any` types)
- Performance optimizations (parallelization, caching)
- Clear, understandable code

### Avoid Over-Flagging
- Don't flag standard Node.js/TypeScript patterns as security issues
- Don't flag GitHub API usage patterns as security issues
- Consider the CLI tool context when evaluating severity
- Focus on real, actionable issues rather than theoretical concerns
