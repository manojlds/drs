# Development Guide

This guide covers local development and testing of the DRS project.

## Prerequisites

Before you start, ensure you have the following installed:

1. **Node.js 20+** - Check with `node --version`
2. **npm** - Comes with Node.js
3. **Git 2.30+** - Check with `git --version`
4. **OpenCode CLI** - Required even for in-process mode:
   ```bash
   npm install -g opencode-ai
   ```

## Initial Setup

### 1. Clone and Install Dependencies

```bash
git clone https://github.com/manojlds/drs.git
cd drs
npm install
```

### 2. Environment Configuration

Create a `.env` file in the project root:

```bash
cp .env.example .env
```

Edit `.env` and configure the following:

```bash
# Required: Provider API Key (set the one for your chosen model provider)
ANTHROPIC_API_KEY=sk-ant-your-key-here  # For Anthropic Claude models
# ZHIPU_API_KEY=your-key-here           # For ZhipuAI GLM models
# OPENAI_API_KEY=sk-your-key-here       # For OpenAI models

# Optional: Leave empty to use in-process OpenCode server
# OPENCODE_SERVER=http://localhost:3000

# For GitLab MR testing (optional)
GITLAB_URL=https://gitlab.com
GITLAB_TOKEN=glpat-your-token-here

# For GitHub PR testing (optional)
GITHUB_TOKEN=ghp_your-token-here

# Development mode
NODE_ENV=development
```

**Getting API Keys:**

