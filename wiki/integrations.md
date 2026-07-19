---
type: Integration
title: Platform integrations
description: How DRS integrates with GitHub, GitLab, and CI/CD systems.
tags: [github, gitlab, ci-cd, integration]
---

# Platform integrations

DRS integrates with GitHub and GitLab through a shared `PlatformClient` interface and platform-specific adapters. The same review orchestration is used for local diffs and platform changes; only the change source and posting steps differ.

## Platform client interface

`src/lib/platform-client.ts` defines `PlatformClient` with methods for:

- Fetching pull/merge requests.
- Listing changed files.
- Getting and posting comments.
- Posting inline comments in bulk.
- Updating and deleting comments.
- Adding labels.
- Creating and finding change requests.

The GitHub adapter (`src/github/platform-adapter.ts`) wraps `@octokit/rest` through `src/github/client.ts`. The GitLab adapter (`src/gitlab/platform-adapter.ts`) wraps `@gitbeaker/node` through `src/gitlab/client.ts`.

## GitHub workflows

The packaged `github-pr-review` workflow loads a `github-pr` change source and can optionally describe, post review comments, generate a visual HTML explainer, and create a stacked fix PR. Inputs include `owner`, `repo`, `pr`, `describe`, `post`, `visual`, `fix`, `fixMode`, `fixSeverity`, and `fixMaxIterations`.

The `github-pr-show-changes` workflow runs `change-source` and `review-context` to print the context DRS would send to agents.

The `github-pr-post-comment` workflow posts or updates a single marked comment.

### GitHub Actions wrapper

`.github/workflows/pr-review.yml` is the production PR automation wrapper. It uses `pull_request_target` and:

1. Verifies whether the author is a repository collaborator and whether the PR has the `safe-to-review` label.
2. Auto-reviews trusted contributors with `fix=true`, `fixMode=internal`, and `describe=false`.
3. Synchronizes the [repository wiki](repository-wiki.md) for trusted contributors, then commits and pushes wiki-only changes back to the PR branch.
4. Reviews external contributors only when the PR has the `safe-to-review` label and the `external-pr-review` environment is approved.
5. Runs `node dist/cli/index.js workflow run github-pr-review --post=true --trace`.
6. Uploads the visual explainer, workflow artifacts, and trace viewer as artifacts.

Additional manual wrappers exist for stacked guidance updates (`.github/workflows/drs-guidance-stacked.yml`) and stacked fixes (`.github/workflows/drs-fix-stacked.yml`).

## GitLab workflows

The packaged `gitlab-mr-review` workflow loads a `gitlab-mr` change source and supports `describe`, `post`, and `codeQuality`. The `codeQuality=true` input writes a GitLab CodeClimate-compatible report to `gl-code-quality-report.json` via the `code-quality-report` action.

The severity mapping is:

- CRITICAL → blocker
- HIGH → critical
- MEDIUM → major
- LOW → minor

The `gitlab-mr-show-changes`, `gitlab-mr-post-comment`, and `gitlab-mr-visual-explain` workflows provide the same debugging and explainer support as the GitHub set.

### GitLab CI template

`src/ci/runner.ts` and `src/ci/gitlab-ci.template.yml` provide a reusable GitLab CI template. Projects include the remote template and extend `.drs_review` to add DRS review jobs to their pipeline.

## Local workflows

Local workflows use `simple-git` through `src/cli/workflow.ts` to read `git diff`, `git diff --cached`, or a range of refs. They do not require platform tokens.

## Security notes

- The GitHub Actions workflow uses `pull_request_target`, which runs workflow YAML from the target branch, not the PR branch. This prevents external PRs from modifying the review automation.
- External contributors require the `safe-to-review` label and approval of the `external-pr-review` environment to prevent API-cost abuse.
- The `stack-guard` action refuses to run fix flows on branches with reserved prefixes (`drs-fix/`, `drs-guidance/`, `drs-stack/`).

## See also

- [Architecture](architecture.md) for the adapter layer.
- [Review workflows](review-workflows.md) for review actions.
- [Workflow engine](workflow-engine.md) for platform change sources.
- `docs/GITHUB_ACTIONS_INTEGRATION.md`, `docs/GITLAB_CI_INTEGRATION.md`, and `docs/EXTERNAL_PR_SECURITY.md` for detailed setup guides.
