# GitLab MR Review Bot - Design Document

## Overview

An OpenCode SDK (Claude Agent SDK) based automated code review bot for GitLab Merge Requests, inspired by the Claude Code GitHub Action. The bot provides intelligent code review, security analysis, and quality feedback for GitLab MRs and local diffs.

## Objectives

1. **Primary**: Automated MR reviews in GitLab similar to Claude Code GitHub Action
2. **Secondary**: Local diff review capability for pre-push code analysis
3. **Flexibility**: Support multiple deployment modes (CI/CD, webhook server, CLI)
4. **Quality**: Comprehensive review coverage (security, quality, style, performance)
5. **Usability**: Easy setup, clear feedback, configurable behavior

## Architecture Overview

### Three Deployment Modes

```
┌─────────────────────────────────────────────────────────────┐
│                    GitLab MR Review Bot                      │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Mode 1: GitLab CI/CD Pipeline                               │
│  ┌──────────────────────────────────────────────┐           │
│  │ .gitlab-ci.yml → review-bot job → MR comment │           │
│  └──────────────────────────────────────────────┘           │
│                                                               │
│  Mode 2: Webhook Server                                      │
│  ┌──────────────────────────────────────────────┐           │
│  │ GitLab Webhook → Express Server → MR API     │           │
│  └──────────────────────────────────────────────┘           │
│                                                               │
│  Mode 3: Local CLI                                           │
│  ┌──────────────────────────────────────────────┐           │
│  │ $ gitlab-review --diff → Terminal output     │           │
│  └──────────────────────────────────────────────┘           │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Review Engine (`src/review-engine/`)

**Purpose**: Orchestrates the code review process using Claude Agent SDK

**Key Files**:
- `index.ts` - Main entry point
- `reviewer.ts` - Core review logic using Agent SDK
- `diff-parser.ts` - Parse GitLab/git diff formats
- `comment-formatter.ts` - Format review feedback for GitLab

**Responsibilities**:
```typescript
class ReviewEngine {
  // Initialize with Claude Agent SDK client
  async initializeAgent(options: ReviewOptions): Promise<void>

  // Analyze MR or local diff
  async analyzeDiff(diff: GitDiff): Promise<ReviewResult>

  // Generate review comments with line annotations
  async generateReview(analysis: Analysis): Promise<ReviewComment[]>

