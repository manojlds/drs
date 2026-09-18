import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type GitLabJob = {
  script?: string[];
  variables?: Record<string, string>;
};

describe('Jev CI secret boundaries', () => {
  it('keeps JEV_API_KEY out of the default GitLab template and requires explicit opt-in', () => {
    const source = readFileSync(join(process.cwd(), 'src/ci/gitlab-ci.template.yml'), 'utf-8');
    const pipeline = parse(source) as Record<string, GitLabJob>;
    const defaultReview = pipeline['.drs_review'];
    const jevReview = pipeline['.drs_review_jev'];

    expect(defaultReview.variables).not.toHaveProperty('JEV_API_KEY');
    expect(defaultReview.script?.join('\n')).toContain('--input reviewMode=agent');
    expect(jevReview.variables?.JEV_API_KEY).toBe('${JEV_API_KEY}');
    expect(jevReview.script?.join('\n')).toContain('--input reviewMode=combined');
  });
});
