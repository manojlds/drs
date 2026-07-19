---
type: Workflow
title: Review workflows
description: How DRS performs code reviews from local diffs, GitHub PRs, and GitLab MRs, including change sources, findings, fix verification, and posting.
tags: [review, workflow, findings, comments, code-quality]
---

# Review workflows

Review workflows are the primary reason DRS exists. They collect a set of changed files, run configured review agents through the Pi runtime, and emit findings that can be persisted, posted, or fixed.

Packaged review workflows include `local-review`, `github-pr-review`, `gitlab-mr-review`, `github-pr-show-changes`, `gitlab-mr-show-changes`, `github-pr-visual-explain`, and `gitlab-mr-visual-explain`. Project workflows can override or extend them.

## Change source

Every review workflow starts with a `change-source` action (`src/cli/workflow.ts`). Supported source types are:

- `local` — unstaged or staged git diff in the working directory.
- `git-range` — diff between two refs, or between the previous stable semver tag and the current tag.
- `github-pr` — GitHub PR metadata and changed files.
- `gitlab-mr` — GitLab MR metadata and changed files.
- `fix-verification` — combined original and local-fix diff used after a fix attempt.

The action returns a `ReviewSource` object with the changed file list, optional patches, and platform context. This object is the input to the review action.

## Review action

The `review` action (`src/cli/workflow.ts`) calls `executeReview` in `src/lib/review-orchestrator.ts`, which performs the following steps:

1. Filter files using `review.ignorePatterns` and `review.includePatterns` from `src/lib/config.ts`.
2. Resolve model ids for all configured review agents and the optional describer.
3. Connect to the Pi runtime via `src/runtime/client.ts`.
4. Compress diffs using `src/lib/context-compression.ts` to stay within model context windows.
5. Optionally run the describe agent for change context (`src/lib/description-executor.ts`).
6. Build base instructions (`src/lib/review-core.ts`) containing the diff content and output schema.
7. Run each configured review agent in parallel (`src/lib/review-core.ts` -> `runReviewAgents`).
8. Parse agent JSON output and collect issues.
9. Calculate summary statistics and token usage.

The action exposes the raw review result as its node output and also saves a canonical review artifact envelope. By default the artifact is available as `artifacts.<nodeId>Artifact` (for example `artifacts.reviewArtifact`).

## Agents and prompts

The default review agent is `review/unified-reviewer`. Additional review agents can be added under `.drs/agents/review/<name>/agent.md` and listed in `review.agents`.

`src/lib/review-core.ts` builds the prompt that every review agent receives. It includes the diff content, an output JSON schema, and strict rules to only report issues on added or modified lines. When the diff is too large, the prompt tells the agent to call `git_diff` for files that were omitted.

## Context compression

`src/lib/context-compression.ts` trims diff content before sending it to models:

- Removes deletion-only hunks.
- Excludes generated files (detected by markers like `@generated`).
- Drops whole patches when the total estimated tokens exceed a budget.
- Budget can be dynamic: `thresholdPercent * modelContextWindow` when context-window metadata is available.

When content is omitted, a summary is added to the prompt so the agent knows which files to inspect with `git_diff`.

## Review artifacts and findings

The review action persists a structured artifact using `src/lib/review-artifact.ts`. Each finding has:

- `id`, `fingerprint`, `issue`.
- `state`: `open`, `attempted`, or `resolved`.
- `disposition`: `confirmed`, `uncertain`, `pre_existing`, `partial`, `still_open`, `regression`, or `resolved`.
- `source`: `agent`, `manual`, or `external`.
- Optional `verification` with disposition, rationale, and timestamp.

Workflow actions can query, update, add, promote, and resolve findings. The `review-artifact-status` action returns aggregate counts by state, disposition, and severity.

## Fix verification

The `verify-fix` action (`src/cli/workflow.ts`) compares a previously saved review artifact with a new re-review result and updates finding states. It is used by the `github-pr-review` and `gitlab-mr-review` workflows when `fix=true` and `fixMode=internal`.

The flow in `.pi/workflows/github-pr-review.yaml` is:

1. Review the original change.
2. Check severity threshold (`review-threshold`).
3. Create a fix branch and run `task/review-issue-fixer`.
4. Load the local fix diff (`change-source: fix-verification`).
5. Re-review the combined diff with the original artifact as context.
6. Run `verify-fix` to mark findings as `resolved`, `partial`, `still_open`, or `regression`.
7. Loop back if actionable findings remain, up to `fixMaxIterations`.
8. Post fix status (`post-fix-status`) and push the verified fix to the source branch.

A stacked-fix mode (`fixMode=stacked`) creates a separate change request instead of pushing to the source branch. The `git-commit` nodes in `github-pr-review` and `gitlab-mr-review` set `useChangeRequestAuthor: true`, so both internal and stacked fix commits are attributed to the original PR/MR creator. The `stack-guard` action prevents recursive reviews on DRS-managed branches.

Standalone stacked fix workflows `github-pr-fix-review-issues-stacked` and `gitlab-mr-fix-review-issues-stacked` provide the same fix-and-stack behavior without the main review flow; their `git-commit` nodes also set `useChangeRequestAuthor: true`.

## Posting results

The `post-review-comments` action uses `src/lib/comment-poster.ts` to:

- Post or update a summary comment (identified by a bot marker).
- Post inline comments for CRITICAL/HIGH issues on valid diff lines.
- Remove stale inline comments whose issue fingerprints no longer appear.
- Add the `ai-reviewed` label.

For GitLab, the `code-quality-report` action writes a GitLab CodeClimate-compatible JSON report from the review result.

## Visual explainers

The `visual/pr-explainer` agent writes a self-contained HTML artifact (`visualOutputPath`) summarizing the change and the review result. In GitHub Actions, this artifact is uploaded with `actions/upload-artifact@v4`.

## See also

- [Workflow engine](workflow-engine.md) for the DSL and scheduling.
- [Pi runtime](pi-runtime.md) for the review agents.
- [Configuration](configuration.md) for review and compression settings.
- [Integrations](integrations.md) for platform adapters and CI wrappers.