- **Anthropic API Key**: Get from [Anthropic Console](https://console.anthropic.com/)
- **GitLab Token**: Personal Access Token with `api`, `read_api`, `read_repository` scopes
  - Go to: https://gitlab.com/-/profile/personal_access_tokens
- **GitHub Token**: Personal Access Token (classic) with `repo` scope
  - Go to: https://github.com/settings/tokens

### 3. Build the Project

```bash
npm run build
```

This compiles TypeScript to JavaScript in the `dist/` directory.

## Development Workflow

### Running in Development Mode

Watch mode automatically rebuilds on file changes:

```bash
npm run dev
```

This starts the CLI in watch mode using `tsx`. You can then test commands in another terminal.

### Building for Production

```bash
npm run build
```

### Running Built CLI

After building, you can run the CLI:

```bash
# Using npm start
npm start -- review-local

# Or directly with node
node dist/cli/index.js review-local

# Or link it globally for development
npm link
drs review-local
```

## Testing

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test -- --watch

# Run specific test file
npm test src/lib/config.test.ts

# Run with coverage
npm test -- --coverage
```

### Test Structure

Tests use Vitest and are located alongside source files:

```
src/
├── lib/
│   ├── config.ts
│   └── config.test.ts
├── gitlab/
│   ├── client.ts
│   └── client.test.ts
└── index.test.ts
```

### Writing Tests

Example test structure:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('FeatureName', () => {
  beforeEach(() => {
    // Setup before each test
  });

  afterEach(() => {
    // Cleanup after each test
  });

  it('should do something', () => {
    // Arrange
    const input = 'test';

    // Act
    const result = doSomething(input);

    // Assert
    expect(result).toBe('expected');
  });
});
```

## Local Testing Workflows

### 1. Testing Local Code Review

Review uncommitted changes in a test repository:

```bash
# Create a test directory with git
mkdir test-repo && cd test-repo
git init
echo "console.log('test')" > test.js
git add test.js

# Go back to DRS directory
cd ../drs

# Review unstaged changes in test-repo
node dist/cli/index.js review-local --path ../test-repo

# Review staged changes
node dist/cli/index.js review-local --path ../test-repo --staged

# Test with specific agents
node dist/cli/index.js review-local --path ../test-repo --agents security,quality
```

### 2. Testing GitLab MR Review

Test with a real GitLab MR (requires `GITLAB_TOKEN`):

```bash
# Review a specific MR without posting comments
node dist/cli/index.js review-mr \
  --project your-org/your-repo \
  --mr 123

# Review and post comments (be careful!)
node dist/cli/index.js review-mr \
  --project your-org/your-repo \
  --mr 123 \
  --post-comments

# Use staging GitLab instance
GITLAB_URL=https://gitlab-staging.example.com \
node dist/cli/index.js review-mr \
  --project your-org/your-repo \
  --mr 123
```

### 3. Testing GitHub PR Review

Test with a real GitHub PR (requires `GITHUB_TOKEN`):

```bash
# Review a specific PR without posting comments
node dist/cli/index.js review-pr \
  --owner octocat \
  --repo hello-world \
  --pr 456

# Review and post comments (be careful!)
node dist/cli/index.js review-pr \
  --owner octocat \
  --repo hello-world \
  --pr 456 \
  --post-comments
```

### 4. Testing with OpenCode Server Modes

#### Test In-Process Server (Default)

```bash
# Ensure OPENCODE_SERVER is not set
unset OPENCODE_SERVER

# This will start an OpenCode server in-process
node dist/cli/index.js review-local
```

#### Test with Remote OpenCode Server

```bash
# Start a separate OpenCode server (in another terminal)
opencode serve --port 3000

# Set the server URL
export OPENCODE_SERVER=http://localhost:3000

# Now run DRS commands
node dist/cli/index.js review-local
```

## Linting and Code Quality

### Run Linter

```bash
# Check for linting errors
npm run lint

# Auto-fix linting errors
npm run lint -- --fix
```

### TypeScript Type Checking

```bash
# Type check without building
npx tsc --noEmit
```

## Testing CI/CD Integration Locally

### Testing GitHub Actions Locally

Use [act](https://github.com/nektos/act) to test GitHub Actions:

```bash
# Install act
brew install act  # macOS
# or download from releases

# Test the PR review workflow
act pull_request -W .github/workflows/pr-review.yml

# Test with secrets
act pull_request -W .github/workflows/pr-review.yml \
  -s ANTHROPIC_API_KEY=sk-ant-xxx \
  -s GITHUB_TOKEN=ghp_xxx
```

### Testing GitLab CI Locally

Use [gitlab-runner](https://docs.gitlab.com/runner/):

```bash
# Install gitlab-runner
brew install gitlab-runner  # macOS

# Run a specific job
gitlab-runner exec shell ai_review \
  --env ANTHROPIC_API_KEY=sk-ant-xxx \
  --env GITLAB_TOKEN=glpat-xxx
```

## Debugging

### Enable Verbose Logging

Set debug environment variables:

```bash
# Enable debug mode
DEBUG=drs:* node dist/cli/index.js review-local

# Node.js debugging
NODE_OPTIONS='--inspect' node dist/cli/index.js review-local
```

### Using VS Code Debugger

Create `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug CLI",
      "skipFiles": ["<node_internals>/**"],
      "program": "${workspaceFolder}/src/cli/index.ts",
      "args": ["review-local"],
      "runtimeArgs": ["--loader", "tsx"],
      "envFile": "${workspaceFolder}/.env",
      "console": "integratedTerminal"
    },
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Tests",
      "skipFiles": ["<node_internals>/**"],
      "program": "${workspaceFolder}/node_modules/vitest/vitest.mjs",
      "args": ["run"],
      "console": "integratedTerminal"
    }
  ]
}
```

### Testing OpenCode Integration

Check if OpenCode CLI is working:

```bash
# Check OpenCode version
opencode --version

# Test OpenCode server
opencode serve --port 3000

# In another terminal, test connection
curl http://localhost:3000/health
```

### Inspecting Agent Prompts

The agents are markdown files in `.opencode/agent/`. You can modify them for testing:

```bash
# View the security agent
cat .opencode/agent/review/security.md

# Temporarily modify for testing
cp .opencode/agent/review/security.md .opencode/agent/review/security.md.bak
# Edit security.md with your changes
# Test your changes
node dist/cli/index.js review-local --agents security
# Restore original
mv .opencode/agent/review/security.md.bak .opencode/agent/review/security.md
```

## Common Issues and Solutions

### Issue: "OpenCode CLI not found"

**Solution:**
```bash
npm install -g opencode-ai
which opencode  # Verify installation
```

### Issue: "Provider API key not set"

**Solution:**
```bash
# Check if .env file exists and has the appropriate API key for your provider
cat .env | grep API_KEY

# Set the API key for your chosen provider:
export ANTHROPIC_API_KEY=sk-ant-your-key-here  # For Claude models
# OR
export ZHIPU_API_KEY=your-key-here             # For GLM models
# OR
export OPENAI_API_KEY=sk-your-key-here         # For OpenAI models
```

### Issue: "Build fails with TypeScript errors"

**Solution:**
```bash
# Clean and rebuild
rm -rf dist node_modules package-lock.json
npm install
npm run build
```

### Issue: "Cannot connect to OpenCode server"

**Solution:**
```bash
# If using remote server, check if it's running
curl http://localhost:3000/health

# Or use in-process mode
unset OPENCODE_SERVER
```

### Issue: "GitLab/GitHub API rate limits"

**Solution:**
- Use authentication tokens (they have higher rate limits)
- Test with local mode first
- Wait for rate limit to reset
- Use test instances with fewer restrictions

## Testing Checklist

Before submitting changes, verify:

- [ ] All tests pass: `npm test`
- [ ] No linting errors: `npm run lint`
- [ ] TypeScript compiles: `npm run build`
- [ ] CLI commands work:
  - [ ] `drs review-local` works with test repository
  - [ ] `drs review-local --staged` works
  - [ ] `drs review-local --agents security,quality` works
- [ ] Documentation is updated
- [ ] Changes are committed to feature branch

## Performance Testing

### Measure Review Time

```bash
# Time a local review
time node dist/cli/index.js review-local --path ../test-repo

# Profile with Node.js profiler
node --prof dist/cli/index.js review-local
node --prof-process isolate-*.log > profile.txt
```

### Test with Large Diffs

```bash
# Create a large test file
cd ../test-repo
for i in {1..1000}; do echo "console.log('line $i')" >> large-file.js; done
git add large-file.js

# Test performance
cd ../drs
time node dist/cli/index.js review-local --path ../test-repo
```

## Release Testing

Before releasing a new version:

```bash
# Build production bundle
npm run build

# Test the built CLI
node dist/cli/index.js --version
node dist/cli/index.js --help

# Test installation
npm pack
npm install -g diff-review-system-drs-1.0.0.tgz
drs --version
drs review-local

# Cleanup
npm uninstall -g @diff-review-system/drs
rm diff-review-system-drs-1.0.0.tgz
```

## Contributing

When developing new features:

1. Create a feature branch: `git checkout -b feature/your-feature`
2. Write tests for new functionality
3. Update documentation
4. Test locally using this guide
5. Submit a pull request

## Resources

- [OpenCode SDK Documentation](https://opencode.ai/docs)
- [Vitest Documentation](https://vitest.dev/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [GitLab API Documentation](https://docs.gitlab.com/ee/api/)
- [GitHub API Documentation](https://docs.github.com/en/rest)
- [Anthropic API Documentation](https://docs.anthropic.com/)

## Getting Help

If you encounter issues:

1. Check this development guide
2. Review existing [GitHub Issues](https://github.com/manojlds/drs/issues)
3. Join [GitHub Discussions](https://github.com/manojlds/drs/discussions)
4. Check the [main README](README.md) for general usage
