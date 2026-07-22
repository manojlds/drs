---
type: Operations
title: Testing and quality gate
description: How DRS is tested, including the mandatory quality gate, unit tests, and opt-in Temporal smoke tests.
tags: [testing, vitest, quality-gate, ci]
drs_sources:
  - path: src/cli/workflow.test.ts
  - path: src/lib/agent-permissions.test.ts
  - path: src/lib/okf-wiki.test.ts
  - path: src/lib/pr-review-workflow-security.test.ts
  - path: src/lib/release-automation.test.ts
  - path: src/lib/review-artifact-validation.test.ts
  - path: src/lib/wiki-delta.test.ts
  - path: src/lib/wiki-search.test.ts
  - path: src/lib/wiki-run-summary.test.ts
  - path: src/lib/wiki-site-safety.test.ts
  - path: src/lib/wiki-site.integration.test.ts
---

# Testing and quality gate

DRS uses Vitest for unit and integration tests. The mandatory quality gate is `npm run check:all`, which runs formatting, linting, build, tests, and verification checks.

## Test setup

Tests live next to the source files as `*.test.ts` siblings. The test runner is configured in `vitest.config.ts`. The CLI entry-point tests include `src/cli/workflow.test.ts`, `src/cli/run-agent.test.ts`, and `src/cli/init-smoke.test.ts`.

Run tests with:

```bash
npm test
```

Run a single test file:

```bash
npx vitest run src/lib/config.test.ts
```

## Mandatory quality gate

`package.json` defines `check:all` as:

```bash
npm run format && npm run lint:fix && npm run build && npm test && npm run format:check && npm run lint
```

This must be run after every code change.

## Unit-test coverage

Most `src/lib/` modules have corresponding `*.test.ts` files. Important areas:

- `src/lib/config.test.ts` — config loading, legacy rejection, model override resolution.
- `src/lib/context-compression.test.ts` — diff trimming and budget logic.
- `src/lib/workflow/*.test.ts` — planning, compilation, artifact store, and node execution boundaries.
- `src/lib/review-artifact-store.test.ts` and `src/lib/review-artifact.test.ts` — artifact persistence and finding state.
- `src/lib/comment-*.test.ts` — comment formatting, posting, and fingerprinting.
- `src/lib/review-artifact-validation.test.ts` — canonical review envelope validation for the split external-review posting path: scope, head SHA, finding fingerprints, changed files, and summary consistency.
- `src/lib/pr-review-workflow-security.test.ts` — assertions over `.github/workflows/pr-review.yml` that the external model job checks out trusted base code with read-only permissions, disables posting/visual/fix, requires complete diffs, and that the deterministic posting job carries no provider secrets.
- `src/runtime/*.test.ts` — agent loading and path config.
- `src/github/*.test.ts` and `src/gitlab/*.test.ts` — platform clients and adapters, including creator identity mapping with public email and platform no-reply fallback.
- `src/gitlab/client.test.ts` — GitLab private commit email domain derivation and `GITLAB_COMMIT_EMAIL_DOMAIN` override.
- `src/temporal/*.test.ts` — Temporal planning, retry policies, workflow ids, and activities.
- `src/lib/okf-wiki.test.ts` — OKF v0.1 index synchronization and bundle validation.
- `src/lib/agent-permissions.test.ts` and `src/pi/sdk.test.ts` — generic agent policy validation, repository-root reads, path and symbolic-link rejection, Pi tool enforcement, validator feedback, and post-run mutation guards that report added, modified, and deleted paths.
- `src/lib/workflow/planning.test.ts` — workflow node shape validation for `permissions` and `validation`, including conflicts with `writes` and `agentsFrom` write restrictions.
- `src/lib/wiki-search.test.ts` and `src/cli/wiki.test.ts` — model-free concept ranking, phrase matching, fenced-code-block-aware heading extraction (including invalid backtick fences), Unicode-normalized code-point-safe snippets, limits, empty-query rejection, unsafe-bundle rejection, and JSON CLI output.
- `src/lib/wiki-delta.test.ts` — deterministic delta planning, source/wiki fingerprints, state recording, and clean checks.
- `src/lib/wiki-run-summary.test.ts` — wiki structural and usage summaries, net concept-change classification, no-op reporting, and escaped Markdown output.
- `src/lib/release-automation.test.ts` — release metadata script semantics, exact SemVer validation, changelog finalization, pack manifest checks, and the atomic release/publish workflow transaction.
- `src/lib/wiki-site*.test.ts` — directed graph extraction and metrics, publishing safety, reusable build/serve setup, deployed-site smoke checks, and the full site integration path.
- `src/cli/workflow.test.ts` — end-to-end `repository-wiki-sync` and `repository-wiki-check` workflow runs, `git-commit` creator attribution, review action permissions propagation, GitHub `requireCompleteDiff` validation, and canonical review artifact loading/posting.

## Temporal smoke test

The Temporal smoke test requires a running Temporal server and is opt-in:

```bash
npm run test:temporal:smoke
```

It starts a real worker with a unique task queue, dispatches a safe `write` workflow, waits for completion, and cleans up. CI can run it as a separate job after provisioning a Temporal test server.

## CLI testing skill

The repository has a CLI testing skill at `.drs/skills/cli-testing/SKILL.md` (referenced by `agents.default.skills` in `.drs/drs.config.yaml`). It provides a checklist for reviewing CLI flag and command contracts.

## Adding tests

When changing behavior, add or update the corresponding `*.test.ts` file. Tests should be evidence-based and exercise the public interfaces of the module under test. Avoid relying on real network calls in unit tests; platform clients should be mocked or tested with small, deterministic fixtures.

## See also

- `package.json` for scripts and dependencies.
- `vitest.config.ts` for test configuration.
- `TEMPORAL_EXECUTION_PLAN.md` for the Temporal rollout plan.
- `.drs/skills/cli-testing/SKILL.md` for CLI contract review guidance.
- [Repository wiki](repository-wiki.md) for wiki behavior and CI integration.
