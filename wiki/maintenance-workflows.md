---
type: Workflow
title: Maintenance workflows
description: DRS workflows for repository upkeep — changelog updates, review-issue fixes, agent guidance refresh, and release changelog finalization.
tags: [maintenance, changelog, fix, agents-md, workflow]
---

# Maintenance workflows

DRS ships packaged maintenance workflows alongside review workflows. They use the same YAML DSL and the same agent/action system, but they mutate repository files instead of posting comments.

## Available maintenance workflows

| Workflow | Purpose |
|----------|---------|
| `local-changelog-update` | Update `CHANGELOG.md` from local unstaged changes using `task/changelog-updater`. |
| `tag-changelog-update` | Update `CHANGELOG.md` from the previous stable tag to the current tag (or explicit refs). |
| `release-changelog-finalize` | Finalize `CHANGELOG.md` for a release before tagging. |
| `local-fix-review-issues` | Fix actionable findings from the latest saved review artifact, then re-run review. |
| `local-update-agents-md` | Update `AGENTS.md` or equivalent guidance using `task/agents-md-updater`. |
| `repository-wiki-sync` | Generate, reconcile, or update an OKF v0.1 repository wiki bundle. |
| `repository-wiki-check` | Verify wiki delta state and OKF v0.1 conformance without a model call. |

These workflows are defined in `.pi/workflows/*.yaml`. They are intentionally local-only and do not commit changes. Projects can compose them with `git-add`, `git-commit`, and platform posting actions to build stronger automation.

## Changelog workflows

`local-changelog-update` loads the local unstaged diff, runs the `task/changelog-updater` agent, and writes the updated `CHANGELOG.md`. It does not stage or commit.

`tag-changelog-update` uses a `change-source` action with `type: git-range`. When `from` and `to` are omitted, it infers `to` from the GitHub Actions tag event (`GITHUB_REF_NAME`) or the exact tag at `HEAD`, and `from` from the previous reachable stable semver tag. Set `includePrereleaseFrom: true` to compare an RC against the previous RC. This is used by `.github/workflows/tag-changelog.yml` for RC tags.

`release-changelog-finalize` is meant for final releases. The manual `.github/workflows/release-changelog.yml` runs it with explicit inputs, commits the changelog to the default branch, and optionally creates the final `v<version>` tag so the publish workflow runs from a commit that already contains the changelog.

## Fix workflows

`local-fix-review-issues` loads the latest saved review artifact, runs the `task/review-issue-fixer` agent, and re-reviews the resulting changes. It uses the same artifact-aware reconciliation as the platform fix flow but stays local.

`github-pr-review` and `gitlab-mr-review` also support fix flows when `fix=true`:

- `fixMode=internal` stages and commits fixes to the source branch.
- `fixMode=stacked` creates a stacked PR/MR with a branch prefix (default `drs-fix/pr-`).

The `stack-guard` action prevents the workflow from running recursively on DRS-managed branches. The `review-threshold` action checks whether enough findings at or above `fixSeverity` exist before any fix work begins.

## Agent guidance refresh

`local-update-agents-md` runs `task/agents-md-updater` to refresh repository guidance such as `AGENTS.md`. The default output path is `AGENTS.md`, but it can be overridden with the `path` input.

## Project-local composed workflows

This repository defines a project-local workflow at `.drs/workflows/local-changelog-review.yaml`:

1. Load the local unstaged diff.
2. Run `task/changelog-updater` to edit `CHANGELOG.md`.
3. Reload the local diff.
4. Run the normal review action on the final changes.
5. Commit only `CHANGELOG.md` with `docs: update changelog`.

It is selected as the default workflow in `.drs/drs.config.yaml` (`workflow.default: local-changelog-review`), so `npm run dev:cli -- workflow run` runs it without a name.

## Repository wiki

The `repository-wiki-sync` workflow creates or updates an OKF v0.1 wiki bundle. It uses a deterministic delta planner to decide whether the wiki needs to be regenerated, reconciled, updated, or left unchanged. The `task/okf-wiki-maintainer` agent runs only when the delta plan says work is needed. After the agent edits concepts, the workflow synchronizes directory indexes, validates the bundle, and records state in `.drs/wiki-state.json`.

The `repository-wiki-check` workflow is a model-free CI gate. It checks the recorded delta state and validates the bundle without invoking an agent. `.github/workflows/ci.yml` runs this check on every pull request.

See [Repository wiki](repository-wiki.md) for the full delta fingerprinting, state, and validation details.

## See also

- [Workflow engine](workflow-engine.md) for the DSL and scheduling.
- [Review workflows](review-workflows.md) for the review artifact and fix verification.
- [Integrations](integrations.md) for the GitHub Actions wrappers that use these workflows.
- [Repository wiki](repository-wiki.md) for OKF wiki maintenance and CI checks.
- [Configuration](configuration.md) for `fix.checks` and workflow defaults.