  // Run specialized review agents (security, quality, style, perf)
  async runSpecializedReviews(files: string[]): Promise<ReviewFindings>
}
```

**Claude Agent SDK Integration**:
```typescript
import { query, ClaudeAgentOptions, AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

const reviewAgents = {
  security: AgentDefinition({
    description: "Security vulnerability specialist",
    prompt: "Review for: injection attacks, auth bypasses, data leaks, OWASP Top 10",
    tools: ["Read", "Glob", "Grep"]
  }),
  quality: AgentDefinition({
    description: "Code quality expert",
    prompt: "Review for: patterns, complexity, maintainability, best practices",
    tools: ["Read", "Glob", "Grep"]
  }),
  style: AgentDefinition({
    description: "Style and documentation specialist",
    prompt: "Review for: style guide, naming, documentation, formatting",
    tools: ["Read", "Glob", "Grep"]
  }),
  performance: AgentDefinition({
    description: "Performance optimization expert",
    prompt: "Review for: inefficiencies, algorithmic improvements, resource usage",
    tools: ["Read", "Glob", "Grep"]
  })
};

// Execute review
for await (const message of query({
  prompt: `Review these files: ${changedFiles.join(', ')}`,
  options: {
    allowedTools: ["Read", "Glob", "Grep", "Task"],
    agents: reviewAgents,
    permissionMode: "bypassPermissions"
  }
})) {
  // Process review results
}
```

### 2. GitLab Integration (`src/gitlab/`)

**Purpose**: Interface with GitLab API for MR operations

**Key Files**:
- `client.ts` - GitLab API client wrapper
- `mr-handler.ts` - MR-specific operations
- `webhook-handler.ts` - Webhook event processing
- `comment-poster.ts` - Post review comments to MRs

**GitLab API Operations**:
```typescript
class GitLabClient {
  // Fetch MR details and diff
  async getMergeRequest(projectId: string, mrIid: number): Promise<MR>
  async getMRDiff(projectId: string, mrIid: number): Promise<GitDiff>
  async getMRChanges(projectId: string, mrIid: number): Promise<FileChange[]>

  // Post review feedback
  async createMRComment(projectId: string, mrIid: number, comment: string): Promise<void>
  async createMRDiscussionThread(projectId: string, mrIid: number, thread: Thread): Promise<void>

  // Handle mentions and labels
  async parseMentions(comment: string): Promise<BotMention | null>
  async hasReviewLabel(mr: MR): Promise<boolean>
}
```

**Webhook Event Handling**:
```typescript
enum GitLabEvent {
  MR_OPENED = 'merge_request:open',
  MR_UPDATED = 'merge_request:update',
  COMMENT_ADDED = 'note',
  LABEL_ADDED = 'merge_request:label'
}

interface WebhookPayload {
  event_type: GitLabEvent;
  object_attributes: MRAttributes;
  project: ProjectInfo;
  user: UserInfo;
}
```

### 3. CI/CD Mode (`src/ci/`)

**Purpose**: Run as GitLab CI/CD job

**Key Files**:
- `ci-runner.ts` - CI environment detection and execution
- `gitlab-ci.yml.template` - Template for user's pipeline

**Example `.gitlab-ci.yml`**:
```yaml
stages:
  - review

ai_code_review:
  stage: review
  image: node:20
  only:
    - merge_requests
  script:
    - npm install -g @your-org/gitlab-review-bot
    - gitlab-review --ci
  variables:
    ANTHROPIC_API_KEY: $ANTHROPIC_API_KEY
    GITLAB_TOKEN: $CI_JOB_TOKEN
```

**CI Runner Logic**:
```typescript
class CIRunner {
  // Detect CI environment (GitLab CI, other CI systems)
  detectEnvironment(): CIEnvironment

  // Get MR context from environment variables
  getMRContext(): { projectId: string, mrIid: number, targetBranch: string }

  // Run review and post results
  async runReview(): Promise<void>
}
```

### 4. Webhook Server Mode (`src/server/`)

**Purpose**: Standalone service listening to GitLab webhooks

**Key Files**:
- `server.ts` - Express/Fastify server
- `routes.ts` - Webhook endpoints
- `auth.ts` - Webhook signature verification

**Server Architecture**:
```typescript
import express from 'express';

const app = express();

// Webhook endpoint
app.post('/webhook/gitlab', async (req, res) => {
  // 1. Verify webhook signature
  if (!verifyWebhookSignature(req)) {
    return res.status(401).send('Unauthorized');
  }

  // 2. Parse event
  const event = parseWebhookEvent(req.body);

  // 3. Check if review needed
  if (!shouldReview(event)) {
    return res.status(200).send('Skipped');
  }

  // 4. Queue review job (async)
  await queueReviewJob(event);

  res.status(202).send('Accepted');
});

// Health check
app.get('/health', (req, res) => res.send('OK'));

app.listen(3000);
```

**Review Job Queue**:
```typescript
// Use BullMQ or similar for job processing
import { Queue, Worker } from 'bullmq';

const reviewQueue = new Queue('reviews');

// Enqueue review
await reviewQueue.add('review-mr', {
  projectId: '123',
  mrIid: 456,
  trigger: 'webhook'
});

// Worker processes reviews
const worker = new Worker('reviews', async (job) => {
  const { projectId, mrIid } = job.data;
  await reviewEngine.reviewMR(projectId, mrIid);
});
```

### 5. Local CLI Mode (`src/cli/`)

**Purpose**: Review local diffs before pushing

**Key Files**:
- `cli.ts` - CLI entry point (Commander.js)
- `local-diff.ts` - Git diff extraction
- `terminal-formatter.ts` - Pretty terminal output

**CLI Commands**:
```bash
# Review unstaged changes
gitlab-review --diff

# Review staged changes
gitlab-review --diff --staged

# Review specific commit range
gitlab-review --diff main..feature-branch

# Review specific files
gitlab-review --diff src/auth.ts src/utils.ts

# Review specific MR (authenticated)
gitlab-review --mr 123 --project my-org/my-repo

# Review with specific agents
gitlab-review --diff --agents security,quality

# Output formats
gitlab-review --diff --format json
gitlab-review --diff --format markdown > review.md
```

**CLI Implementation**:
```typescript
import { Command } from 'commander';
import chalk from 'chalk';

const program = new Command();

program
  .name('gitlab-review')
  .description('AI-powered code review for GitLab MRs and local diffs')
  .version('1.0.0');

program
  .command('diff')
  .description('Review local git diff')
  .option('--staged', 'Review staged changes only')
  .option('--agents <agents>', 'Comma-separated list of review agents')
  .option('--format <format>', 'Output format: terminal, json, markdown', 'terminal')
  .action(async (options) => {
    // 1. Get diff
    const diff = await getGitDiff(options.staged);

    // 2. Run review
    const review = await reviewEngine.analyzeDiff(diff, {
      agents: options.agents?.split(',') || ['security', 'quality']
    });

    // 3. Format output
    const formatter = getFormatter(options.format);
    console.log(formatter.format(review));
  });

program
  .command('mr')
  .description('Review a GitLab MR')
  .requiredOption('--mr <iid>', 'MR IID')
  .requiredOption('--project <id>', 'Project ID or path')
  .action(async (options) => {
    const review = await reviewEngine.reviewMR(options.project, options.mr);
    console.log(formatReview(review));
  });

program.parse();
```

### 6. Configuration System (`src/config/`)

**Purpose**: Flexible configuration via files, env vars, and CLI args

**Configuration Sources** (priority order):
1. CLI arguments
2. Environment variables
3. `.gitlab-review.yml` in repo root
4. `package.json` field
5. Defaults

**Configuration Schema**:
```typescript
interface ReviewConfig {
  // Authentication
  anthropic: {
    apiKey: string;           // ANTHROPIC_API_KEY
    model?: 'opus-4.5' | 'sonnet-4.5' | 'haiku-4.5';  // Default: sonnet-4.5
  };

  gitlab: {
    url: string;              // GITLAB_URL (default: https://gitlab.com)
    token: string;            // GITLAB_TOKEN
    projectId?: string;       // GITLAB_PROJECT_ID
  };

  // Review behavior
  review: {
    agents: string[];         // ['security', 'quality', 'style', 'performance']
    autoReview: boolean;      // Review MRs automatically
    reviewOnMention: boolean; // Review on @bot-name mentions
    reviewOnLabel: string[];  // Labels that trigger review
    ignorePatterns: string[]; // Files to ignore (*.test.ts, *.md)
    includePatterns?: string[]; // Only review these files
  };

  // Agent SDK options
  sdk: {
    allowedTools: string[];   // ['Read', 'Glob', 'Grep']
    permissionMode: 'bypassPermissions' | 'acceptEdits' | 'requirePermissions';
    systemPrompt?: string;    // Custom system prompt
  };

  // Output
  output: {
    format: 'gitlab' | 'terminal' | 'json' | 'markdown';
    verbosity: 'minimal' | 'normal' | 'detailed';
  };

  // Server mode only
  server?: {
    port: number;
    webhookSecret: string;
  };
}
```

**Example `.gitlab-review.yml`**:
```yaml
review:
  agents:
    - security
    - quality
  autoReview: true
  reviewOnMention: true
  reviewOnLabel:
    - needs-review
    - security-review
  ignorePatterns:
    - "*.test.ts"
    - "*.spec.ts"
    - "**/__tests__/**"
    - "*.md"

sdk:
  allowedTools:
    - Read
    - Glob
    - Grep
  permissionMode: bypassPermissions

output:
  format: gitlab
  verbosity: normal
```

### 7. Review Agent Definitions (`src/agents/`)

**Purpose**: Specialized review agents for different concerns

**Agent Structure**:
```typescript
export const securityAgent: AgentDefinition = {
  description: "Security vulnerability and OWASP Top 10 specialist",
  prompt: `You are a security expert reviewing code for vulnerabilities.

Focus on:
- Injection attacks (SQL, NoSQL, Command, XSS, etc.)
- Authentication and authorization bypasses
- Sensitive data exposure and leaks
- XML External Entities (XXE)
- Broken access control
- Security misconfiguration
- Insecure cryptography
- Insufficient logging and monitoring
- Server-side request forgery (SSRF)
- Deserialization vulnerabilities

For each issue:
1. Cite the exact file and line number
2. Explain the vulnerability and potential impact
3. Provide a secure code example
4. Rate severity: CRITICAL, HIGH, MEDIUM, LOW`,

  tools: ["Read", "Glob", "Grep"],

  systemPrompt: {
    type: "preset",
    preset: "claude_code",
    append: "Focus on security vulnerabilities. Be thorough but concise."
  }
};

export const qualityAgent: AgentDefinition = {
  description: "Code quality, patterns, and maintainability expert",
  prompt: `You are a senior engineer reviewing code quality.

Focus on:
- Design patterns and anti-patterns
- Code complexity and cognitive load
- Duplication and DRY violations
- Separation of concerns
- Error handling
- Naming and readability
- Modularity and coupling
- Test coverage gaps
- Technical debt

For each issue:
1. Cite the exact file and line number
2. Explain the problem and why it matters
3. Suggest a better approach with code example
4. Rate importance: HIGH, MEDIUM, LOW`,

  tools: ["Read", "Glob", "Grep"]
};

export const styleAgent: AgentDefinition = {
  description: "Code style, formatting, and documentation specialist",
  prompt: `You are a code style reviewer.

Focus on:
- Style guide compliance
- Naming conventions
- Code formatting inconsistencies
- Documentation quality (JSDoc, comments)
- Unused imports or variables
- Type safety (TypeScript/types)
- Consistent patterns across codebase

For each issue:
1. Cite the exact file and line number
2. Explain the style violation
3. Show the correct style
4. Note if it's blocking or advisory`,

  tools: ["Read", "Glob", "Grep"]
};

export const performanceAgent: AgentDefinition = {
  description: "Performance and optimization expert",
  prompt: `You are a performance engineer reviewing code.

Focus on:
- Algorithmic complexity (O(n²) → O(n log n))
- Inefficient loops and iterations
- Unnecessary database queries (N+1 problems)
- Memory leaks and resource management
- Caching opportunities
- Lazy loading and code splitting
- Bundle size and tree shaking

For each issue:
1. Cite the exact file and line number
2. Explain the performance problem
3. Suggest optimization with code example
4. Quantify potential impact when possible`,

  tools: ["Read", "Glob", "Grep"]
};
```

## Review Workflow

### Workflow Diagram

```
┌─────────────────────────────────────────────────────────┐
│                   Review Triggered                       │
│  (MR opened/updated, @mention, label, or CLI command)    │
└───────────────────┬─────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│              1. Fetch MR/Diff Context                    │
│  • Get changed files and diffs                           │
│  • Parse diff hunks with line numbers                    │
│  • Filter files (ignore patterns)                        │
└───────────────────┬─────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│         2. Initialize Claude Agent SDK Session          │
│  • Configure allowed tools (Read, Glob, Grep)            │
│  • Load review agents (security, quality, etc.)          │
│  • Set permission mode (bypassPermissions)               │
└───────────────────┬─────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│        3. Run Specialized Review Agents (Parallel)       │
│                                                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  Security   │  │   Quality   │  │    Style    │     │
│  │   Agent     │  │    Agent    │  │    Agent    │     │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │
│         │                │                │             │
│         └────────────────┴────────────────┘             │
│                          │                               │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│         4. Consolidate Review Findings                   │
│  • Merge results from all agents                         │
│  • Deduplicate similar findings                          │
│  • Sort by severity and file location                    │
│  • Generate summary and statistics                       │
└───────────────────┬─────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│         5. Format and Post Review Comments               │
│                                                           │
│  GitLab MR: Post as discussion threads with line refs    │
│  CLI: Pretty-print to terminal with colors               │
│  JSON/MD: Write to file or stdout                        │
└───────────────────┬─────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│               6. Update MR Status (Optional)             │
│  • Add 'ai-reviewed' label                               │
│  • Post summary comment with stats                       │
│  • Set approval status if configured                     │
└─────────────────────────────────────────────────────────┘
```

### Review Comment Format

**GitLab MR Discussion Thread Example**:
```markdown
## 🔒 Security Issue - SQL Injection Risk

**File**: `src/api/users.ts:45`
**Severity**: CRITICAL
**Agent**: Security Reviewer

### Problem
User input is directly interpolated into SQL query without sanitization:

\`\`\`typescript
const query = `SELECT * FROM users WHERE id = ${userId}`;
\`\`\`

This allows SQL injection attacks. An attacker could pass `1 OR 1=1` to dump all users.

### Solution
Use parameterized queries:

\`\`\`typescript
const query = 'SELECT * FROM users WHERE id = ?';
const result = await db.query(query, [userId]);
\`\`\`

### References
- [OWASP SQL Injection](https://owasp.org/www-community/attacks/SQL_Injection)
- [Node.js Parameterized Queries](https://node-postgres.com/features/queries)
```

**Terminal Output Example**:
```
🔍 Reviewing 12 files...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Review Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Files reviewed:  12
  Issues found:    8
    🔴 Critical:   1
    🟡 High:       3
    🟠 Medium:     2
    ⚪ Low:        2

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 CRITICAL: SQL Injection Risk
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📁 src/api/users.ts:45

User input directly interpolated into SQL:
  const query = `SELECT * FROM users WHERE id = ${userId}`;

✅ Fix: Use parameterized queries
  const query = 'SELECT * FROM users WHERE id = ?';
  const result = await db.query(query, [userId]);

...
```

## Technology Stack

### Core Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^1.0.0",
    "@gitbeaker/node": "^39.0.0",
    "commander": "^11.0.0",
    "express": "^4.18.0",
    "bullmq": "^4.0.0",
    "redis": "^4.6.0",
    "dotenv": "^16.0.0",
    "yaml": "^2.3.0",
    "chalk": "^5.3.0",
    "ora": "^7.0.0",
    "diff-parser": "^2.0.0",
    "simple-git": "^3.20.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/express": "^4.17.0",
    "typescript": "^5.3.0",
    "vitest": "^1.0.0",
    "tsx": "^4.7.0",
    "eslint": "^8.56.0",
    "@typescript-eslint/eslint-plugin": "^6.19.0",
    "@typescript-eslint/parser": "^6.19.0"
  }
}
```

### Runtime Requirements

- **Node.js**: 18.x or later
- **Redis**: 7.x or later (for webhook server mode with job queue)
- **Git**: 2.30 or later (for local CLI mode)

## Comparison with Existing Solutions

| Feature | This Bot | CodeRabbit | Panto AI | DIY n8n |
|---------|----------|-----------|----------|----------|
| **GitLab Support** | ✅ Native | ✅ | ✅ | ✅ Webhook |
| **Local Diff Review** | ✅ CLI | ❌ | ❌ | ❌ |
| **Self-hosted** | ✅ | ❌ SaaS | ❌ SaaS | ✅ |
| **Claude Opus 4.5** | ✅ Latest | ❌ GPT | ❌ Multiple | ✅ Custom |
| **Open Source** | ✅ | ❌ | ❌ | ✅ |
| **Agent SDK** | ✅ | ❌ | ❌ | ❌ |
| **Customizable Agents** | ✅ | Limited | Limited | ✅ |
| **CI/CD Mode** | ✅ | ✅ | ✅ | ⚠️ Complex |
| **Webhook Server** | ✅ | ✅ | ✅ | ✅ |
| **Cost** | API usage | $$$ | $$$ | API usage |
| **Setup Complexity** | Low | Low | Low | Medium |

**Key Differentiators**:
1. **Local diff review** - Unique capability for pre-push analysis
2. **Claude Agent SDK** - Autonomous agents with specialized review roles
3. **Multiple deployment modes** - CI/CD, webhook, or CLI
4. **Self-hosted option** - No data leaves your infrastructure
5. **Latest Claude models** - Opus 4.5 for maximum intelligence
6. **Fully customizable** - Open source, modify agents and behavior
7. **GitLab native** - Built specifically for GitLab MRs, not a GitHub port

## Implementation Phases

### Phase 1: Core Review Engine (Week 1-2)
- [ ] Set up project structure and TypeScript config
- [ ] Implement diff parser for GitLab/git diffs
- [ ] Integrate Claude Agent SDK with basic query
- [ ] Create security review agent
- [ ] Create quality review agent
- [ ] Implement comment formatter for terminal output
- [ ] Basic configuration system (env vars)

### Phase 2: GitLab MR Integration (Week 2-3)
- [ ] GitLab API client wrapper
- [ ] MR diff fetching and parsing
- [ ] Comment posting to MR discussions
- [ ] Webhook payload parsing
- [ ] Mention detection (@bot-name)
- [ ] Label-based triggers

### Phase 3: CLI Mode (Week 3)
- [ ] CLI framework setup (Commander.js)
- [ ] Local git diff extraction
- [ ] Terminal formatter with colors
- [ ] Multiple output formats (JSON, Markdown)
- [ ] File filtering and patterns

### Phase 4: CI/CD Mode (Week 4)
- [ ] CI environment detection
- [ ] GitLab CI variable extraction
- [ ] CI runner implementation
- [ ] Template .gitlab-ci.yml generation
- [ ] Documentation and examples

### Phase 5: Webhook Server Mode (Week 5)
- [ ] Express server setup
- [ ] Webhook signature verification
- [ ] Job queue (BullMQ + Redis)
- [ ] Worker implementation
- [ ] Health checks and monitoring

### Phase 6: Advanced Features (Week 6)
- [ ] Style and performance agents
- [ ] Configuration file support (.gitlab-review.yml)
- [ ] Ignore patterns and file filtering
- [ ] Session persistence for multi-turn reviews
- [ ] Structured output schemas

### Phase 7: Polish and Deploy (Week 7)
- [ ] Comprehensive testing
- [ ] Error handling and logging
- [ ] Docker container for webhook server
- [ ] Documentation (README, API docs)
- [ ] Example projects
- [ ] npm package publishing

## Security Considerations

### Authentication
- **Anthropic API Key**: Store in secrets, never commit
- **GitLab Token**: Use project or personal access token with minimal scopes
- **Webhook Secret**: Verify all incoming webhooks

### Access Control
- **Read-only tools**: Review agents only use Read, Glob, Grep
- **Permission mode**: `bypassPermissions` for non-interactive reviews
- **File filtering**: Ignore sensitive files (.env, credentials)

### Data Privacy
- **Self-hosted option**: All data stays in your infrastructure
- **Anthropic API**: Review diffs sent to Anthropic (check ToS)
- **Audit logging**: Log all tool usage for compliance

## Configuration Examples

### Minimal Setup (CI/CD)

**.gitlab-ci.yml**:
```yaml
ai_review:
  stage: review
  only:
    - merge_requests
  script:
    - npx @your-org/gitlab-review-bot --ci
  variables:
    ANTHROPIC_API_KEY: $ANTHROPIC_API_KEY
