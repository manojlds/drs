# Claude Code Action: Git diff enablement notes

Source references:
- https://github.com/anthropics/claude-code-action/blob/main/docs/solutions.md

## Observations from the solutions guide

- The PR review workflow examples check out the PR branch with `actions/checkout@v5` (typically `fetch-depth: 1`) and explicitly note that the PR branch is already checked out, while allowing `gh pr diff` in the tool allowlist (e.g., `Bash(gh pr diff:*)`) so the agent can fetch diffs via the GitHub CLI rather than relying on local git history alone.
- Some workflows that need full git history (e.g., documentation sync) check out the PR head ref with `fetch-depth: 0` and allow generic git commands via `Bash(git:*)`, which would permit `git diff` once the repository history is fully available.

## Commands used to collect sources

- `curl -sS https://raw.githubusercontent.com/anthropics/claude-code-action/main/docs/solutions.md`
