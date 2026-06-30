import { describe, expect, it } from 'vitest';
import { deriveTemporalWorkflowId } from './workflow-id.js';

describe('deriveTemporalWorkflowId', () => {
  it('derives a deterministic ID for GitHub PR triggers', () => {
    const id = deriveTemporalWorkflowId('drs', 'github-pr-review', {
      owner: 'octocat',
      repo: 'hello-world',
      pr: '456',
      post: 'true',
      fix: 'false',
    });

    expect(id).toBe('drs-github-pr-review-gh-octocat-hello-world-pr-456');
  });

  it('derives the same ID for the same GitHub PR regardless of option inputs', () => {
    const base = { owner: 'octocat', repo: 'hello-world', pr: '456' };
    const id1 = deriveTemporalWorkflowId('drs', 'github-pr-review', {
      ...base,
      post: 'true',
      fix: 'true',
    });
    const id2 = deriveTemporalWorkflowId('drs', 'github-pr-review', {
      ...base,
      post: 'false',
      fix: 'false',
    });

    expect(id1).toBe(id2);
  });

  it('derives a deterministic ID for GitLab MR triggers', () => {
    const id = deriveTemporalWorkflowId('drs', 'gitlab-mr-review', {
      project: 'org/repo',
      mr: '123',
      post: 'true',
    });

    expect(id).toBe('drs-gitlab-mr-review-gl-org-repo-mr-123');
  });

  it('sanitizes GitLab project paths with subgroups', () => {
    const id = deriveTemporalWorkflowId('drs', 'gitlab-mr-review', {
      project: 'org/subgroup/team/repo',
      mr: '7',
    });

    expect(id).toBe('drs-gitlab-mr-review-gl-org-subgroup-team-repo-mr-7');
  });

  it('produces different IDs for different PRs on the same repo', () => {
    const id1 = deriveTemporalWorkflowId('drs', 'github-pr-review', {
      owner: 'octocat',
      repo: 'hello-world',
      pr: '456',
    });
    const id2 = deriveTemporalWorkflowId('drs', 'github-pr-review', {
      owner: 'octocat',
      repo: 'hello-world',
      pr: '457',
    });

    expect(id1).not.toBe(id2);
  });

  it('falls back to a random UUID for workflows without a trigger identity', () => {
    const id1 = deriveTemporalWorkflowId('drs', 'local-review', { staged: 'true' });
    const id2 = deriveTemporalWorkflowId('drs', 'local-review', { staged: 'true' });

    expect(id1).toMatch(/^drs-local-review-[0-9a-f]{8}-/);
    expect(id1).not.toBe(id2);
  });

  it('falls back to a random UUID when inputs are empty', () => {
    const id = deriveTemporalWorkflowId('drs', 'smoke', {});

    expect(id).toMatch(/^drs-smoke-[0-9a-f]{8}-/);
  });

  it('respects the configured prefix', () => {
    const id = deriveTemporalWorkflowId('repo-maintenance', 'github-pr-review', {
      owner: 'octocat',
      repo: 'hello-world',
      pr: '1',
    });

    expect(id).toBe('repo-maintenance-github-pr-review-gh-octocat-hello-world-pr-1');
  });

  it('does not treat a partial GitHub input set as a GitHub trigger', () => {
    // Missing 'pr' — not a GitHub PR trigger
    const id = deriveTemporalWorkflowId('drs', 'some-workflow', {
      owner: 'octocat',
      repo: 'hello-world',
    });

    expect(id).toMatch(/^drs-some-workflow-[0-9a-f]{8}-/);
  });
});
