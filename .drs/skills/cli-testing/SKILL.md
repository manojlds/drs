---
name: cli-testing
description: DRS CLI flag and command contract review checklist
---

# Purpose

Use this skill when reviewing changes in `src/cli/**` or command wiring in `src/cli/index.ts`.
The goal is to catch CLI contract drift before release: broken flags, ambiguous defaults,
and behavior changes that are not reflected in docs/tests.

# DRS CLI Focus Areas

- Validate flag definitions in `src/cli/index.ts`:
  - long/short forms, defaults, required options, and env-var fallbacks.
  - mutually exclusive flags and precedence (`--json` + terminal output, `--output` paths, etc.).
- Confirm command handlers in `src/cli/*.ts` honor declared flags:
  - option names in commander wiring must map to runtime option fields.
  - staged/unstaged behavior, exit codes, and error paths should match help text.
- Check operational consistency for review commands:
  - `review-local`, `review-pr`, and `review-mr` should keep similar semantics where expected.
  - JSON output mode should remain script-friendly and deterministic.
- Validate docs/test coverage for CLI behavior changes:
  - update README/DEVELOPMENT snippets when visible CLI behavior changes.
  - add or update tests for new flags, option interactions, and regressions.

# Review Output Guidance

- Prioritize issues affecting user-facing behavior, automation compatibility, and CI usage.
- Flag missing integration coverage when a new/changed flag alters execution flow.
- Do not report style-only nits unless they create ambiguity in CLI usage.
