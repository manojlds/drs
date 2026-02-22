import { describe, expect, it } from 'vitest';
import { formatDescriptionAsMarkdown, type Description } from './description-formatter.js';
import type { ReviewUsageSummary } from './review-usage.js';

describe('description-formatter', () => {
  it('includes usage section in markdown when usage is provided', () => {
    const description: Description = {
      type: 'feature',
      title: 'Add usage visibility',
      summary: ['Shows model usage and cost for describe output'],
      walkthrough: [
        {
          file: 'src/lib/description-formatter.ts',
          changeType: 'modified',
          semanticLabel: 'observability',
          title: 'Adds usage section rendering',
          changes: ['Add expandable model usage details block'],
        },
      ],
    };

    const usage: ReviewUsageSummary = {
      total: {
        input: 1500,
        output: 250,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1750,
        cost: 0.0312,
      },
      agents: [
        {
          agentType: 'describe/pr-describer',
          model: 'opencode/glm-5-free',
          turns: 1,
          success: true,
          usage: {
            input: 1500,
            output: 250,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1750,
            cost: 0.0312,
          },
        },
      ],
    };

    const markdown = formatDescriptionAsMarkdown(description, 'PR', usage);

    expect(markdown).toContain('# 📋 PR Description Analysis');
    expect(markdown).toContain('## 🧭 Change Summary');
    expect(markdown).toContain('## 📌 Summary');
    expect(markdown).toContain('## 📂 Changes Walkthrough');
    expect(markdown).toContain('## 💰 Model Usage');
    expect(markdown).toContain('View token and cost breakdown');
    expect(markdown).toContain('describe/pr-describer');
    expect(markdown).toContain('opencode/glm-5-free');
    expect(markdown).toContain('$0.0312');
  });
});
