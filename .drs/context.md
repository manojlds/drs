# DRS Project Context (Review Focus)

## What DRS Is
DRS (Diff Review System) is a Node/TypeScript CLI that runs AI code reviews for GitHub PRs and GitLab MRs using OpenCode agents.

## Core Flow (Review)
- CLI commands in `src/cli/` gather diff + metadata.
- Review orchestration lives in `src/lib/`.
- OpenCode client/agent integration is in `src/opencode/`.
- Platform integrations: `src/github/` and `src/gitlab/`.

## Review Agents & Skills
- Built-in agents live under `agents/review/`.
- Project overrides can live in `.drs/agents/` (agent.md per agent).
- Project skills live in `.drs/skills/<skill-name>/SKILL.md`.
- Default skills are configured in `.drs/drs.config.yaml` under `review.default.skills`.

## Config & Defaults
- Main config: `.drs/drs.config.yaml`.
- Default review mode: `review.mode: unified`.
- Default model: `review.default.model`.
- Ignore patterns: `review.ignorePatterns`.

## Review Focus
- Review only the diff and its direct impact.
- Prioritize correctness, safety, clarity, and maintainability.
- Avoid flagging standard CLI/TypeScript patterns as issues unless they introduce real risk.
