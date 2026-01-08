# GitLab MR Review Bot - OpenCode SDK Architecture

## Overview

An automated code review bot for GitLab Merge Requests built on **OpenCode SDK** (@opencode-ai/sdk), using markdown-based agent definitions for specialized review capabilities. Supports both GitLab MR reviews and local diff analysis.

## Core Design Principles

1. **Markdown Agents**: All review agents defined as markdown files with YAML frontmatter
2. **Subagent Architecture**: Specialized reviewers (security, quality, style, perf) as invokable subagents
3. **Repository Customization**: Projects can override/extend agents via `.opencode/agent/` or DRS-specific folders
4. **Multiple Deployment Modes**: GitLab CI/CD, webhook server, and local CLI
5. **OpenCode Native**: Built directly on OpenCode SDK, not wrapping or adapting

## Technology Stack

### Core Dependencies

```json
{
  "dependencies": {
    "@opencode-ai/sdk": "^1.1.7",
    "@gitbeaker/node": "^39.0.0",
    "hono": "^4.0.0",
    "commander": "^12.0.0",
    "bullmq": "^5.0.0",
    "redis": "^4.6.0",
    "zod": "^3.22.0",
    "dotenv": "^16.0.0",
    "chalk": "^5.3.0",
    "simple-git": "^3.22.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.3.0",
    "bun": "^1.0.0",
    "vitest": "^1.2.0"
  }
}
```

### Runtime
- **Node.js/Bun**: 20+ or Bun 1.0+
- **OpenCode**: Running OpenCode server instance
- **Redis**: 7.x (for webhook mode job queue)
- **Git**: 2.30+ (for local mode)

## Project Structure

```
drs/
├── .opencode/                        # OpenCode configuration
│   ├── agent/                        # Review agent definitions (markdown)
│   │   ├── review/                   # Specialized review agents
│   │   │   ├── security.md          # Security vulnerability reviewer
│   │   │   ├── quality.md           # Code quality reviewer
│   │   │   ├── style.md             # Code style reviewer
│   │   │   └── performance.md       # Performance reviewer
│   │   ├── gitlab-reviewer.md       # Main GitLab MR review orchestrator
│   │   └── local-reviewer.md        # Local diff review agent
│   ├── tool/                         # Custom tools (optional)
│   │   └── gitlab.ts                # GitLab API integration tool
│   ├── command/                      # Slash commands
│   │   ├── review-mr.md             # /review-mr command
│   │   └── review-local.md          # /review-local command
│   └── opencode.jsonc               # OpenCode configuration
│
├── src/
│   ├── server/                       # Webhook server (optional)
│   │   ├── index.ts                 # Hono server with webhook endpoints
│   │   ├── gitlab-webhook.ts        # GitLab webhook handler
│   │   └── queue.ts                 # BullMQ job queue
│   │
│   ├── ci/                           # GitLab CI/CD runner
│   │   ├── runner.ts                # CI environment detection & execution
│   │   └── gitlab-ci.template.yml   # Template for user's .gitlab-ci.yml
│   │
│   ├── cli/                          # CLI interface
│   │   ├── index.ts                 # Commander.js CLI entry
│   │   ├── review-mr.ts             # MR review command
│   │   └── review-local.ts          # Local diff review command
│   │
│   ├── gitlab/                       # GitLab integration
│   │   ├── client.ts                # GitLab API wrapper
│   │   ├── mr.ts                    # MR operations
│   │   ├── diff.ts                  # Diff parsing
│   │   └── comment.ts               # Comment posting
│   │
│   ├── opencode/                     # OpenCode SDK integration
│   │   ├── client.ts                # OpenCode client wrapper
│   │   ├── session.ts               # Session management
│   │   └── agent-loader.ts          # Load and discover agents
│   │
│   └── lib/                          # Shared utilities
│       ├── config.ts                # Configuration loading
│       ├── diff-parser.ts           # Git diff parsing
│       └── formatter.ts             # Output formatting
│
├── examples/                         # Example configurations
│   ├── .gitlab-ci.yml               # Example CI config
│   ├── .opencode/                   # Example agent overrides
│   └── docker-compose.yml           # Webhook server deployment
│
├── .opencode.example.jsonc          # Example OpenCode config
├── package.json
├── tsconfig.json
└── README.md
```

## OpenCode Agent Architecture

### Agent Definitions (Markdown Format)

All review agents are defined as markdown files with YAML frontmatter, following OpenCode's standard format.

