# DRS - GitLab Review Bot

An automated code review bot for GitLab Merge Requests powered by OpenCode SDK and Claude AI.

## Features

- **AI-Powered Reviews**: Comprehensive code analysis using Claude's latest models
- **Specialized Agents**: Security, quality, style, and performance review experts
- **Multiple Deployment Modes**: GitLab CI/CD, webhook server, or local CLI
- **Customizable**: Override agents with project-specific rules
- **GitLab Native**: Built specifically for GitLab MRs with full API integration

## Quick Start

### 1. Install

```bash
npm install -g @drs/gitlab-review-bot
```

### 2. Initialize Project

```bash
cd your-project
drs init
```

### 3. Configure Environment

```bash
# Copy example env file
cp .env.example .env

# Edit .env and set:
# - GITLAB_TOKEN: Your GitLab access token (required)
# - OPENCODE_SERVER: URL of your OpenCode instance (optional - will start in-process if not set)
```

**Note**: `OPENCODE_SERVER` is optional. If not provided, DRS will automatically start an OpenCode server in-process. For production deployments or when sharing across multiple tools, you can run a dedicated OpenCode server and set the URL.

### 4. Review Local Changes

```bash
# Review unstaged changes
drs review-local

# Review staged changes
drs review-local --staged

# Use specific agents
drs review-local --agents security,quality
```

## Deployment Modes

### Mode 1: Local CLI

Review code locally before pushing:

```bash
# Review local changes
drs review-local

# Review specific MR
drs review-mr --project my-org/my-repo --mr 123 --post-comments
```

### Mode 2: GitLab CI/CD

Add to your `.gitlab-ci.yml`:

```yaml
include:
  - remote: 'https://raw.githubusercontent.com/your-org/drs/main/templates/gitlab-ci.yml'

ai_review:
  extends: .drs_review
  variables:
    OPENCODE_SERVER: "http://opencode.internal:3000"
```

### Mode 3: Webhook Server

Deploy as a standalone service:

```bash
# Using Docker Compose
cd examples
docker-compose up -d

# Configure GitLab webhook:
# URL: http://your-server:8080/webhook/gitlab
# Events: Merge request events, Comments
```

## OpenCode Server Configuration

DRS supports two modes of OpenCode server operation:

### In-Process Server (Default)

If `OPENCODE_SERVER` is not set, DRS will automatically start an OpenCode server within the same process:

```bash
# No server configuration needed
drs review-local
```

**Pros:**
- Zero configuration required
- Automatic startup/shutdown
- Simpler deployment
- Lower latency

**Cons:**
- Server lifetime tied to CLI process
- Cannot share across multiple tools
- Uses process resources

### Remote Server (Optional)

For production deployments or when sharing across multiple tools, run a dedicated OpenCode server:

```bash
# Set the server URL
export OPENCODE_SERVER=http://opencode.internal:3000
drs review-local
```

**Pros:**
- Persistent server
- Shared across multiple tools
- Better for CI/CD pipelines
- Can be scaled separately

**Cons:**
- Requires separate service setup
- Additional infrastructure

## Architecture

DRS uses OpenCode SDK with markdown-based agent definitions:

```
.opencode/
├── agent/
│   ├── gitlab-reviewer.md       # Main orchestrator
│   ├── local-reviewer.md        # Local diff reviewer
│   └── review/
│       ├── security.md          # Security specialist
│       ├── quality.md           # Code quality expert
│       ├── style.md             # Style checker
│       └── performance.md       # Performance analyzer
└── opencode.jsonc               # Configuration
```

## Customization

### Override Default Agents

Create custom agents in your project:

```bash
# Create custom security agent
mkdir -p .drs/agents
cat > .drs/agents/security.md << 'EOF'
---
description: Custom security reviewer
model: opencode/claude-sonnet-4-5
---

You are a security expert for this specific application.

## Project-Specific Rules
[Add your custom rules here]
EOF
```

### Configure Review Behavior

Edit `.drs/drs.config.yaml`:

```yaml
review:
  agents:
    - security
    - quality
  ignorePatterns:
    - "*.test.ts"
    - "*.md"
```

## Review Agents

### Security Agent

Focuses on:
- OWASP Top 10 vulnerabilities
- Injection attacks (SQL, XSS, Command)
- Authentication/authorization issues
- Sensitive data exposure
- Security misconfigurations

### Quality Agent

Reviews:
- Design patterns and anti-patterns
- Code complexity
- DRY violations
- Error handling
- Code smells

### Style Agent

Checks:
- Naming conventions
- Code formatting
- Documentation quality
- Type safety (TypeScript)
- Unused code

### Performance Agent

Analyzes:
- Algorithmic complexity
- Database query efficiency
- Memory management
- Caching opportunities
- Concurrency issues

## Configuration

### Environment Variables

```bash
# Required
GITLAB_TOKEN=glpat-xxx

# Optional
OPENCODE_SERVER=http://localhost:3000  # Leave empty to start in-process server
GITLAB_URL=https://gitlab.com
REVIEW_AGENTS=security,quality,style,performance
```

### Configuration Files

1. `.drs/drs.config.yaml` - DRS-specific configuration
2. `.gitlab-review.yml` - Alternative location
3. `.opencode/opencode.jsonc` - OpenCode configuration

## Examples

See the `examples/` directory for:
- GitLab CI configuration
- Docker Compose setup
- Custom agent definitions
- Configuration templates

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Development mode
npm run dev
```

## Requirements

- Node.js 20+
- GitLab access token
- Git 2.30+ (for local mode)
- OpenCode server instance (optional - will start in-process if not provided)

## License

Apache-2.0

## Documentation

- [Design Document](DESIGN.md) - Original design using Claude Agent SDK
- [Architecture Document](ARCHITECTURE.md) - OpenCode SDK architecture
- [OpenCode Documentation](https://opencode.ai/docs)
- [GitLab API](https://docs.gitlab.com/ee/api/)

## Contributing

Contributions welcome! Please read the contributing guidelines first.

## Support

- Issues: [GitHub Issues](https://github.com/your-org/drs/issues)
- Discussions: [GitHub Discussions](https://github.com/your-org/drs/discussions)