```

### Full Setup (Webhook Server)

**docker-compose.yml**:
```yaml
version: '3.8'
services:
  review-bot:
    image: your-org/gitlab-review-bot:latest
    ports:
      - "3000:3000"
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - GITLAB_URL=https://gitlab.example.com
      - GITLAB_TOKEN=${GITLAB_TOKEN}
      - WEBHOOK_SECRET=${WEBHOOK_SECRET}
      - REDIS_URL=redis://redis:6379
    depends_on:
      - redis

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data

volumes:
  redis-data:
```

**.gitlab-review.yml**:
```yaml
review:
  agents:
    - security
    - quality
  autoReview: true
  reviewOnMention: true
  ignorePatterns:
    - "*.test.ts"
    - "*.md"

sdk:
  allowedTools:
    - Read
    - Glob
    - Grep
  permissionMode: bypassPermissions

output:
  format: gitlab
  verbosity: normal
```

### Local CLI Usage

```bash
# Install globally
npm install -g @your-org/gitlab-review-bot

# Configure
export ANTHROPIC_API_KEY=sk-ant-...

# Review local changes
gitlab-review --diff

# Review specific MR
export GITLAB_TOKEN=glpat-...
gitlab-review --mr 123 --project my-org/my-repo
```

## Success Metrics

### Performance
- Review latency: < 2 minutes for typical MR (< 10 files)
- Parallel agent execution: All agents run concurrently
- API costs: ~$0.10-0.50 per MR depending on size

### Quality
- Issue detection rate: Comparable to senior engineer review
- False positive rate: < 20%
- Actionable feedback: > 80% of suggestions are useful

### Adoption
- Setup time: < 30 minutes from install to first review
- User satisfaction: Positive feedback on review quality
- CI/CD integration: Works with zero config in GitLab CI

## Future Enhancements

### v2.0 Features
- [ ] GitHub support (unify GitHub and GitLab)
- [ ] Interactive review mode (approve/reject suggestions)
- [ ] Auto-fix mode (create commits with fixes)
- [ ] Custom agent creation UI
- [ ] Review history and analytics dashboard
- [ ] Integration with Jira/Linear for issue tracking
- [ ] Multi-language support (currently English-centric)
- [ ] Progressive review (focus on critical files first)

### Advanced Capabilities
- [ ] Learning from past reviews (fine-tuning or RAG)
- [ ] Team-specific coding standards (custom prompts)
- [ ] Incremental reviews (only review new changes)
- [ ] Review quality scoring
- [ ] Integration with SAST/DAST tools
- [ ] Diff-aware suggestions (minimal change recommendations)

## Questions for Clarification

Before starting implementation, I'd like to clarify:

1. **Deployment Priority**: Which mode should we implement first?
   - CI/CD (easiest, GitLab native)
   - Webhook server (flexible, multi-project)
   - CLI (local, offline capable)

2. **GitLab Instance**: Will this primarily target:
   - GitLab.com (SaaS)
   - Self-hosted GitLab
   - Both (need configurable URLs)

3. **Review Scope**: Which agents are most important initially?
   - Security (OWASP, vulnerabilities)
   - Quality (patterns, complexity)
   - Style (formatting, naming)
   - Performance (optimization)

4. **Authentication**: Preferred auth method?
   - Project access token
   - Personal access token
   - OAuth app
   - GitLab App (if available)

5. **Cost Management**: Any budget constraints for Anthropic API usage?
   - File size limits
   - Rate limiting
   - Model selection (Opus vs Sonnet vs Haiku)

6. **Integration**: Need to integrate with existing tools?
   - Existing linters/formatters
   - SAST tools (SonarQube, etc.)
   - Project management (Jira, etc.)

## Next Steps

Once you answer the clarification questions above, I'll:

1. Set up the project structure
2. Initialize TypeScript and dependencies
3. Implement the core review engine with Agent SDK
4. Build the priority deployment mode
5. Create example configurations and documentation
6. Test with real GitLab MRs

---

**Sources**:
- [Claude Code GitHub Actions - Official Documentation](https://code.claude.com/docs/en/github-actions)
- [Claude Agent SDK Quickstart](https://platform.claude.com/docs/en/agent-sdk/quickstart.md)
- [AI Code Review Tools for GitLab (2025 Guide)](https://www.getpanto.ai/blog/ai-code-review-tools-gitlab-merge-requests)
- [Automate GitLab MR Reviews with OpenAI](https://medium.com/@sercan.celenk/automate-gitlab-merge-request-reviews-with-openai-building-simple-an-ai-powered-code-review-system-fa0b2e920ca7)
