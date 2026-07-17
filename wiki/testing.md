---
type: Operations
title: Testing and quality gate
description: How DRS is tested, including the mandatory quality gate, unit tests, live tests, and Temporal smoke tests.
tags: [testing, vitest, quality-gate, ci]
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
- `src/runtime/*.test.ts` — agent loading and path config.
- `src/github/*.test.ts` and `src/gitlab/*.test.ts` — platform clients and adapters.
- `src/temporal/*.test.ts` — Temporal planning, retry policies, workflow ids, and activities.

## Live tests

The E2E live test runs the local review workflow against the actual repository:

```bash
DRS_E2E_LIVE=1 npm run test:e2e
```

This executes `src/cli/review-local.live.e2e.test.ts` and requires a working model provider key.

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
