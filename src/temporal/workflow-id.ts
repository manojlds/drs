import { randomUUID } from 'crypto';

/**
 * Sanitize a value for safe inclusion in a Temporal workflow ID.
 *
 * Replaces any character outside [A-Za-z0-9._-] with a dash and trims leading
 * / trailing dashes, so values like GitLab project paths (`org/subgroup/repo`)
 * become ID-safe segments (`org-subgroup-repo`).
 */
function sanitizeIdSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

/**
 * Derive a deterministic Temporal workflow ID from the workflow name and
 * resolved inputs.
 *
 * DRS workflows are triggered by external events whose identity is stable
 * across re-deliveries (a webhook retried, a scheduler replay, a service
 * restart). A deterministic workflow ID lets Temporal's built-in workflow-ID
 * uniqueness deduplicate repeated triggers instead of scheduling duplicate
 * work.
 *
 * Recognized trigger patterns (based on the standard DRS workflow inputs):
 *
 * - **GitHub PR** — inputs contain `owner`, `repo`, and `pr`:
 *   `{prefix}-{workflowName}-gh-{owner}-{repo}-pr-{pr}`
 * - **GitLab MR** — inputs contain `project` and `mr`:
 *   `{prefix}-{workflowName}-gl-{project}-mr-{mr}`
 *
 * Workflows without a recognized external trigger identity (e.g. `local-review`,
 * one-off CLI runs, smoke tests) fall back to a random UUID suffix so each
 * dispatch is a fresh run — exactly the behavior expected for unique work.
 *
 * Callers that need full control (a service layer with a custom trigger
 * identity) can bypass this helper by passing an explicit `workflowId` in
 * {@link WorkflowRunOptions}.
 */
export function deriveTemporalWorkflowId(
  prefix: string,
  workflowName: string,
  inputs: Record<string, string>
): string {
  const safePrefix = sanitizeIdSegment(prefix);
  const safeName = sanitizeIdSegment(workflowName);

  const owner = inputs['owner'];
  const repo = inputs['repo'];
  const pr = inputs['pr'];

  if (owner && repo && pr) {
    return `${safePrefix}-${safeName}-gh-${sanitizeIdSegment(owner)}-${sanitizeIdSegment(repo)}-pr-${sanitizeIdSegment(pr)}`;
  }

  const project = inputs['project'];
  const mr = inputs['mr'];

  if (project && mr) {
    return `${safePrefix}-${safeName}-gl-${sanitizeIdSegment(project)}-mr-${sanitizeIdSegment(mr)}`;
  }

  return `${safePrefix}-${safeName}-${randomUUID()}`;
}
