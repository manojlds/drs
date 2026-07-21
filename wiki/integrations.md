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

1. `verify-contributor` sends every fork PR through the external path. A same-repository PR is trusted only when its author has `write`, `maintain`, or `admin` permission. The job also checks for the `safe-to-review` label.
2. `review-trusted` runs for trusted same-repository branches. It has a 30-minute timeout, resolves the model provider key from `DRS_PROVIDER_API_KEY` (falling back to `OPENCODE_API_KEY`), and runs `node dist/cli/index.js workflow run github-pr-review --post=true --trace` with `describe=false`, `visual=false`, `fix=true`, `fixMode=internal`, `fixSeverity=medium`, and `fixMaxIterations=1`. It uploads the visual explainer, DRS workflow artifacts, and trace viewer as artifacts.
3. `review-external` runs after the label and configured environment approval. It checks out the pinned base SHA without persisted credentials, builds trusted base code, grants the GitHub token read-only access, and runs `github-pr-review` with `describe=false`, `post=false`, `visual=false`, `fix=false`, and `requireCompleteDiff=true`. Complete-diff mode paginates GitHub files and rejects unstable heads, incomplete file lists, missing patches, and patch counts that disagree with GitHub metadata. Review model sessions have repository read access but no shell or write tools. The job uploads only the scoped canonical `review/latest.json` artifact.
4. `post-external-review` checks out the same trusted base SHA in a job that has no provider secret, downloads the exact same-run artifact, and invokes the model-free `github-pr-review-post` workflow with a write token. Posting fails before any mutation unless the artifact scope, expected and current PR head, findings, fingerprints, counts, and changed-file paths validate.
5. `notify-external` posts a comment on external PRs that lack the `safe-to-review` label. A protected `external-pr-review` environment may require a second approval after labeling.

Repository wiki updates are independent of feature PR review. `.github/workflows/wiki-update.yml` runs daily and on manual dispatch from the latest default branch, executes `repository-wiki-sync --executor local`, rejects unexpected changed paths, and uses a fixed `drs/wiki-update` branch to create or refresh one bot pull request. This avoids committing branch-specific `.drs/wiki-state.json` files into parallel feature PRs.

The scheduled workflow resolves the model key from `DRS_PROVIDER_API_KEY` with `OPENCODE_API_KEY` as a fallback. Its fine-grained `DRS_WIKI_SYNC_TOKEN` needs repository Contents and pull requests read/write access. Generation and path checks run without the write token, produce a binary patch, and pass that patch to a fresh job and checkout. The fresh job verifies allowed paths and symlink modes before only the pinned `peter-evans/create-pull-request` step receives the token. Ordinary feature PRs build the wiki site for model-free bundle and rendering validation. The dedicated bot PR additionally runs `repository-wiki-check`, so its source and wiki fingerprints must match before merge.

Trusted internal review fixes are pushed with the workflow `GITHUB_TOKEN`, which does not trigger ordinary push workflows. When the reviewed head changed, a separate no-checkout `refresh-trusted-checks` job uses the GitHub Git Data API to append one empty check-refresh commit with `DRS_WIKI_SYNC_TOKEN`. That token-backed ref update emits the normal `synchronize` event, so standard PR CI tests the synthetic merge result and applies the strict freshness check to `drs/wiki-update`. The job verifies the URL-encoded remote ref before its non-force update and runs no repository-controlled code with the token. PR review runs are serialized rather than canceled so a label event cannot interrupt this finalization, and the refresh commit disables internal fixing on its follow-up review to cap the cross-run fix cycle.

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

- `pull_request_target` selects workflow YAML from the target branch but is safe only if privileged jobs also avoid checking out and executing the PR head. External jobs pin the base SHA and disable checkout credential persistence.
- External model generation has read-only GitHub and agent permissions. GitHub writes happen in a separate deterministic job after strict canonical artifact and head validation.
- External contributors require the `safe-to-review` label and, when configured, approval of the `external-pr-review` environment to prevent API-cost abuse.
- The `stack-guard` action refuses to run fix flows on branches with reserved prefixes (`drs-fix/`, `drs-guidance/`, `drs-stack/`).

## See also

- [Architecture](architecture.md) for the adapter layer.
- [Review workflows](review-workflows.md) for review actions.
- [Workflow engine](workflow-engine.md) for platform change sources.
- `docs/GITHUB_ACTIONS_INTEGRATION.md`, `docs/GITLAB_CI_INTEGRATION.md`, and `docs/EXTERNAL_PR_SECURITY.md` for detailed setup guides.