#### Main Review Orchestrator

**.opencode/agent/gitlab-reviewer.md**:
```markdown
---
description: Main GitLab MR review orchestrator
color: "#FC6D26"
model: opencode/claude-opus-4-5
tools:
  Read: true
  Glob: true
  Grep: true
  Task: true
  gitlab-api: true
---

You are an expert code reviewer analyzing GitLab merge requests.

Your task is to coordinate specialized review agents to provide comprehensive feedback on code changes.

## Review Process

1. **Fetch MR Context**: Get changed files and diffs from GitLab
2. **Invoke Specialized Agents**: Use @review/security, @review/quality, @review/style, @review/performance
3. **Consolidate Findings**: Merge results from all agents
4. **Post Review**: Format and post comments to GitLab MR

## Specialized Agents Available

- **@review/security** - OWASP vulnerabilities, injection attacks, auth issues
- **@review/quality** - Code patterns, complexity, maintainability
- **@review/style** - Formatting, naming, documentation
- **@review/performance** - Optimization opportunities, algorithmic improvements

## Review Workflow

For each file in the MR:

1. Invoke relevant specialized agents based on file type and changes
2. Collect findings from each agent
3. Deduplicate and prioritize issues
4. Generate actionable feedback with line numbers

## Output Format

Post findings as GitLab MR discussion threads with:
- File path and line number references
- Issue severity (CRITICAL, HIGH, MEDIUM, LOW)
- Clear explanation of the problem
- Suggested fix with code example
- References to documentation when applicable

Be thorough but concise. Focus on high-impact issues.
```

#### Security Review Agent

**.opencode/agent/review/security.md**:
```markdown
---
description: Security vulnerability and OWASP Top 10 specialist
color: "#E53E3E"
model: opencode/claude-sonnet-4-5
hidden: false
tools:
  Read: true
  Glob: true
  Grep: true
---

You are a security expert specializing in vulnerability detection and OWASP Top 10 issues.

## Focus Areas

### 1. Injection Attacks
- SQL injection (parameterized queries)
- NoSQL injection
- Command injection (shell escaping)
- XSS (input sanitization, output encoding)
- LDAP/XML injection

### 2. Authentication & Authorization
- Broken authentication flows
- Missing authorization checks
- Insecure session management
- JWT vulnerabilities
- Privilege escalation

### 3. Sensitive Data Exposure
- Hardcoded credentials
- Logging sensitive data
- Missing encryption (data at rest/transit)
- Weak cryptography
- Exposed API keys

### 4. Security Misconfigurations
- Debug mode in production
- Default credentials
- Unnecessary services enabled
- Missing security headers
- Verbose error messages

### 5. Other OWASP Top 10
- Broken access control
- Insecure deserialization
- Using components with known vulnerabilities
- Insufficient logging/monitoring
- SSRF (Server-Side Request Forgery)

## Review Format

For each security issue found:

```
🔒 SECURITY - [Vulnerability Type]
File: [path]:[line]
Severity: CRITICAL | HIGH | MEDIUM | LOW

Problem:
[Clear explanation of the vulnerability]

Risk:
[Potential impact and attack scenario]

Fix:
[Secure code example]

References:
- [OWASP link]
- [CWE link if applicable]
```

## Examples

### SQL Injection

```typescript
// ❌ VULNERABLE
const query = `SELECT * FROM users WHERE id = ${userId}`

// ✅ SECURE
const query = 'SELECT * FROM users WHERE id = ?'
const result = await db.query(query, [userId])
```

### XSS Prevention

```typescript
// ❌ VULNERABLE
element.innerHTML = userInput

// ✅ SECURE
element.textContent = userInput
// or use a sanitization library
element.innerHTML = DOMPurify.sanitize(userInput)
```

### Hardcoded Credentials

```typescript
// ❌ VULNERABLE
const apiKey = "sk-1234567890abcdef"

// ✅ SECURE
const apiKey = process.env.API_KEY
```

Focus on exploitable vulnerabilities. Prioritize issues that could lead to:
- Data breaches
- Unauthorized access
- Code execution
- Denial of service

Be precise with line numbers and provide actionable fixes.
```

#### Quality Review Agent

