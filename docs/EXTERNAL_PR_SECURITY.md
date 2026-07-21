# External PR Security

This guide covers safe operation of DRS for pull requests from external contributors.

## Recommended Controls

1. **Never check out or execute a PR head** in a `pull_request_target` job that has secrets or write credentials.
2. **Require manual approval** before running paid model requests for forked or external contributions.
3. **Use environment protection rules** for the read-only model job that accesses the provider key.
4. **Separate model generation from GitHub writes** and transfer only a canonical review artifact.
5. **Limit token permissions per job** (`contents: read` and `pull-requests: read` for generation; `pull-requests: write` only for deterministic posting).
6. **Rate-limit or label-gate execution** and monitor provider usage for unusual spikes.

## Secrets Handling

- Store provider keys in GitHub/GitLab encrypted secrets.
- Never print secrets in workflow logs.
- Rotate keys if suspicious activity is detected.

## Suggested Workflow Pattern

- Treat every fork PR as external, even when its author is a repository collaborator.
- Check out the pinned base SHA with `persist-credentials: false` and build only trusted base code.
- Fetch the PR metadata and patches as data through the GitHub API; do not execute PR-controlled package scripts, workflows, agents, configuration, or tools.
- Run `github-pr-review` with `describe=false`, `post=false`, `visual=false`, `fix=false`, and `requireCompleteDiff=true` under read-only agent permissions. Complete-diff mode paginates the GitHub file list, rejects head changes during retrieval, requires a patch for every file, and reconciles patch line counts with GitHub metadata.
- Upload only the scope-specific canonical `review/latest.json` artifact with short retention and `if-no-files-found: error`.
- In a separate job without a provider key, download that exact same-run artifact and invoke `github-pr-review-post`.
- Before any mutation, validate the envelope id and schema, repository and PR scope, reviewed and current head SHA, changed-file paths, finding fingerprints, and summary counts.

The included `.github/workflows/pr-review.yml` implements this split. The `safe-to-review` label gates the external path; configure required reviewers on the `external-pr-review` environment to add the approval gate.

## Incident Response

If abuse is suspected:

1. Disable the review workflow.
2. Rotate provider/API tokens.
3. Audit recent workflow runs and repository events.
4. Re-enable with stricter gating.
