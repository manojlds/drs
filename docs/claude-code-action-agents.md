# Claude Code Action (.claude) review agents summary

Source: https://github.com/anthropics/claude-code-action/tree/main/.claude (accessed via the GitHub raw files).

## Agents

- **code-quality-reviewer**: focuses on clean code, error handling, maintainability, and TypeScript-specific guidance (prefers `type` over `interface`, avoids underscores for unused vars). Also outlines review structure with severity grouping and actionable recommendations.
- **security-code-reviewer**: scans for OWASP Top 10, injection, auth/authz issues, cryptography problems, and requires structured findings with impact/remediation and references (CWE/standards).
- **performance-reviewer**: reviews algorithmic complexity, network/db efficiency, and memory/resource management. Structures feedback into critical issues, optimization opportunities, best practices, and code examples.
- **test-coverage-reviewer**: evaluates test coverage, test quality, and missing scenarios; provides prioritized recommendations and example cases.
- **documentation-accuracy-reviewer**: verifies docs/README/API accuracy vs implementation; requires issue categorization by doc type and severity, with actionable recommendations.

## Commands / orchestration

- **review-pr**: command instructs the system to run the five review subagents above, then post only noteworthy feedback as inline or top-level comments (concise).
- **commit-and-pr**: instructs the system to run tests/typechecks/format checks, then commit, push, and open a PR.
- **label-issue**: issue triage flow that uses GitHub CLI to fetch labels, view issue, search for similar issues, then apply labels (no comments).

## Settings

- `settings.json` adds a PostToolUse hook that runs `bun run format` after Edit/Write/MultiEdit tool usage.