**.opencode/agent/review/quality.md**:
```markdown
---
description: Code quality, patterns, and maintainability expert
color: "#3182CE"
model: opencode/claude-sonnet-4-5
hidden: false
tools:
  Read: true
  Glob: true
  Grep: true
---

You are a senior software engineer reviewing code quality and maintainability.

## Focus Areas

### 1. Design Patterns
- Identify anti-patterns
- Suggest appropriate design patterns
- SOLID principles violations
- Separation of concerns

### 2. Code Complexity
- Cyclomatic complexity
- Deep nesting (> 3 levels)
- Long functions (> 50 lines)
- Large classes (> 300 lines)

### 3. DRY Violations
- Code duplication
- Similar logic in multiple places
- Extractable common functionality

### 4. Error Handling
- Missing error handling
- Silent failures
- Generic catch blocks
- Proper error propagation

### 5. Testing Gaps
- Untestable code
- Missing edge case handling
- Tight coupling preventing testing

### 6. Code Smells
- Magic numbers/strings
- Long parameter lists
- Feature envy
- Inappropriate intimacy
- Shotgun surgery needed

## Review Format

```
📊 QUALITY - [Issue Type]
File: [path]:[line]
Importance: HIGH | MEDIUM | LOW

Problem:
[Explanation of the issue]

Impact:
[Why this matters for maintainability]

Suggestion:
[Better approach with code example]
```

## Examples

### Reduce Complexity

```typescript
// ❌ HIGH COMPLEXITY
function processUser(user: User) {
  if (user.active) {
    if (user.verified) {
      if (user.subscription === 'premium') {
        if (user.paymentMethod) {
          // deep nesting...
        }
      }
    }
  }
}

// ✅ IMPROVED
function processUser(user: User) {
  if (!user.active) return
  if (!user.verified) return
  if (user.subscription !== 'premium') return
  if (!user.paymentMethod) return

  // clear flow
}
```

### Extract Duplication

```typescript
// ❌ DUPLICATION
function validateEmail(email: string) {
  if (!email || email.length === 0) return false
  if (!email.includes('@')) return false
  return true
}

function validateUsername(username: string) {
  if (!username || username.length === 0) return false
  if (username.length < 3) return false
  return true
}

// ✅ REFACTORED
function validateRequired(value: string): boolean {
  return value && value.length > 0
}

function validateEmail(email: string) {
  return validateRequired(email) && email.includes('@')
}

function validateUsername(username: string) {
  return validateRequired(username) && username.length >= 3
}
```

Be constructive. Focus on issues that impact maintainability, not stylistic preferences.
```

#### Style Review Agent

**.opencode/agent/review/style.md**:
```markdown
---
description: Code style, formatting, and documentation specialist
color: "#805AD5"
model: opencode/claude-haiku-4-5
hidden: false
tools:
  Read: true
  Glob: true
  Grep: true
---

You are a code style reviewer ensuring consistency and documentation quality.

## Focus Areas

### 1. Naming Conventions
- camelCase vs snake_case vs PascalCase
- Descriptive variable names
- Avoid abbreviations
- Boolean names (is/has/should)

### 2. Code Formatting
- Indentation consistency
- Line length (< 100 chars recommended)
- Spacing and alignment
- Import organization

### 3. Documentation
- Missing function/class documentation
- Outdated comments
- JSDoc/TSDoc completeness
- README updates needed

### 4. Type Safety (TypeScript)
- Missing type annotations
- Using `any` unnecessarily
- Proper generic usage
- Interface vs type alias

### 5. Best Practices
- Unused imports/variables
- Console.log statements
- TODO/FIXME comments
- File organization

## Review Format

```
✨ STYLE - [Issue Type]
File: [path]:[line]
Priority: BLOCKING | ADVISORY

Issue:
[Style violation]

Suggestion:
[Corrected version]
```

## Examples

### Naming

```typescript
// ❌ POOR NAMING
const d = new Date()
const usr = getUser()
const f = (x) => x * 2

// ✅ CLEAR NAMING
const currentDate = new Date()
const currentUser = getUser()
const double = (value: number) => value * 2
```

### Documentation

```typescript
// ❌ MISSING DOCS
function calculateDiscount(price: number, code: string) {
  // implementation
}

// ✅ DOCUMENTED
/**
 * Calculates the discounted price based on promo code
 * @param price - Original price in cents
 * @param code - Promotional discount code
 * @returns Discounted price in cents
 * @throws {Error} If promo code is invalid
 */
function calculateDiscount(price: number, code: string): number {
  // implementation
}
```

### Type Safety

```typescript
// ❌ ANY TYPES
function processData(data: any): any {
  return data.map((item: any) => item.value)
}

// ✅ PROPER TYPES
interface DataItem {
  value: string
  id: number
}

