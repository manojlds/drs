import { formatCount } from './format-utils.js';

const DEFAULT_TOKEN_ESTIMATE_DIVISOR = 4;

/** Prefix used for prompt budget log lines to simplify CI filtering. */
export const PROMPT_BUDGET_LOG_PREFIX = '[prompt-budget]';

/**
 * Estimated prompt budget and optional context-window utilization.
 */
export interface PromptBudgetEstimate {
  /** Raw prompt character length. */
  characters: number;
  /** Estimated prompt tokens derived from character length. */
  estimatedTokens: number;
  /** Model context window used for utilization calculation (if known). */
  contextWindow?: number;
  /** Percentage of context window consumed by the prompt (if known). */
  contextUsagePercent?: number;
  /** Character-to-token divisor used for the estimate. */
  tokenEstimateDivisor: number;
}

function resolveTokenEstimateDivisor(value?: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  return DEFAULT_TOKEN_ESTIMATE_DIVISOR;
}

/**
 * Estimate prompt token usage from character length.
 */
export function estimatePromptBudget(
  prompt: string,
  options?: { tokenEstimateDivisor?: number; contextWindow?: number }
): PromptBudgetEstimate {
  const tokenEstimateDivisor = resolveTokenEstimateDivisor(options?.tokenEstimateDivisor);
  const characters = prompt.length;
  const estimatedTokens = Math.ceil(characters / tokenEstimateDivisor);

  const contextWindow =
    typeof options?.contextWindow === 'number' && Number.isFinite(options.contextWindow)
      ? options.contextWindow
      : undefined;

  const contextUsagePercent =
    contextWindow && contextWindow > 0 ? (estimatedTokens / contextWindow) * 100 : undefined;

  return {
    characters,
    estimatedTokens,
    contextWindow,
    contextUsagePercent,
    tokenEstimateDivisor,
  };
}

/**
 * Format a prompt budget estimate for human-readable logs.
 */
export function formatPromptBudgetEstimate(
  agentLabel: string,
  estimate: PromptBudgetEstimate
): string {
  const base =
    `${PROMPT_BUDGET_LOG_PREFIX} Prompt input (${agentLabel}): ` +
    `${formatCount(estimate.characters)} chars ≈ ${formatCount(estimate.estimatedTokens)} tokens`;

  if (estimate.contextWindow && estimate.contextUsagePercent !== undefined) {
    return (
      `${base} ` +
      `(${estimate.contextUsagePercent.toFixed(2)}% of ${formatCount(estimate.contextWindow)} context)`
    );
  }

  return base;
}
