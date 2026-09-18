import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface ActionStep {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface ActionJob {
  needs?: string;
  permissions?: Record<string, string>;
  steps: ActionStep[];
}

function loadReviewJobs(): Record<string, ActionJob> {
  const source = readFileSync(join(process.cwd(), '.github/workflows/pr-review.yml'), 'utf-8');
  return (parse(source) as { jobs: Record<string, ActionJob> }).jobs;
}

describe('external PR review workflow security', () => {
  it('runs the model from trusted base code with read-only GitHub permissions', () => {
    const job = loadReviewJobs()['review-external'];
    const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'))!;
    const review = job.steps.find((step) => step.name?.startsWith('Review Pull Request'))!;
    const upload = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'))!;

    expect(job.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    expect(checkout.with).toMatchObject({
      ref: '${{ github.event.pull_request.base.sha }}',
      'persist-credentials': false,
    });
    expect(review.run).toContain('--input post=false');
    expect(review.run).toContain('--input describe=true');
    expect(review.run).toContain('--input visual=false');
    expect(review.run).toContain('--input requireCompleteDiff=true');
    expect(review.run).not.toContain('--trace');
    expect(upload.with).toMatchObject({
      'if-no-files-found': 'error',
      'include-hidden-files': true,
      'retention-days': 1,
    });
  });

  it('uses a separate deterministic posting job without provider secrets', () => {
    const job = loadReviewJobs()['post-external-review'];
    const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'))!;
    const post = job.steps.find((step) => step.name === 'Validate and post external review')!;
    const serialized = JSON.stringify(job);

    expect(job.needs).toBe('review-external');
    expect(checkout.with).toMatchObject({
      ref: '${{ github.event.pull_request.base.sha }}',
      'persist-credentials': false,
    });
    expect(post.run).toContain('workflow run github-pr-review-post');
    expect(post.run).toContain('--input expectedHeadSha=');
    expect(serialized).not.toContain('secrets.DRS_PROVIDER_API_KEY');
    expect(serialized).not.toContain('secrets.OPENCODE_API_KEY');
    expect(serialized).not.toContain('secrets.JEV_API_KEY');
    expect(post.env?.JEV_API_KEY).toBe('');
    expect(post.env?.DRS_GITHUB_DEFAULT_ACTIONS_TOKEN).toBe('true');
    expect(serialized).not.toContain('workflow run github-pr-review \\');
  });

  it('exposes the Jev secret only to generation jobs when a trusted variable enables Jev', () => {
    const jobs = loadReviewJobs();
    for (const jobName of ['review-trusted', 'review-external']) {
      const review = jobs[jobName].steps.find((step) =>
        step.name?.startsWith('Review Pull Request')
      )!;
      expect(review.env?.DRS_REVIEW_MODE).toContain("vars.DRS_REVIEW_MODE || 'agent'");
      expect(review.env?.DRS_GITHUB_DEFAULT_ACTIONS_TOKEN).toBe('true');
      expect(review.env?.JEV_API_KEY).toContain('secrets.JEV_API_KEY');
      expect(review.env?.JEV_API_KEY).toContain("vars.DRS_REVIEW_MODE == 'jev'");
      expect(review.env?.JEV_API_KEY).toContain("vars.DRS_REVIEW_MODE == 'combined'");
      expect(review.run).toContain('--input reviewMode="$DRS_REVIEW_MODE"');
    }

    expect(JSON.stringify(jobs['verify-contributor'])).not.toContain('secrets.JEV_API_KEY');
    expect(JSON.stringify(jobs['post-external-review'])).not.toContain('secrets.JEV_API_KEY');
    expect(JSON.stringify(jobs['notify-external'])).not.toContain('secrets.JEV_API_KEY');
  });
});
