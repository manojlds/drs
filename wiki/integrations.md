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

- Fetching pull/merge requests, including the creator identity and an `authorEmail` suitable for commit attribution.
- Listing changed files.
- Getting and posting comments.
- Posting inline comments in bulk.
- Updating and deleting comments.
- Adding labels.
- Creating and finding change requests.

The GitHub adapter (`src/github/platform-adapter.ts`) wraps `@octokit/rest` through `src/github/client.ts`. The GitLab adapter (`src/gitlab/platform-adapter.ts`) wraps `@gitbeaker/node` through `src/gitlab/client.ts`. Both adapters normalize the change request creator: a public email is preserved when available, otherwise a platform-specific no-reply address is synthesized (`{id}+{login}@users.noreply.github.com` or `{id}-{username}@<GitLab commit email domain>`). Self-managed GitLab defaults to `users.noreply.<instance-host>` and can override the domain with `GITLAB_COMMIT_EMAIL_DOMAIN`.

## GitHub workflows

The packaged `github-pr-review` workflow loads a `github-pr` change source and can optionally describe, post review comments, generate a visual HTML explainer, and create a stacked fix PR. Inputs include `owner`, `repo`, `pr`, `describe`, `post`, `visual`, `fix`, `fixMode`, `fixSeverity`, and `fixMaxIterations`.

The `github-pr-show-changes` workflow runs `change-source` and `review-context` to print the context DRS would send to agents.

The `github-pr-post-comment` workflow posts or updates a single marked comment.

### GitHub Actions wrapper

`.github/workflows/pr-review.yml` is the production PR automation wrapper. It triggers on `pull_request_target` events of types `opened`, `synchronize`, `reopened`, and `labeled`, runs on `ubuntu-latest`, uses `actions/checkout@v5` and `actions/setup-node@v5` with Node `22.19.0`, and builds DRS with `npm ci` and `npm run build`. The `labeled` trigger is required so adding the `safe-to-review` label re-runs the workflow for external PRs. The workflow is split into several jobs:

1. `verify-contributor` checks whether the PR author is a repository collaborator and whether the PR has the `safe-to-review` label.
2. `review-trusted` runs for repository collaborators. It has a 30-minute timeout, resolves the model provider key from `DRS_PROVIDER_API_KEY` (falling back to `OPENCODE_API_KEY`), and runs `node dist/cli/index.js workflow run github-pr-review --post=true --trace` with `describe=false`, `visual=false`, `fix=true`, `fixMode=internal`, `fixSeverity=medium`, and `fixMaxIterations=1`. It uploads the visual explainer, DRS workflow artifacts, and trace viewer as artifacts.
3. `sync-wiki-trusted` runs after a successful trusted review of a branch in the same repository. It executes `repository-wiki-sync --executor local`, rejects any changes outside `wiki/` and `.drs/wiki-state.json`, and creates a binary patch of the wiki delta.
4. `commit-wiki-trusted` downloads the patch, reapplies it on the reviewed head, verifies paths and symlink modes, and commits the wiki delta back to the PR branch using the PR creator as Git author and committer.
5. `review-external` runs for external contributors only when the PR has the `safe-to-review` label and the `external-pr-review` environment is approved. It has a 20-minute timeout, uses the same provider key resolution, and runs `github-pr-review` with `describe=true`, `visual=true`, `fix=false`, and `post=true`. It also uploads the visual explainer, workflow artifacts, and trace viewer.
6. `notify-external` posts a comment on external PRs that lack the `safe-to-review` label, explaining that a maintainer must add the label or approve the workflow run.

Wiki pushes require a fine-grained `DRS_WIKI_SYNC_TOKEN` Actions secret with repository Contents read/write access. A separate token is required because pushes made with the workflow `GITHUB_TOKEN` do not reliably trigger fresh PR checks. Generation runs without the write token and uploads a binary patch; a fresh job applies the patch, rechecks its paths and symlink modes, and exposes the token only to the final commit/push step. The push uses an explicit lease for the reviewed head, so it fails atomically if the branch moved or was deleted. Fork and external PRs remain read-only.

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
- External contributors require both the `safe-to-review` label and approval of the `external-pr-review` environment to prevent API-cost abuse.
- The `stack-guard` action refuses to run fix flows on branches with reserved prefixes (`drs-fix/`, `drs-guidance/`, `drs-stack/`).

## See also

- [Architecture](architecture.md) for the adapter layer.
- [Review workflows](review-workflows.md) for review actions.
- [Workflow engine](workflow-engine.md) for platform change sources.
- `docs/GITHUB_ACTIONS_INTEGRATION.md`, `docs/GITLAB_CI_INTEGRATION.md`, and `docs/EXTERNAL_PR_SECURITY.md` for detailed setup guides.
