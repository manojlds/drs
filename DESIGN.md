# DRS Design Notes

> Note: This document replaces the original planning notes. It summarizes current behavior.

## Review Pipeline

DRS uses a unified review pipeline that is shared across local, GitLab, and GitHub workflows:

1. **Resolve inputs** (diffs or changed files) from the selected source.
2. **Filter files** using ignore/include patterns from config.
3. **Connect to OpenCode** (remote server or in-process instance).
4. **Run review agents** in parallel with a consistent JSON output schema.
5. **Aggregate and summarize** issues.
6. **Output results** to terminal, MR/PR comments, or code quality reports.

## Platform Abstraction

A `PlatformClient` interface isolates GitLab/GitHub API operations:

- Fetch PR/MR metadata
- Fetch changed files
- Create or update comments
- Post inline comments with platform-specific positioning rules
- Apply labels

Adapters:

- GitLab: `src/gitlab/platform-adapter.ts`
- GitHub: `src/github/platform-adapter.ts`

## OpenCode Integration

OpenCode integration supports:

- Remote server via `OPENCODE_SERVER`
- In-process server when unset
- Agent discovery from project overrides
- Model overrides from config

See `src/opencode/client.ts` and `src/opencode/agent-loader.ts`.
