# DRS Project Context

## What DRS Is
Node/TypeScript CLI for AI code reviews on GitHub PRs and GitLab MRs, powered by Pi SDK.

## Core Flow
- CLI commands (`src/cli/`) gather diff + metadata.
- Review orchestration in `src/lib/`.
- Pi SDK adapter in `src/pi/`, runtime client in `src/runtime/`.
- Platform integrations: `src/github/`, `src/gitlab/`.

## Agents & Skills
- Built-in agents: `.pi/agents/review/`.
- Project overrides: `.drs/agents/<name>/agent.md`.
- Skills: `.drs/skills/<name>/SKILL.md`.

## Config
- Main config: `.drs/drs.config.yaml`.
- Key settings: `review.mode`, `review.default.model`, `review.ignorePatterns`.

## Review Focus
- Review only the diff and its direct impact.
- Prioritize correctness, safety, clarity, and maintainability.
