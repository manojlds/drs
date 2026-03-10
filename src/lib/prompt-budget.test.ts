import { describe, expect, it } from 'vitest';
import { estimatePromptBudget, formatPromptBudgetEstimate } from './prompt-budget.js';

describe('estimatePromptBudget', () => {
  it('uses the default divisor when none is provided', () => {
    const estimate = estimatePromptBudget('a'.repeat(9));

    expect(estimate.tokenEstimateDivisor).toBe(4);
    expect(estimate.characters).toBe(9);
    expect(estimate.estimatedTokens).toBe(3);
  });

  it('uses a custom divisor when provided', () => {
    const estimate = estimatePromptBudget('a'.repeat(10), {
      tokenEstimateDivisor: 5,
    });

    expect(estimate.tokenEstimateDivisor).toBe(5);
    expect(estimate.estimatedTokens).toBe(2);
  });

  it('falls back to default divisor when custom divisor is invalid', () => {
    const estimate = estimatePromptBudget('a'.repeat(8), {
      tokenEstimateDivisor: 0,
    });

    expect(estimate.tokenEstimateDivisor).toBe(4);
    expect(estimate.estimatedTokens).toBe(2);
  });

  it('computes context usage percentage when context window is provided', () => {
    const estimate = estimatePromptBudget('a'.repeat(40), {
      tokenEstimateDivisor: 4,
      contextWindow: 100,
    });

    expect(estimate.estimatedTokens).toBe(10);
    expect(estimate.contextWindow).toBe(100);
    expect(estimate.contextUsagePercent).toBe(10);
  });
});

describe('formatPromptBudgetEstimate', () => {
  it('formats without context window details when unavailable', () => {
    const formatted = formatPromptBudgetEstimate(
      'review/security',
      estimatePromptBudget('a'.repeat(400))
    );

    expect(formatted).toContain('Prompt input (review/security):');
    expect(formatted).toContain('400 chars');
    expect(formatted).toContain('100 tokens');
    expect(formatted).not.toContain('context');
  });

  it('formats with context window details when available', () => {
    const formatted = formatPromptBudgetEstimate(
      'describe/pr-describer',
      estimatePromptBudget('a'.repeat(800), {
        tokenEstimateDivisor: 4,
        contextWindow: 2000,
      })
    );

    expect(formatted).toContain('Prompt input (describe/pr-describer):');
    expect(formatted).toContain('800 chars');
    expect(formatted).toContain('200 tokens');
    expect(formatted).toContain('10.00% of 2,000 context');
  });
});
