# PR-Agent Research & Implementation Guide

This document captures research findings from [qodo-ai/pr-agent](https://github.com/qodo-ai/pr-agent) and implementation details for DRS.

**Research Date**: January 2026
**DRS Branch**: `claude/pr-agent-research-lIKCz`
**Commits**: cc065ba, 9ab85d1, 55b164f

---

## Table of Contents

1. [PR-Agent Overview](#pr-agent-overview)
2. [PR-Agent Architecture](#pr-agent-architecture)
3. [Key Learnings](#key-learnings)
4. [What We Implemented](#what-we-implemented)
5. [What Can Be Implemented Next](#what-can-be-implemented-next)
6. [Architecture Comparison](#architecture-comparison)

---

## PR-Agent Overview

**PR-Agent** is a Python-based AI-powered code review tool developed by Qodo (formerly CodiumAI). It provides automated code review, PR description generation, code improvements, and Q&A capabilities for GitHub and GitLab.

### Key Features

- **/describe**: Generates comprehensive PR descriptions
- **/review**: Provides code review with suggestions
- **/improve**: Suggests code improvements
- **/ask**: Answers questions about PR changes
- Multi-platform support (GitHub, GitLab, Bitbucket, Azure DevOps)
- Configurable via TOML files

### Architecture Philosophy

**Tool-Based vs Agent-Based**:
- PR-Agent uses **tools** (independent operations, single LLM call each)
- Each tool operates independently without inter-tool communication
- Tools make one ~30-second LLM call with pre-compressed context

**DRS Approach** (different):
- Uses **agents** (OpenCode SDK) that can use tools during execution
- Agents can read files dynamically via Read/Grep/Glob tools
- Multiple specialized agents run in parallel for different concerns

---

## PR-Agent Architecture

### 1. The `/describe` Tool

**Purpose**: Generate comprehensive PR descriptions automatically

**Source Code**: `/pr_agent/tools/pr_description.py`
**Prompts**: `/pr_agent/settings/pr_description_prompts.toml`

#### Output Format

```json
{
  "type": "Bug fix | Tests | Enhancement | Documentation | Other",
  "title": "Concise theme-capturing headline",
  "description": [
    "Bullet point 1 (max 8 words)",
    "Bullet point 2 (max 8 words)"
  ],
  "pr_files": [
    {
      "filename": "path/to/file.ts",
      "changes_summary": ["Change 1", "Change 2"],
      "changes_title": "Brief title (5-10 words)",
      "label": "bug fix | tests | enhancement | etc."
    }
  ],
  "changes_diagram": "Mermaid flowchart (optional)"
}
```

#### Key Features

- **Type Classification**: Categorizes PR as feature, bugfix, refactor, etc.
- **AI-Generated Title**: Optional concise title (50-70 chars)
- **Bullet-Point Summary**: 1-4 bullets, max 8 words each (configurable)
- **File-by-File Walkthrough**: Semantic analysis per file
- **Labels**: Auto-generated suggestions for PR categorization
- **Sequence Diagrams**: Mermaid diagrams showing component interactions (optional)

#### Configuration Options

```toml
[pr_description]
publish_labels = false
add_original_user_description = true
generate_ai_title = false
use_bullet_points = true
enable_pr_type = true
enable_pr_diagram = true
publish_description_as_comment = false
enable_semantic_files_types = true
collapsible_file_list = 'adaptive'  # true, false, or 'adaptive'
inline_file_summary = false  # false, true, or 'table'
```

### 2. Context Handling Strategy

**PR-Agent's Approach**:

#### Single Context Fetch
- Fetches PR context **once** at the beginning
- Applies "PR Compression strategy" to fit within token limits
- Compression happens **upstream** before LLM call
- Each tool operates on pre-compressed context

#### Token Budget Management

**Location**: `/pr_agent/algo/token_handler.py`

**Process**:
1. **Retrieve & Sort Files**: By main programming language
2. **Generate Extended Patches**: Add context lines (configurable, max 10)
3. **Token Budget Management**:
   - Under soft threshold (~1500 token buffer): Return complete diff
   - Over soft threshold: Compress and prune patches
   - Over hard threshold (~1000 token buffer): Skip remaining files
4. **Patch Processing**: Convert to readable format with line numbers
5. **Metadata Extraction**: Title, description, branches, commits, tickets

#### Compression Levels

**Level 1: Token Budgeting**
- Uses model-specific token counting (tiktoken for OpenAI, API call for Anthropic)
- Fallback estimation factor (0.3) for unsupported models
- 9MB content size check for Claude

**Level 2: Intelligent Truncation**
- Sort files by token count (descending) for priority processing
- Three strategies: skip patch, clip tokens, filename-only reference
- Append summaries of unprocessed files with remaining tokens

**Level 3: Large PR Handling**
- Split massive PRs into multiple AI calls (max 4 by default)
- Support async AI calls for parallel processing
- Combine results from multiple predictions

**Level 4: Patch Optimization**
- Remove deletion-only hunks to reduce noise
- Focus on lines starting with '+' (additions)
- Extend context intelligently using section headers

**Level 5: Response Optimization**
- Limit description to 500 tokens (configurable)
- Limit commit messages to 500 tokens
- Use bullet points for conciseness

### 3. Business Context Integration

**Ticket Context Fetching**:
- Fetches issue/ticket context from Jira, Linear, GitHub Issues, etc.
- Includes in analysis for better business alignment
- Checks if code actually solves the ticket requirements

### 4. Qodo Context Engine

**Architecture** (for Qodo hosted version, not open-source PR-Agent):
- Agent-based orchestration with specialized tools
- Pre-indexes codebases from Git providers
- Combines RAG (Retrieval-Augmented Generation) with agentic reasoning

**Process**:
1. **Indexing**: Create structured, multi-layered codebase understanding
2. **Retrieval**: Fetch relevant functions, docs, commit history, patterns
3. **Agentic Reasoning**: Analyze relationships, dependencies, intent
4. **Generation**: Craft clear, accurate response grounded in understanding

---

## Key Learnings

### 1. Context Compression is Critical

**Problem**: Large PRs exceed token limits
**PR-Agent Solution**: Pre-compress context before LLM call
**DRS Current**: Agents read files dynamically (more thorough but expensive)

**Key Insight**: Balance between thoroughness (DRS) and cost/speed (PR-Agent)

### 2. Single LLM Call vs Multi-Agent

**PR-Agent**: One LLM call per tool (~30 seconds)
**DRS**: Multiple agents in parallel, each can make multiple tool calls

**Trade-offs**:
- **PR-Agent**: Faster, cheaper, less thorough
- **DRS**: Slower, more expensive, more thorough

### 3. Focus on Additions, Not Deletions

**Key Principle**: Lines starting with '+' are most important
Deletions provide context but are secondary

### 4. Structured JSON Output

**Benefit**: Consistent, parseable output format
**Implementation**: Pydantic models for validation

### 5. Configuration-Driven Behavior

**PR-Agent**: TOML configuration files control behavior
**DRS**: YAML configuration (similar approach)

---

## What We Implemented

### 1. PR/MR Description Generator

**Files Created**:
- `.opencode/agent/describe/pr-describer.md` - Description generator agent
- `src/cli/describe-pr.ts` - GitHub PR command
- `src/cli/describe-mr.ts` - GitLab MR command

**Features**:
- Type classification (feature, bugfix, refactor, docs, test, chore, perf)
- Auto-generated title (imperative mood, 50-70 chars)
- Concise bullet-point summary (2-4 points, max 12 words each)
- File-by-file changes walkthrough with semantic labels
- Suggested labels for categorization
- Optional recommendations
- JSON output support
- Post as comment on PR/MR with `--post-description` flag

**CLI Commands**:

```bash
# GitHub PR
drs describe-pr --owner=<owner> --repo=<repo> --pr=<number> [--post-description] [-o output.json]

# GitLab MR
drs describe-mr --project=<project> --mr=<iid> [--post-description] [-o output.json]
```

**Output Format**:

```json
{
  "type": "feature",
  "title": "Add OAuth2 authentication with JWT token validation",
  "summary": [
    "Implements OAuth2 authentication to replace deprecated basic auth",
    "Adds JWT token validation with expiration and refresh logic",
    "Includes comprehensive test coverage for auth flows"
  ],
  "walkthrough": [
    {
      "file": "src/auth/oauth2.ts",
      "changeType": "added",
      "semanticLabel": "feature",
      "title": "OAuth2 authentication implementation",
      "changes": [
        "Implements OAuth2 authorization code flow",
        "Adds JWT token generation and validation"
      ],
      "significance": "major"
    }
  ],
  "labels": ["feature", "authentication", "security", "breaking-change"],
  "recommendations": [
    "Update API documentation to reflect OAuth2 endpoints",
    "Add migration guide for clients using basic auth"
  ]
}
```

### 2. GitHub Workflow Integration

**File**: `.github/workflows/pr-review.yml`

**Changes**:
- Added "Generate PR Description" step before review
- Runs for both trusted and external contributors
- Uses `--post-description` flag to automatically post descriptions
- Saves description to `pr-description.json` for CI artifacts

**Workflow Sequence**:
1. Verify contributor (trusted vs external)
2. **Generate and post PR description** (NEW!)
3. Run code review (quality agent only for this PR)
4. Post review comments

### 3. Configuration Updates

**File**: `.drs/drs.config.yaml`

**Added**:
```yaml
# PR/MR Description Generator
describe:
  # Model to use for description generation (optional, defaults to review.defaultModel)
  # model: opencode/glm-4.7-free
```

**Temporary Changes** (for this PR only):
```yaml
review:
  agents:
    # - security
    - quality  # Only quality agent enabled
    # - style
    # - performance
    # - documentation
```

### 4. Agent Design Principles

**Focus Areas**:
- Prioritize additions (+) over deletions (-)
- Significant changes over minor changes
- "Why" and "what" over "how"
- Concrete specifics over vague descriptions
- Imperative mood for titles ("Add", "Fix", not "Added", "Fixed")
- Max word counts to enforce conciseness

---

## What Can Be Implemented Next

### Priority 1: Context Compression (High Impact) (Implemented)

**Problem**: Large PRs are expensive and slow to analyze
**Status**: Implemented via context compression in review and describe flows.
**Solution**: Implement token budget management (completed)

**Implementation**:

```typescript
// New: src/lib/context-budget-manager.ts
class ContextBudgetManager {
  allocateTokens(
    totalBudget: number,
    files: FileChange[],
    agents: string[]
  ): ContextAllocation {
    // Prioritize by:
    // 1. Files with more changes
    // 2. Files with security-sensitive patterns
    // 3. Critical files (auth, config, etc.)

    return {
      perAgent: { security: 5000, quality: 3000 },
      perFile: { "src/auth.ts": "full", "test.ts": "summary" }
    };
  }

  compressPatches(files: FileWithDiff[], budget: number): FileWithDiff[] {
    // Apply compression strategies:
    // - Remove deletion-only hunks
    // - Truncate context lines
    // - Skip low-priority files
    // - Include file summaries for skipped files
  }
}
```

**Benefits**:
- Faster reviews (fewer LLM calls)
- Lower costs (less token usage)
- Can handle larger PRs

**Complexity**: Medium (2-3 weeks)

### Priority 2: Unified Review Mode (Cost Optimization) (Implemented)

**Problem**: Current multi-agent approach is thorough but expensive
**Status**: Implemented with unified and hybrid review modes.
**Solution**: Add fast mode with single LLM call (like pr-agent) (completed)

**Implementation**:

```yaml
# .drs/drs.config.yaml
review:
  mode: "multi-agent"  # Current default (thorough)
       | "unified"     # NEW: Single LLM call (fast & cheap)
       | "hybrid"      # NEW: Unified first, then targeted deep-dives
```

```typescript
// New: .opencode/agent/review/unified-reviewer.md
// Single agent that produces all review types in one call

Output JSON:
{
  summary: { type, description },
  issues: [
    { category: "SECURITY", severity, file, line, problem, solution },
    { category: "QUALITY", ... },
    { category: "STYLE", ... }
  ]
}
```

**Benefits**:
- Fast mode for quick reviews (30 seconds like pr-agent)
- Deep mode for thorough analysis (current approach)
- Cost flexibility for teams

**Complexity**: Medium (2-3 weeks)

### Priority 3: JSON-Based Agent Configuration (Usability) (Deferred)

**Problem**: Customizing agent behavior requires editing agent markdown files
**Status**: Not needed for now given the current context override + agentic system; revisit if a concrete per-agent customization need arises.
**Solution**: Allow per-agent customization in config (future work)

**Implementation**:

```yaml
# .drs/drs.config.yaml
review:
  agentConfig:
    security:
      severityThreshold: HIGH  # Only report HIGH+ issues
      categories:  # Customize what to check
        - sql-injection
        - xss
        - auth-bypass
      excludePatterns:
        - "test/**"

    quality:
      complexityThreshold: 15  # Flag functions with complexity > 15
      duplicateLineThreshold: 10
      checkPatterns:
        - DRY
        - SOLID
        - error-handling
```

**Benefits**:
- Easier customization without code changes
- Teams can adapt to their standards
- Better separation of config from implementation

**Complexity**: Low-Medium (1-2 weeks)

### Priority 4: Ticket Context Integration (Context Enrichment)

**Problem**: Agents only see code changes, not business context
**Solution**: Fetch issue/ticket context and include in analysis

**Implementation**:

```typescript
// New: src/lib/ticket-fetcher.ts
interface TicketContext {
  ticketId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  relatedTickets: string[];
}

// Extract from PR/MR:
// - Title: "feat: Add SSO (#JIRA-123)"
// - Body: "Closes #456"
// - Branch: "feature/PROJ-789-sso"

// Fetch from:
// - JIRA API
// - Linear API
// - GitHub Issues API
// - GitLab Issues API

// Include in agent context
```

**Benefits**:
- Agents understand business requirements
- Better alignment checking ("does code solve the ticket?")
- Detect missing requirements or scope creep

**Complexity**: Medium-High (3-4 weeks)

### Priority 5: Sequence Diagrams (Visualization)

**Problem**: Complex changes are hard to understand without visual flow
**Solution**: Generate Mermaid sequence diagrams

**Implementation**:

```typescript
// Add to describe agent output
{
  ...existing fields...,
  "diagram": "sequenceDiagram\n  User->>API: Request\n  API->>DB: Query\n  DB-->>API: Data\n  API-->>User: Response"
}
```

**Agent Enhancement**: Add diagram generation capability to pr-describer agent

**Benefits**:
- Visual understanding of component interactions
- Easier review for complex changes
- Better documentation

**Complexity**: Medium (2-3 weeks, requires LLM to generate Mermaid syntax)

### Priority 6: Context Caching & Reuse

**Problem**: Running multiple describe/review operations re-fetches same context
**Solution**: Cache context and reuse across operations

**Implementation**:

```typescript
// Already partially supported via --context-only, --context-output, --context-read
// Enhancements needed:

// 1. Auto-detect when context unchanged (git diff --cached hash)
const contextHash = crypto.createHash('sha256')
  .update(JSON.stringify(files))
  .digest('hex');

// 2. Cache in .drs/cache/
const cachePath = `.drs/cache/${contextHash}.json`;

// 3. Share across operations in single run
if (cacheExists(cachePath) && !isStale(cachePath)) {
  return loadCache(cachePath);
}
```

**Benefits**:
- Faster subsequent operations
- Lower costs (no redundant API calls)
- Better CI performance

**Complexity**: Low (1-2 weeks)

### Priority 7: Self-Reflection & Validation (Quality)

**Problem**: AI can produce false positives
**Solution**: Add validation layer to confirm findings

**Implementation**:

```typescript
// New: .opencode/agent/review/validator.md
// Takes all issues from other agents
// Re-analyzes each one to confirm it's real
// Filters out likely false positives

interface ValidatedIssue extends ReviewIssue {
  confidence: number;  // 0-1 score
  validationReason: string;
  falsePositiveCheck: boolean;
}
```

**Benefits**:
- Fewer false positives
- Higher quality signal
- Better developer trust

**Complexity**: Medium-High (3-4 weeks)

---

## Architecture Comparison

### PR-Agent vs DRS

| Aspect | PR-Agent | DRS |
|--------|----------|-----|
| **Language** | Python | TypeScript |
| **Architecture** | Tool-based (independent operations) | Agent-based (OpenCode SDK) |
| **LLM Calls** | One per tool (~30 sec) | Multiple per agent (dynamic) |
| **Context** | Pre-compressed, single fetch | Dynamic file reading |
| **Tool Use** | No tools available to LLM | Agents use Read/Grep/Glob/Bash |
| **Configuration** | TOML files | YAML files |
| **Review Approach** | Single comprehensive call | Specialized parallel agents |
| **Cost** | Lower (pre-compressed) | Higher (more thorough) |
| **Speed** | Faster (~30 sec per tool) | Slower (multiple agents) |
| **Thoroughness** | Good (compressed context) | Excellent (full codebase access) |
| **Platforms** | GitHub, GitLab, Bitbucket, Azure | GitHub, GitLab |

### When to Use Each Approach

**PR-Agent Style (Fast Mode)**:
- ✅ Quick feedback on small-medium PRs
- ✅ Budget-conscious teams
- ✅ High-volume PR workflows
- ✅ Initial triage/screening

**DRS Style (Deep Mode)**:
- ✅ Critical changes requiring thorough analysis
- ✅ Security-sensitive code
- ✅ Complex refactoring
- ✅ When context understanding is crucial

**Hybrid Approach** (Recommended for DRS):
- Fast mode for initial analysis (unified agent)
- Deep mode when issues detected (specialized agents)
- User-configurable based on PR characteristics

---

## Implementation Status

### ✅ Completed

- [x] PR/MR description generator agent
- [x] CLI commands (describe-pr, describe-mr)
- [x] GitHub workflow integration
- [x] JSON output format
- [x] Post descriptions as comments
- [x] Configuration support
- [x] Documentation
- [x] Context compression
- [x] Unified review mode

### 🔄 In Progress

- [ ] None

### 📋 Planned

- [ ] JSON-based agent configuration
- [ ] Ticket context integration
- [ ] Sequence diagrams
- [ ] Context caching
- [ ] Self-reflection & validation

---

## Config Improvements Plan (JSON-Based Agent Configuration)

### Goals

- Allow per-agent customization without editing agent markdown files.
- Support default values and per-run overrides (CLI/env/config).
- Keep config schema backward-compatible with existing YAML.
- Provide guardrails/validation to prevent misconfiguration.

### Proposed Configuration Schema

```yaml
review:
  agentConfig:
    security:
      severityThreshold: HIGH
      categories:
        - sql-injection
        - xss
        - auth-bypass
      excludePatterns:
        - "test/**"

    quality:
      complexityThreshold: 15
      duplicateLineThreshold: 10
      checkPatterns:
        - DRY
        - SOLID
        - error-handling
```

### Implementation Plan

1. **Config Types & Validation**
   - Extend `DRSConfig` to include `review.agentConfig`.
   - Define per-agent config types in `src/lib/config.ts` (or a new `src/lib/agent-config.ts`).
   - Validate values (e.g., severity enum, numeric ranges, non-empty arrays).

2. **Load & Merge Behavior**
   - Merge config from `.drs/drs.config.yaml`, `.gitlab-review.yml`, env, and CLI overrides.
   - Ensure unknown agents are ignored with warnings (not hard failures).

3. **Agent Prompt Wiring**
   - Pass agent-specific config into the prompt builder in `review-core.ts`.
   - Add a structured section like `Agent Configuration` to reduce prompt ambiguity.
   - Ensure unified reviewer receives relevant config for all agent categories.

4. **CLI Overrides**
   - Add CLI flags for common overrides (e.g., `--security-threshold`, `--quality-complexity`).
   - Translate CLI flags into `review.agentConfig` overrides.

5. **Documentation**
   - Update README and `.drs/drs.config.yaml` template examples.
   - Add a section in `docs/pr-agent-research.md` linking to the new config options.

6. **Tests**
   - Add unit tests for config loading/merging with `agentConfig`.
   - Add tests for prompt injection into `review-core` for at least one agent.

### Milestone Breakdown

- **Phase 1 (Schema + Merge)**: Add types, merging logic, and validation.
- **Phase 2 (Prompt Wiring)**: Inject agentConfig into review prompts.
- **Phase 3 (CLI + Docs + Tests)**: CLI overrides, docs updates, and coverage.

---

## References

### PR-Agent Resources

- **Repository**: https://github.com/qodo-ai/pr-agent
- **Documentation**: https://qodo-merge-docs.qodo.ai/
- **Source Code**:
  - `/describe` tool: `/pr_agent/tools/pr_description.py`
  - Prompts: `/pr_agent/settings/pr_description_prompts.toml`
  - Token handling: `/pr_agent/algo/token_handler.py`
  - Context processing: `/pr_agent/algo/pr_processing.py`

### Qodo Resources

- **Context Engine**: https://docs.qodo.ai/qodo-documentation/qodo-aware
- **Blog**: https://www.qodo.ai/blog/introducing-qodo-aware-deep-codebase-intelligence-for-enterprise-development/

### DRS Implementation

- **Branch**: `claude/pr-agent-research-lIKCz`
- **Commits**:
  - `cc065ba`: Add PR/MR description generator based on pr-agent
  - `9ab85d1`: Configure describe in workflow and limit agents to quality only
  - `55b164f`: Remove unimplemented describe config options

---

## Notes for Future Sessions

### Key Decisions Made

1. **Focus on describe first**: Most valuable feature from pr-agent
2. **Keep multi-agent architecture**: DRS's strength is thorough analysis
3. **Add fast mode**: Implemented unified mode as an option
4. **Configuration-driven**: Follow pr-agent's approach of TOML/YAML config

### Code Locations

**Describe Implementation**:
- Agent: `.opencode/agent/describe/pr-describer.md`
- GitHub: `src/cli/describe-pr.ts`
- GitLab: `src/cli/describe-mr.ts`
- CLI: `src/cli/index.ts` (commands registered)
- Config: `src/lib/config.ts` (describe section)

**Helper Functions**:
- Context building: `src/lib/review-core.ts` (`buildBaseInstructions`)
- OpenCode client: `src/opencode/client.ts`
- Platform adapters: `src/github/platform-adapter.ts`, `src/gitlab/platform-adapter.ts`

### Testing Notes

To test the describe functionality:

```bash
# Build
npm run build

# Test on a GitHub PR
node dist/cli/index.js describe-pr \
  --owner=manojlds \
  --repo=drs \
  --pr=42 \
  --post-description

# Test on a GitLab MR
node dist/cli/index.js describe-mr \
  --project=my-org/my-repo \
  --mr=123 \
  --post-description
```

### Future Considerations

1. **Large PR Handling**: Context compression is in place; monitor effectiveness on 50+ file PRs
2. **Cost Optimization**: Unified mode is available; monitor adoption for common cases
3. **Quality Metrics**: Track false positive rate for review agents
4. **User Feedback**: Collect feedback on describe quality and usefulness

---

**Document Version**: 1.0
**Last Updated**: January 15, 2026
**Author**: Research conducted via Claude Code
