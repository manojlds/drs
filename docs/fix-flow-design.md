# Fix Flow Design: Review-Fix Loop

## Problem

The current fix flow is linear: review → fix → mark-attempted → create stacked PR. There is no verification that fixes actually address the findings. A dedicated "verify-fix" action would duplicate review logic. Instead, the review action itself should be reused in a loop with a fix change-source.

## Design

### Two Fix Modes

**Internal fix cycle** (`fixMode: "internal"`)
```
review → threshold → fix → stage → fix-change-source → re-review → threshold → fix → ... until clean or maxIterations
```
- Fixes are applied to the current working directory on a fix branch
- After each fix, changes are staged and a new `local` change-source captures the fix diff
- The review action reviews the fix diff — it naturally focuses on the fix changes
- The loop exits when the threshold is no longer met or max iterations is reached
- Best for: local review workflows, CI runs that commit directly to the PR branch

**Stacked fix flow** (`fixMode: "stacked"`, current default)
```
review → threshold → fix → commit → push → create stacked PR → notify
```
- Fixes are committed to a stacked branch and a PR is created
- The stacked PR gets its own DRS review automatically (via `pull_request_target`)
- That review IS the verification — it naturally reviews the fix diff
- If the stacked PR's review finds issues, it can trigger its own fix flow (guarded by stack-guard against recursion)
- Best for: automated PR review where changes should be reviewed before merging

### Fix Change-Source (Internal Mode)

Instead of passing `previousReview` context to the review agent, we create a new change-source from the fix diff:

1. Fixer modifies files on the fix branch
2. `git-add` stages the changed files
3. A `local` change-source with `staged: true` captures the fix diff
4. The review action reviews the fix change-source — it sees only the fix changes
5. The review naturally checks whether the fixes are correct, without needing to know about previous findings

This is better than `previousReview` because:
- The review doesn't need to cross-reference old findings — it just reviews the fix diff
- Focus is natural and reliable (the diff only contains fix changes)
- No changes to the review action itself

### Finding Comparison

After re-review, compare new findings against the original review artifact:
- Match by file path + line proximity + fingerprint (category + file + line)
- Findings no longer present in re-review → mark `resolved`
- Findings still present → keep `attempted` or mark `partial`
- New findings in fixed files → mark as `regression`

This is a post-processing step using the existing `review-artifact-update-findings` action, not part of the review itself.

### Workflow Structure

```yaml
inputs:
  fixMode: "stacked"  # "stacked" or "internal"
  fixMaxIterations: "3"

nodes:
  # ... review, review-artifact, save-review-artifact, threshold as before ...

  fix-branch:
    action: git-branch
    with:
      name: "{{inputs.fixBranchPrefix}}{{inputs.pr}}"
      force: true

  fix-issues:
    agent: task/review-issue-fixer
    needs:
      - fix-branch
      - review-artifact
    input: |
      Fix actionable issues...
      Review artifact: {{artifacts.reviewArtifact}}
    output: fixes

  # --- Internal mode: re-review loop ---

  # Branch on fix mode
  should-internal-loop:
    control: condition
    needs:
      - fix-issues
    if: "{{inputs.fixMode}} == internal"
    then: stage-fixes
    else: fix-diff

  # Stage fixer changes for fix change-source
  stage-fixes:
    action: git-add
    needs:
      - fix-issues
    with:
      paths: "."
    output: stagedFixes

  # Create fix change-source from staged diff
  fix-change:
    action: change-source
    needs:
      - stage-fixes
    with:
      type: local
      staged: true
    output: fixChange

  # Re-review the fix diff
  re-review:
    action: review
    needs:
      - fix-change
    with:
      source: fixChange
    output: reReview

  # Check if re-review still has actionable findings
  re-threshold:
    action: review-threshold
    needs:
      - re-review
    with:
      review: reReview
      severity: "{{inputs.fixSeverity}}"
      minIssues: "1"
    output: reThreshold

  # Loop back to fix if still has issues
  fix-loop:
    control: loop
    needs:
      - re-threshold
    condition: "{{artifacts.reThreshold.matched}} == true"
    target: fix-issues
    exit: fix-done
    maxIterations: "{{inputs.fixMaxIterations}}"

  fix-done:
    control: condition
    needs:
      - re-threshold
    if: "{{inputs.fixMode}} == stacked"
    then: fix-diff
    else: done

  # --- Stacked mode: commit, push, create PR ---

  fix-diff:
    action: has-diff
    needs:
      - fix-issues
    output: fixDiff

  should-create-fix-pr:
    control: condition
    needs:
      - fix-diff
    if: "{{artifacts.fixDiff.changed}} == true"
    then: should-create-fix-change-request
    else: done

  should-create-fix-change-request:
    control: condition
    needs:
      - fix-diff
    if: "{{inputs.fixCreateChangeRequest}} == true"
    then: fix-commit
    else: done

  fix-commit:
    action: git-commit
    with:
      message: "fix: address DRS review issues for PR #{{inputs.pr}}"
      paths: "."
    output: fixCommit

  fix-push:
    action: git-push
    needs:
      - fix-commit
    with:
      branch: "{{inputs.fixBranchPrefix}}{{inputs.pr}}"
    output: fixPush

  create-fix-pr:
    action: create-change-request
    needs:
      - fix-push
    with:
      platform: github
      owner: "{{inputs.owner}}"
      repo: "{{inputs.repo}}"
      sourceBranch: "{{inputs.fixBranchPrefix}}{{inputs.pr}}"
      targetBranch: "{{artifacts.change.context.pullRequest.sourceBranch}}"
      title: "fix: address DRS review issues for PR #{{inputs.pr}}"
      draft: "{{inputs.fixDraft}}"
      body: |
        Automated DRS fix stacked on PR #{{inputs.pr}} from the main github-pr-review workflow.

        Threshold: {{inputs.fixSeverity}}, minimum issues: {{inputs.fixMinIssues}}
        Review artifact: {{artifacts.persistedReviewArtifact.path}}

        <!-- drs-stack-source: github:{{inputs.owner}}/{{inputs.repo}}#{{inputs.pr}} -->
        <!-- drs-stack-kind: fix -->
    output: changeRequest

  notify-fix-pr:
    action: post-comment
    needs:
      - create-fix-pr
    with:
      platform: github
      owner: "{{inputs.owner}}"
      repo: "{{inputs.repo}}"
      pr: "{{inputs.pr}}"
      marker: drs-stacked-fix-notification
    input: |
      DRS created a stacked fix PR: {{artifacts.changeRequest.url}}

      The fix addresses {{inputs.fixSeverity}}-priority review findings from this PR's review run.

      <!-- drs-stacked-fix-notification -->

  done:
    control: end
```

