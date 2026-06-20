# DRS Remaining Work Plan

## Status Legend
- [x] Done
- [ ] Not started
- [~] In progress / partially done

---

## 1. Workflow Checkpoint/Resume Hardening

### 1.1 Avoid saving huge or circular context in checkpoints
- [ ] Sanitize or truncate large artifact payloads before writing checkpoint JSON
- [ ] Detect circular references in node results/artifacts and omit or stub them
- [ ] Consider a max checkpoint file size guard

**Context**: `saveWorkflowCheckpoint` in `src/cli/workflow.ts:534` serializes the full `context.nodes`, `context.artifacts`, and `context.loop` on every node completion. Large review outputs, diffs, or HTML artifacts could produce oversized checkpoint files.

### 1.2 Improve failure metadata
- [ ] Track the active node id at the outer catch site so failure records identify which node was running
- [ ] Optionally include node type (agent/action/control) in failure metadata
- [ ] Consider including a short stack trace or error class in the checkpoint failure record

**Context**: The outer `catch` in `runWorkflow` (`src/cli/workflow.ts:3428`) does not know which node was executing when the error occurred. The `WorkflowCheckpointFailure` interface was simplified to only `message` and `failedAt` after the review feedback, but identifying the failing node would improve debugging.

### 1.3 Checkpoint cleanup/retention policy
- [ ] Add an optional `--checkpoint-retain <count>` or `--checkpoint-ttl <duration>` CLI flag
- [ ] Or add a `workflow.checkpointRetention` config option
- [ ] Implement cleanup of stale checkpoint files on successful workflow completion or on next run start
- [ ] Document the retention behavior

**Context**: PR review recommended a cleanup policy. Checkpoints accumulate under `.drs/checkpoints/` and are currently never removed.

### 1.4 Document checkpoint schema
- [ ] Add a `docs/CHECKPOINTS.md` or extend `docs/WORKFLOWS.md` with the checkpoint JSON schema
- [ ] Document `schemaVersion`, `workflow`, `key`, `updatedAt`, `inputs`, `nodes`, `artifacts`, `loop`, `failure` fields
- [ ] Note that checkpoint files are gitignored generated state, not committed source

**Context**: PR review noted the checkpoint schema is undocumented. `docs/WORKFLOWS.md` now has a resume usage section but no schema reference.

### 1.5 Full quality gate for latest review-fix commits
- [ ] Run `npm run check:all` after all review-fix commits are settled
- [ ] Verify the `.gitignore` change does not break any test that writes to `.drs/`

**Context**: Focused tests were run for individual review fixes, but `npm run check:all` was not re-run after commits `a687c0c`, `a592df2`, and `2179fcb`.

---

## 2. Artifact-Aware Fix Verification

### 2.1 Verify exact fixed findings after fix agent runs
- [ ] After `fix-issues` node, re-run a targeted review or diff analysis against only the touched files
- [ ] Compare post-fix findings against the persisted review artifact findings
- [ ] Mark findings as `resolved` when the fix diff addresses them
- [ ] Mark findings as `regression` if new issues appear in the same locations
- [ ] Mark findings as `partial` if the fix partially addresses them

**Context**: Current `mark-fix-attempted` node in `.pi/workflows/github-pr-review.yaml:213` marks all severity-matched findings as `attempted` / `partial` without verifying whether they were actually fixed. This is a coarse heuristic.

### 2.2 Pass targeted finding IDs/fingerprints to the fixer agent
- [ ] Extract specific finding IDs and fingerprints from the review artifact
- [ ] Pass them as structured input to `task/review-issue-fixer` so the agent knows exactly which findings to address
- [ ] Include file/line/severity context per finding in the fixer prompt

**Context**: The current `fix-issues` node passes the full review artifact and persisted envelope as template text. The fixer agent does not receive a structured, targeted list of findings to fix.

### 2.3 Publish artifact state back to PR/MR comments
- [ ] After fix verification, post a summary comment showing finding disposition changes:
  - `open` -> `attempted` -> `resolved`
  - `open` -> `attempted` -> `partial`
  - new findings flagged as `regression`
- [ ] Link to the persisted review artifact path for full detail
- [ ] Consider updating the existing review summary comment vs creating a new fix-status comment

**Context**: After PR #123, the fix flow mutates the review artifact on disk but does not communicate the outcome back to the PR/MR. Users have no visibility into which findings were addressed.

### 2.4 Add a post-fix review-status workflow action
- [ ] New action: `review-artifact-status` (already exists as a workflow action, but needs to be wired into the fix flow)
- [ ] New action or node: `verify-fix` that runs a targeted re-review and updates finding states
- [ ] New action or node: `publish-fix-status` that posts the verification result as a comment

**Context**: `review-artifact-status` action exists for querying artifact state but is not used in any packaged workflow. A `verify-fix` action does not exist yet.

---

## 3. Stacked PR/MR Workflow Improvements

### 3.1 Stacked branch update/reuse policy beyond initial create
- [ ] When a stacked fix PR already exists and a new review run produces new fixes:
  - Update the existing branch with new commits instead of creating a new PR
  - Or close the old PR and create a new one if the fix set changed significantly
- [ ] Add a `--input fixUpdateStrategy=update|recreate` option
- [ ] Implement branch force-push policy with safeguards

