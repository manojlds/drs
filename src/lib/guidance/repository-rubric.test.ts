import { describe, expect, it } from 'vitest';
import { assertGuidanceRubricCurrent, discoverGuidanceSources } from './discovery.js';
import { loadGuidanceRubric } from './rubric-file.js';

describe('committed guidance rubric', () => {
  it('matches the repository guidance sources', async () => {
    const projectRoot = process.cwd();
    const rubric = await loadGuidanceRubric(projectRoot);

    expect(() =>
      assertGuidanceRubricCurrent(rubric, discoverGuidanceSources(projectRoot))
    ).not.toThrow();
  });
});