function processData(data: DataItem[]): string[] {
  return data.map(item => item.value)
}
```

Focus on consistency with the existing codebase. Check for project-specific style guides.
```

#### Performance Review Agent

**.opencode/agent/review/performance.md**:
```markdown
---
description: Performance and optimization expert
color: "#DD6B20"
model: opencode/claude-sonnet-4-5
hidden: false
tools:
  Read: true
  Glob: true
  Grep: true
---

You are a performance engineer identifying optimization opportunities.

## Focus Areas

### 1. Algorithmic Complexity
- O(n²) → O(n log n) improvements
- Nested loops
- Inefficient array operations
- Recursive vs iterative

### 2. Database Performance
- N+1 query problems
- Missing indexes
- SELECT * instead of specific fields
- Unnecessary joins

### 3. Memory Management
- Memory leaks
- Large object allocations
- Unnecessary data copying
- Stream vs load all

### 4. Caching Opportunities
- Repeated computations
- Static data not cached
- Cache invalidation issues

### 5. Frontend Performance
- Bundle size
- Lazy loading opportunities
- Unnecessary re-renders
- Large image/asset sizes

### 6. Concurrency
- Sequential vs parallel operations
- Missing async/await
- Race conditions
- Deadlock potential

## Review Format

```
⚡ PERFORMANCE - [Issue Type]
File: [path]:[line]
Impact: HIGH | MEDIUM | LOW

Issue:
[Performance problem]

Current Cost:
[Estimated complexity or impact]

Optimization:
[Improved approach with code example]
```

## Examples

### Algorithmic Improvement

```typescript
// ❌ O(n²) - Nested loops
function findDuplicates(arr: number[]): number[] {
  const duplicates = []
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      if (arr[i] === arr[j]) duplicates.push(arr[i])
    }
  }
  return duplicates
}

// ✅ O(n) - Using Set
function findDuplicates(arr: number[]): number[] {
  const seen = new Set<number>()
  const duplicates = new Set<number>()

  for (const num of arr) {
    if (seen.has(num)) {
      duplicates.add(num)
    } else {
      seen.add(num)
    }
  }

  return Array.from(duplicates)
}
```

### N+1 Query Problem

```typescript
// ❌ N+1 QUERIES
async function getUsersWithPosts() {
  const users = await db.users.findMany()

  for (const user of users) {
    user.posts = await db.posts.findMany({
      where: { userId: user.id }
    })
  }

  return users
}

// ✅ SINGLE QUERY WITH JOIN
async function getUsersWithPosts() {
  return await db.users.findMany({
    include: { posts: true }
  })
}
```

### Unnecessary Re-computation

```typescript
// ❌ REPEATED CALCULATION
function expensiveCalculation() {
  return data.map(item => {
    const result = complexComputation(item)
    return {
      value: result,
      doubled: complexComputation(item) * 2 // DUPLICATE!
    }
  })
}

// ✅ CACHED RESULT
function expensiveCalculation() {
  return data.map(item => {
    const result = complexComputation(item)
    return {
      value: result,
      doubled: result * 2
    }
  })
}
```

Focus on measurable improvements. Provide estimated complexity or performance gain when possible.
```

### Local Review Agent

**.opencode/agent/local-reviewer.md**:
```markdown
---
description: Local git diff reviewer for pre-push analysis
color: "#38A169"
model: opencode/claude-sonnet-4-5
tools:
  Read: true
  Glob: true
  Grep: true
  Bash: true
  Task: true
---

You are reviewing local git changes before they are pushed to remote.

## Process

1. **Get Diff**: Extract git diff (staged or unstaged based on user request)
2. **Parse Changes**: Identify modified files and change hunks
3. **Invoke Reviewers**: Call specialized agents based on changes
4. **Format Output**: Present findings in terminal-friendly format

## Output Format

Terminal output with color coding:

```
🔍 Local Diff Review
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 Summary
Files reviewed: 5
Issues found: 3
  🔴 Critical: 1
  🟡 High: 1
  🟠 Medium: 1

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 CRITICAL: SQL Injection
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📁 src/api/users.ts:45

[Details...]

✅ Recommendation: Fix critical issues before pushing
```

Use colored output for terminal visibility. Be concise but actionable.
```

## Custom GitLab Tool

To interact with GitLab API from within OpenCode agents, we create a custom tool.

