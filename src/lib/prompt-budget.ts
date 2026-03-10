import { formatCount } from './format-utils.js';

const DEFAULT_TOKEN_ESTIMATE_DIVISOR = 4;

export interface PromptBudgetEstimate {
  characters: number;
  estimatedTokens: number;
  contextWindow?: number;
  contextUsagePercent?: number;
  tokenEstimateDivisor: number;
}

function resolveTokenEstimateDivisor(value?: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  return DEFAULT_TOKEN_ESTIMATE_DIVISOR;
}

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

export function formatPromptBudgetEstimate(
  agentLabel: string,
  estimate: PromptBudgetEstimate
): string {
  const base =
    `Prompt input (${agentLabel}): ` +
    `${formatCount(estimate.characters)} chars ≈ ${formatCount(estimate.estimatedTokens)} tokens`;

  if (estimate.contextWindow && estimate.contextUsagePercent !== undefined) {
    return (
      `${base} ` +
      `(${estimate.contextUsagePercent.toFixed(2)}% of ${formatCount(estimate.contextWindow)} context)`
    );
  }

  return base;
}
