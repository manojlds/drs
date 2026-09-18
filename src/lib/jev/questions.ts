import { metricDefinitions } from './metrics.js';

export type JevNoulQuestion = {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
};

export type JevScoreQuestion = {
  type: 'score';
  instructions: string;
  criteria: string[];
};

export type JevChoiceQuestion = {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
};

export type JevQuestion = JevNoulQuestion | JevScoreQuestion | JevChoiceQuestion;
export type JevQuestions = Record<string, JevQuestion>;

// Adapted from jev-review 0.1.1 (MIT), commit
// 57690af54ef7d862c2483342c1e61c14dffcf727.
export const SCORE_LEVELS = [
  '1 - Serious, fundamental problems; unsafe or substantially unfit.',
  '2 - Severe problems dominate; major rework is required.',
  '3 - Serious weaknesses; important behavior or design is unreliable.',
  '4 - Meaningful weaknesses materially impede quality.',
  '5 - Several consequential weaknesses remain.',
  '6 - Acceptable baseline, but notable improvement is warranted.',
  '7 - Sound overall with limited, concrete weaknesses.',
  '8 - Strong; only minor meaningful improvements are available.',
  '9 - Very strong and well fitted to its context.',
  '10 - Exceptional; little meaningful improvement is available. Use rarely.',
] as const;

export function questionId(metricKey: string, kind: 'applicable' | 'score' | 'weakness'): string {
  return `${metricKey}_${kind}`;
}

export function buildJevQuestions(): JevQuestions {
  const questions: JevQuestions = {};

  for (const definition of metricDefinitions) {
    const applicabilityInstruction = definition.conditional
      ? `Is ${definition.label} actually relevant and assessable from the supplied software-change state? Answer yes only when the state contains concrete evidence that this dimension matters; do not invent concerns. ${definition.guidance}`
      : `${definition.label} is a core software-change dimension. Answer yes when the state contains implementation evidence; answer no only when no implementation content is available. ${definition.guidance}`;

    questions[questionId(definition.key, 'applicable')] = {
      type: 'noul',
      instructions: applicabilityInstruction,
      criteria: {
        true: 'This dimension is relevant and the supplied state supports a defensible assessment.',
        false: 'This dimension is irrelevant here or the supplied state is insufficient.',
      },
    };

    questions[questionId(definition.key, 'score')] = {
      type: 'score',
      instructions: `Rate ${definition.label} for the implementation in the supplied software-change state. Evaluate consequences in context. ${definition.guidance}`,
      criteria: [...SCORE_LEVELS],
    };

    questions[questionId(definition.key, 'weakness')] = {
      type: 'choice',
      instructions: `Identify the single most consequential ${definition.label} weakness evidenced by the supplied software-change state. Choose no_material_issue when no listed concern is justified. Treat choices as rubric hints, not generated root-cause findings. Do not speculate beyond the state.`,
      criteria: definition.weaknesses,
    };
  }

  return questions;
}