**src/opencode/tools/gitlab.ts**:
```typescript
import { Tool } from '@opencode-ai/sdk'
import { Gitlab } from '@gitbeaker/node'
import { z } from 'zod'

export const GitLabTool = Tool.define({
  name: 'gitlab-api',
  description: 'Interact with GitLab API for MR operations',

  parameters: z.object({
    operation: z.enum(['getMR', 'getDiff', 'postComment', 'createThread']),
    projectId: z.string(),
    mrIid: z.number().optional(),
    comment: z.string().optional(),
    position: z.object({
      baseSha: z.string(),
      headSha: z.string(),
      startSha: z.string(),
      newPath: z.string(),
      newLine: z.number(),
    }).optional(),
  }),

  async execute({ operation, projectId, mrIid, comment, position }, context) {
    const gitlab = new Gitlab({
      host: process.env.GITLAB_URL || 'https://gitlab.com',
      token: process.env.GITLAB_TOKEN!,
    })

    switch (operation) {
      case 'getMR':
        if (!mrIid) throw new Error('mrIid required')
        return await gitlab.MergeRequests.show(projectId, mrIid)

      case 'getDiff':
        if (!mrIid) throw new Error('mrIid required')
        return await gitlab.MergeRequests.changes(projectId, mrIid)

      case 'postComment':
        if (!mrIid || !comment) throw new Error('mrIid and comment required')
        return await gitlab.MergeRequestNotes.create(projectId, mrIid, comment)

      case 'createThread':
        if (!mrIid || !comment || !position) {
          throw new Error('mrIid, comment, and position required')
        }
        return await gitlab.MergeRequestDiscussions.create(projectId, mrIid, comment, {
          position: {
            position_type: 'text',
            ...position,
          },
        })

      default:
        throw new Error(`Unknown operation: ${operation}`)
    }
  },
})
```

## Configuration

**.opencode/opencode.jsonc**:
```jsonc
{
  "$schema": "https://opencode.ai/config.json",

  // Global instructions (optional)
  "instructions": [
    ".gitlab-review.md"  // Project-specific review guidelines
  ],

  // LLM provider configuration
  "provider": {
    "opencode": {
      "options": {}
    }
  },

  // Custom tools
  "tools": {
    "gitlab-api": true,  // Enable custom GitLab tool
    "Bash": true,
    "Read": true,
    "Write": false,      // Disable writes in review mode
    "Edit": false        // Disable edits in review mode
  },

  // Agents configuration
  "agent": {
    "gitlab-reviewer": {
      "model": "opencode/claude-opus-4-5"
    },
    "review/security": {
      "model": "opencode/claude-sonnet-4-5"
    },
    "review/quality": {
      "model": "opencode/claude-sonnet-4-5"
    },
    "review/style": {
      "model": "opencode/claude-haiku-4-5"  // Faster for style
    },
    "review/performance": {
      "model": "opencode/claude-sonnet-4-5"
    }
  }
}
```

## Repository Customization

Projects can customize review behavior by adding their own agent overrides:

### Option 1: Standard `.opencode/` Directory

```
my-project/
├── .opencode/
│   ├── agent/
│   │   └── review/
│   │       └── security.md      # Project-specific security rules
│   └── opencode.jsonc
```

### Option 2: DRS-Specific Directory

For DRS-based workflows, support a custom agent directory:

```
my-project/
├── .drs/
│   ├── agents/
│   │   ├── security.md          # Override security agent
│   │   └── custom-linter.md     # Additional custom agent
│   └── drs.config.json
```

**Agent Loader Logic** (`src/opencode/agent-loader.ts`):
```typescript
import { createOpencodeClient } from '@opencode-ai/sdk'
import path from 'path'
import fs from 'fs'

export async function loadReviewAgents(projectPath: string) {
  const client = createOpencodeClient({
    directory: projectPath
  })

  // Priority order for agent loading:
  // 1. Project .drs/agents/ (DRS-specific)
  // 2. Project .opencode/agent/ (OpenCode standard)
  // 3. Global ~/.config/opencode/agent/ (fallback)

  const agentPaths = [
    path.join(projectPath, '.drs/agents'),
    path.join(projectPath, '.opencode/agent'),
  ]

  const agents = []

  for (const agentPath of agentPaths) {
    if (fs.existsSync(agentPath)) {
      // Discover markdown agents
      const files = fs.readdirSync(agentPath, { recursive: true })

      for (const file of files) {
        if (file.endsWith('.md')) {
          const agentName = file.replace('.md', '').replace(/\\/g, '/')
          agents.push({
            name: agentName,
            path: path.join(agentPath, file)
          })
        }
      }
    }
  }

  return agents
}
```