**Context**: `create-change-request` now reuses an existing PR/MR by branch pair (PR #124), but there is no workflow node for updating an existing stacked branch with new commits and pushing to the existing PR.

### 3.2 Deterministic stacked-fix dogfood fixture
- [ ] Create a test fixture PR or branch that deterministically produces CRITICAL/HIGH findings
- [ ] Use the fixture to verify the full stacked-fix flow end-to-end:
  - review -> artifact -> threshold -> branch -> fix -> commit -> push -> create PR
- [ ] Run this as a CI job or local integration test
- [ ] Verify the stacked PR is created and contains the expected fixes

**Context**: The dogfood wrapper passes `fixCreateChangeRequest=true`, but the model review output is nondeterministic. PR #123's dogfood run did not create a stacked PR because no CRITICAL/HIGH findings were produced. A deterministic fixture would make the dogfood test reliable.

### 3.3 Avoid recursive stacks by default
- [x] Reserved DRS branch prefixes (`drs-fix/`, `drs-guidance/`) are checked by `stack-guard` action
- [ ] Verify that a stacked fix PR itself, when reviewed by DRS, does not trigger another stacked fix
- [ ] Add integration test for the recursive stack guard

**Context**: `stack-guard` action exists and prevents stacking on reserved branches. The guard is in the packaged `github-pr-review` workflow. Needs verification that the `pull_request_target` trigger on the stacked PR does not recurse.

---

## 4. Model Configuration and Reliability

### 4.1 Default model resolution
- [ ] Verify `opencode-go/glm-5.1` default model is reliably available
- [ ] Consider updating the default model if `glm-5.1` is deprecated
- [ ] Document model namespace overrides in config

**Context**: Prior dogfood runs failed with `Failed to resolve model "opencode-go/glm-5.1"`. The task namespace was overridden to `opencode-go/kimi-k2.7-code` as a workaround. The default model may need updating.

### 4.2 Review/visual/task namespace model stability
- [ ] Confirm `opencode-go/kimi-k2.7-code` is stable for review, visual, and task namespaces
- [ ] Add fallback model handling if the primary model is unavailable
- [ ] Consider model-specific prompt tuning if output quality varies

**Context**: `.drs/drs.config.yaml` sets `agents.namespaces.review.model`, `agents.namespaces.visual.model`, and `agents.namespaces.task.model` to `opencode-go/kimi-k2.7-code`.

---

## 5. External Research Adoption (adamsreview)

### 5.1 Freshness/staleness checks
- [ ] Implement a cheap gate that checks whether the review artifact is stale relative to the current head SHA
- [ ] Skip re-review if the artifact was created for the same SHA and inputs
- [ ] Invalidate artifact when the diff changes

**Context**: `/tmp/opencode/adamsreview/docs/state-and-gates.md` describes freshness/staleness gates. DRS currently re-reviews on every run without checking if an existing artifact is still valid.

### 5.2 Finding state machine and scoring
- [ ] Formalize the finding state transitions: `open -> attempted -> resolved | partial | regression`
- [ ] Add a scoring/gate function that computes overall review health from finding dispositions
- [ ] Use the score to gate the fix flow (e.g., skip fix if all findings are already resolved)

**Context**: `src/lib/review-artifact.ts` defines `ReviewFindingState` and `ReviewFindingDisposition` types but there is no state machine enforcement or scoring function. adamsreview's `docs/state-and-gates.md` has a scoring model.

### 5.3 Helper script contracts
- [ ] Consider exposing CLI commands or workflow actions for common artifact operations:
  - list findings by state/severity
  - export artifact as markdown
  - compare two artifacts (before/after fix)

**Context**: `/tmp/opencode/adamsreview/docs/helpers.md` documents helper scripts for artifact operations. DRS has workflow actions but no standalone CLI commands for artifact inspection.

---

## 6. CI and Dogfood

### 6.1 GitHub Actions PR review wrapper
- [x] Trusted wrapper passes `fix=true` and `fixCreateChangeRequest=true`
- [x] External wrapper passes `fix=false`
- [x] Visual explainer artifacts uploaded
- [x] `.drs/artifacts/**` uploaded
- [ ] Add `--resume` to the trusted wrapper so transient failures can retry
- [ ] Verify `pull_request_target` runs workflow YAML from `main` (not PR branch)

**Context**: `.github/workflows/pr-review.yml` is the active PR automation wrapper. Adding `--resume` would allow failed review runs to retry from checkpoint without re-running completed nodes.

### 6.2 Manual stacked workflow wrappers
- [x] `.github/workflows/drs-guidance-stacked.yml` exists
- [x] `.github/workflows/drs-fix-stacked.yml` exists
- [ ] Add `--resume` support to manual wrappers
- [ ] Document manual wrapper usage

**Context**: Manual dispatch wrappers exist for stacked guidance and stacked fix workflows but do not support checkpoint resume.

---

## 7. PR #124 Finalization

### 7.1 Merge PR #124
- [ ] Confirm all review comments are addressed
- [ ] Run `npm run check:all` one final time
- [ ] Merge PR #124 using a merge commit
- [ ] Verify dogfood review runs against the merged `main`

### 7.2 Post-merge cleanup
- [ ] Delete `workflow-checkpoints-resume` branch after merge
- [ ] Verify checkpoint files are not committed (`.gitignore` covers them)
- [ ] Run a dogfood PR review to confirm the merged code works end-to-end

---

## Priority Order

1. **PR #124 finalization** (Section 7) — unblock all downstream work
2. **Full quality gate** (Section 1.5) — ensure current branch is clean
3. **Checkpoint hardening** (Section 1.1-1.4) — make resume production-safe
4. **Artifact-aware fix verification** (Section 2) — close the fix feedback loop
5. **Stacked workflow improvements** (Section 3) — make stacked fixes reliable
6. **CI resume support** (Section 6.1) — enable retry on transient failures
7. **Model reliability** (Section 4) — ensure stable dogfood runs
8. **adamsreview adoption** (Section 5) — incremental quality improvements