### Stacked PR as Natural Verification

For the stacked flow, no explicit re-review happens in the same workflow run. Instead:

1. Stacked PR is created with fix changes
2. `pull_request_target` triggers DRS review on the stacked PR
3. That review sees the fix diff (stacked PR diff against the original PR source branch)
4. The review naturally verifies whether original findings are addressed
5. If new issues are found, the stacked PR's own fix flow can run (guarded by stack-guard)
6. If no issues are found, the stacked PR is clean and ready to merge

### Fix-Status Comment

After the fix flow completes (both internal and stacked modes), DRS posts a fix-status comment on the original PR. The comment shows:

- Each original finding (severity, file, line, message)
- Its disposition: `resolved`, `partial`, `still open`, or `regression`
- For resolved findings: the relevant fix diff snippet showing how it was fixed

A new `post-fix-status` action handles this:

```yaml
post-fix-status:
  action: post-fix-status
  needs:
    - review-artifact
    - re-review       # or review if stacked mode (no re-review)
    - fix-change      # fix change-source with the fix diff
  with:
    platform: github
    owner: "{{inputs.owner}}"
    repo: "{{inputs.repo}}"
    pr: "{{inputs.pr}}"
    reviewArtifact: persistedReviewArtifact
    fixReview: reReview
    fixChange: fixChange
    marker: drs-fix-status
  output: fixStatus
```

The action:
1. Reads the original review artifact findings
2. Reads the re-review findings (internal mode) or uses the fixer output (stacked mode)
3. Matches findings by file path + line proximity + fingerprint
4. For each original finding, determines disposition:
   - `resolved`: finding not present in re-review
   - `partial`: finding still present but severity reduced or moved
   - `still open`: finding unchanged in re-review
   - `regression`: new finding in a fixed file
5. For resolved findings, extracts the relevant diff hunk from the fix change-source
6. Formats and posts a marked comment on the original PR

Comment format:
```markdown
<!-- drs-fix-status -->

## Fix Status

| # | Severity | File | Issue | Status |
|---|----------|------|-------|--------|
| 1 | HIGH | src/cli/workflow.ts:566 | Checkpoint string truncation... | ✅ Resolved |
| 2 | MEDIUM | src/cli/workflow.ts:3478 | Shared activeNodeId... | ✅ Resolved |

### Fix Details

**#1 — Checkpoint string truncation (Resolved)**
```diff
- const CHECKPOINT_MAX_STRING_LENGTH = 10_000;
+ const CHECKPOINT_MAX_FILE_SIZE = 50 * 1024 * 1024;
```

**#2 — Shared activeNodeId (Resolved)**
```diff
- executionContext.activeNodeId = nodeId;
+ throw tagWorkflowNodeError(error, nodeId);
```
```

For stacked mode (no re-review in the same run), the comment shows the findings as `attempted` with a link to the stacked PR. The stacked PR's own review will provide the actual verification.

### What Changes

| Component | Change |
|-----------|--------|
| `github-pr-review.yaml` | Add `fixMode` and `fixMaxIterations` inputs, fix change-source + re-review + loop nodes, fix-status comment |
| `github-pr-fix-review-issues-stacked.yaml` | Add optional re-review loop before commit, fix-status comment |
| New `post-fix-status` action | Compares findings, posts fix-status comment with dispositions and diff snippets |
| Review artifact | After re-review, update finding states via existing mutation action |

### What Does NOT Change

- No new "verify-fix" action — the review action reviews the fix diff
- No `previousReview` input on the review action
- The review action remains unchanged — it just reviews a different change-source
- The fixer agent remains the same
- The stacked PR creation flow remains the same
- The stack-guard prevents recursive stacked PRs

### Implementation Order

1. Add `post-fix-status` action (finding comparison + diff snippet extraction + comment posting)
2. Add `fixMode` and `fixMaxIterations` inputs to `github-pr-review.yaml`
3. Wire fix change-source + re-review + loop nodes for internal mode
4. Wire `post-fix-status` after fix flow for both modes
5. Add finding disposition update after re-review (using existing mutation action)
6. Update `github-pr-fix-review-issues-stacked.yaml` with optional loop and fix-status
7. Update `gitlab-mr-review.yaml` with the same pattern
8. Tests for post-fix-status action, loop mode, finding comparison, and disposition updates