## Deployment Modes

### Mode 1: GitLab CI/CD Pipeline

**.gitlab-ci.yml** (User's repository):
```yaml
stages:
  - review

include:
  - remote: 'https://raw.githubusercontent.com/your-org/drs/main/templates/gitlab-review.yml'

ai_code_review:
  stage: review
  only:
    - merge_requests
  variables:
    REVIEW_AGENTS: "security,quality"  # Optional: specific agents
    OPENCODE_SERVER: "http://opencode.internal:3000"  # Your OpenCode server
```

**src/ci/runner.ts**:
```typescript
import { createOpencodeClient } from '@opencode-ai/sdk'
import { GitlabClient } from '../gitlab/client.js'

export async function runCIReview() {
  // Get GitLab CI environment variables
  const projectId = process.env.CI_PROJECT_ID!
  const mrIid = parseInt(process.env.CI_MERGE_REQUEST_IID!)
  const targetBranch = process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME!

  // Connect to OpenCode server
  const opencode = createOpencodeClient({
    baseUrl: process.env.OPENCODE_SERVER || 'http://localhost:3000',
    directory: process.env.CI_PROJECT_DIR,
  })

  // Invoke gitlab-reviewer agent
  const session = await opencode.session.create({
    agent: 'gitlab-reviewer',
    message: `Review MR !${mrIid} in project ${projectId}`
  })

  // Stream results
  for await (const message of opencode.session.messages(session.id)) {
    console.log(message)
  }
}
```

### Mode 2: Webhook Server

**src/server/index.ts**:
```typescript
import { Hono } from 'hono'
import { Queue, Worker } from 'bullmq'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { verifyWebhook } from './gitlab-webhook.js'

const app = new Hono()
const reviewQueue = new Queue('gitlab-reviews', {
  connection: { host: 'redis', port: 6379 }
})

// Webhook endpoint
app.post('/webhook/gitlab', async (c) => {
  const body = await c.req.json()

  // Verify webhook signature
  if (!verifyWebhook(c.req.header('x-gitlab-token'), body)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  // Check if review needed
  const event = body.object_kind

  if (event === 'merge_request' && ['open', 'update'].includes(body.object_attributes.action)) {
    // Queue review job
    await reviewQueue.add('review-mr', {
      projectId: body.project.id,
      mrIid: body.object_attributes.iid,
      trigger: 'webhook'
    })

    return c.json({ status: 'queued' }, 202)
  }

  if (event === 'note' && body.merge_request) {
    // Check for bot mention
    const comment = body.object_attributes.note

    if (comment.includes('@gitlab-reviewer')) {
      await reviewQueue.add('review-mr', {
        projectId: body.project.id,
        mrIid: body.merge_request.iid,
        trigger: 'mention'
      })

      return c.json({ status: 'queued' }, 202)
    }
  }

  return c.json({ status: 'ignored' }, 200)
})

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }))

// Worker to process reviews
const worker = new Worker('gitlab-reviews', async (job) => {
  const { projectId, mrIid } = job.data

  // Clone repository temporarily
  const tempDir = `/tmp/review-${projectId}-${mrIid}`
  // ... git clone logic ...

  // Connect to OpenCode
  const opencode = createOpencodeClient({
    baseUrl: process.env.OPENCODE_SERVER!,
    directory: tempDir,
  })

  // Invoke review agent
  const session = await opencode.session.create({
    agent: 'gitlab-reviewer',
    message: `Review MR !${mrIid} in project ${projectId}`
  })

  // Wait for completion and post results
  for await (const message of opencode.session.messages(session.id)) {
    console.log(message)
  }

  // Cleanup
  // ... remove temp dir ...
}, {
  connection: { host: 'redis', port: 6379 }
})

export default app
```

**docker-compose.yml**:
```yaml
version: '3.8'

services:
  opencode:
    image: anomalyco/opencode:latest
    ports:
      - "3000:3000"
    environment:
      - OPENCODE_API_KEY=${ANTHROPIC_API_KEY}
    volumes:
      - opencode-config:/root/.config/opencode
      - ./agents:/workspace/.opencode/agent

  review-bot:
    build: .
    ports:
      - "8080:8080"
    environment:
      - OPENCODE_SERVER=http://opencode:3000
      - GITLAB_URL=${GITLAB_URL}
      - GITLAB_TOKEN=${GITLAB_TOKEN}
      - REDIS_URL=redis://redis:6379
    depends_on:
      - opencode
      - redis

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data

volumes:
  opencode-config:
  redis-data:
```

### Mode 3: Local CLI

**src/cli/index.ts**:
```typescript
import { Command } from 'commander'
import { createOpencodeClient } from '@opencode-ai/sdk'
import chalk from 'chalk'
import simpleGit from 'simple-git'

const program = new Command()

program
  .name('drs')
  .description('GitLab MR review bot powered by OpenCode')
  .version('1.0.0')

program
  .command('review-local')
  .description('Review local git diff')
  .option('--staged', 'Review staged changes only')
  .option('--agents <agents>', 'Comma-separated agent list', 'security,quality')
  .action(async (options) => {
    const git = simpleGit()
    const cwd = process.cwd()

    // Get diff
    const diff = options.staged
      ? await git.diff(['--cached'])
      : await git.diff()

    if (!diff) {
      console.log(chalk.yellow('No changes to review'))
      return
    }

    // Connect to OpenCode
    const opencode = createOpencodeClient({
      baseUrl: process.env.OPENCODE_SERVER || 'http://localhost:3000',
      directory: cwd,
    })

    // Invoke local-reviewer agent
    const session = await opencode.session.create({
      agent: 'local-reviewer',
      message: `Review local diff. Agents: ${options.agents}`
    })

    // Stream results with color
    for await (const message of opencode.session.messages(session.id)) {
      if (message.role === 'assistant') {
        console.log(message.content)
      }
    }
  })

program
  .command('review-mr')
  .description('Review a GitLab MR')
  .requiredOption('--mr <iid>', 'MR IID')
  .requiredOption('--project <id>', 'Project ID or path')
  .action(async (options) => {
    const opencode = createOpencodeClient({
      baseUrl: process.env.OPENCODE_SERVER || 'http://localhost:3000',
    })

    const session = await opencode.session.create({
      agent: 'gitlab-reviewer',
      message: `Review MR !${options.mr} in project ${options.project}`
    })

    for await (const message of opencode.session.messages(session.id)) {
      console.log(message)
    }
  })

program.parse()
```

**Usage**:
```bash
# Review local changes
drs review-local

# Review staged changes only
drs review-local --staged

# Review with specific agents
drs review-local --agents security,performance

# Review remote MR
export GITLAB_TOKEN=glpat-xxx
drs review-mr --project my-org/my-repo --mr 123
```

## Agent Customization Examples

### Project-Specific Security Rules

A project can add custom security requirements:

**my-app/.opencode/agent/review/security.md**:
```markdown
---
description: Security reviewer with project-specific rules
color: "#E53E3E"
model: opencode/claude-sonnet-4-5
---

You are a security expert for this specific application.

## Standard OWASP Checks
[... include base security checks ...]

## Project-Specific Rules

### Custom Authentication
This project uses a custom JWT implementation with:
- RSA-256 signing
- 15-minute expiry
- Refresh token rotation

Check for:
- JWT verification before accessing protected routes
- Proper token expiry handling
- Refresh token must be HTTP-only cookie

### API Rate Limiting
All public API endpoints MUST have rate limiting:
```typescript
app.use('/api', rateLimit({ max: 100, windowMs: 60000 }))
```

### Allowed Dependencies
Only these crypto libraries are approved:
- `crypto` (Node.js built-in)
- `bcrypt` for password hashing
- DO NOT use: md5, sha1, or custom crypto implementations

Flag any other crypto library usage as CRITICAL.
```

### DRS-Specific Reviewer

For DRS workflow integration:

**my-app/.drs/agents/drs-reviewer.md**:
```markdown
---
description: DRS workflow integration reviewer
color: "#2D3748"
model: opencode/claude-sonnet-4-5
tools:
  Read: true
  Bash: true
  gitlab-api: true
---

You are a DRS-aware code reviewer.

## DRS Integration Checks

1. **Workflow Files**: Check `.drs/workflows/*.yml` for correctness
2. **Agent Definitions**: Validate `.drs/agents/*.md` syntax
3. **Configuration**: Ensure `.drs/drs.config.json` is valid
4. **Hooks**: Review any DRS hooks for security issues

## DRS Best Practices

- Agents should have clear, focused responsibilities
- Workflows should be idempotent
- No secrets in DRS configuration files
- Use environment variable references

Flag any DRS-specific misconfigurations.
```

## Review Workflow

### Typical Review Flow

```
1. Trigger (MR opened, webhook, CLI command)
        ↓
2. Load Project Context
   - Clone repo (webhook) or use local (CLI/CI)
   - Discover .opencode/agent/ or .drs/agents/
   - Load opencode.jsonc configuration
        ↓
3. Initialize OpenCode Client
   - Connect to OpenCode server
   - Set project directory
   - Load custom tools (gitlab-api)
        ↓
4. Create Review Session
   - Agent: gitlab-reviewer (or local-reviewer)
   - Context: MR details or local diff
        ↓
5. Agent Orchestration
   gitlab-reviewer invokes:
   - @review/security
   - @review/quality
   - @review/style
   - @review/performance

   (Agents run in parallel using Task tool)
        ↓
6. Consolidate Results
   - Merge findings from all agents
   - Deduplicate issues
   - Sort by severity and file
        ↓
7. Post Review
   - GitLab MR: Post discussion threads
   - CLI: Print to terminal with colors
        ↓
8. Cleanup
   - Close session
   - Remove temp directories (webhook mode)
```

### Agent Invocation Pattern

The main `gitlab-reviewer` agent coordinates specialized agents:

```markdown
## In gitlab-reviewer.md prompt:

To review the MR, invoke specialized agents:

1. Security review:
   @review/security Please review these files for vulnerabilities: [file list]

2. Quality review:
   @review/quality Check these files for code quality issues: [file list]

3. Style review:
   @review/style Verify style consistency in: [file list]

4. Performance review:
   @review/performance Look for optimization opportunities in: [file list]

Consolidate their findings and post to GitLab.
```

## Comparison with Claude Agent SDK Approach

| Aspect | OpenCode SDK | Claude Agent SDK |
|--------|-------------|------------------|
| **Agent Definition** | Markdown files with frontmatter | TypeScript/Python code |
| **Customization** | Drop markdown files in `.opencode/` | Code changes required |
| **Distribution** | Copy markdown files | npm/pip packages |
| **Learning Curve** | Markdown + YAML | Full SDK API |
| **Flexibility** | High (prompt engineering) | High (programmatic) |
| **Team Editing** | Non-coders can edit agents | Developers only |
| **Version Control** | Simple markdown diffs | Code diffs |
| **Hot Reload** | Yes (file-based) | Requires restart |

**Key Advantages**:
- **Non-technical edits**: Security teams can update security rules without coding
- **Repository-specific**: Each project customizes agents via markdown
- **Simple distribution**: Share agents as markdown files
- **OpenCode native**: Leverages full OpenCode ecosystem (TUI, Desktop, IDE)

## Configuration Examples

### Minimal Setup

```bash
# 1. Install DRS CLI
npm install -g @your-org/drs

# 2. Configure environment
export OPENCODE_SERVER=http://localhost:3000
export GITLAB_TOKEN=glpat-xxx

# 3. Review local changes
drs review-local
```

### Full GitLab CI/CD Setup

```yaml
# .gitlab-ci.yml
include:
  - remote: 'https://raw.githubusercontent.com/your-org/drs/main/templates/gitlab-review.yml'

variables:
  OPENCODE_SERVER: "http://opencode.internal:3000"
  REVIEW_AGENTS: "security,quality,style"

stages:
  - review
  - test
  - deploy

ai_review:
  extends: .drs_review
  only:
    - merge_requests
  variables:
    GITLAB_TOKEN: $CI_JOB_TOKEN
```

### Webhook Server Deployment

```bash
# docker-compose.yml
docker-compose up -d

# Configure GitLab webhook
# URL: http://your-server:8080/webhook/gitlab
# Token: [secret from .env]
# Events: Merge request events, Comments
```

## Next Steps

1. **Set up project structure** - Create directory layout
2. **Implement OpenCode client wrapper** - Basic SDK integration
3. **Create base review agents** - Security, quality, style, performance markdown files
4. **Build GitLab integration** - API client and webhook handler
5. **Implement CLI** - Local diff review command
6. **Add CI/CD runner** - GitLab CI mode
7. **Build webhook server** - Standalone service
8. **Documentation** - Setup guides and examples
9. **Testing** - Unit and integration tests
10. **Deployment** - Docker images and templates

---

**Key Difference from Previous Design**: This architecture uses OpenCode's markdown-based agent system instead of Claude Agent SDK's programmatic agents. This allows for easier customization, version control, and distribution of review capabilities across teams and projects.
