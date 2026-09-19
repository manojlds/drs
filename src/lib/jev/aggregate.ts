import type { JevAnswer, JevResponse } from './schema.js';
import type { JevChunkEvaluation } from './chunks.js';

export function aggregateJevResponses(chunks: readonly JevChunkEvaluation[]): JevResponse {
  if (chunks.length === 0) throw new Error('Jev evaluation produced no completed chunks.');
  if (chunks.length === 1) return chunks[0].response;
  const model = chunks[0].response.model;
  if (chunks.some((chunk) => chunk.response.model !== model)) {
    throw new Error('Jev chunks returned inconsistent model identities.');
  }
  const answerIds = Object.keys(chunks[0].response.answers);
  if (
    chunks.some(
      (chunk) =>
        Object.keys(chunk.response.answers).length !== answerIds.length ||
        answerIds.some((id) => chunk.response.answers[id] === undefined)
    )
  ) {
    throw new Error('Jev chunks returned inconsistent answer sets.');
  }

  return {
    model,
    answers: Object.fromEntries(
      answerIds.map((id) => [
        id,
        aggregateAnswer(
          chunks.map((chunk) => ({ answer: chunk.response.answers[id], weight: chunk.weight })),
          id
        ),
      ])
    ),
    usage: {
      input_tokens: chunks.reduce((sum, chunk) => sum + chunk.response.usage.input_tokens, 0),
      output_tokens: chunks.reduce((sum, chunk) => sum + chunk.response.usage.output_tokens, 0),
    },
  };
}

function aggregateAnswer(
  values: Array<{ answer: JevAnswer; weight: number }>,
  answerId: string
): JevAnswer {
  const first = values[0].answer;
  if (values.some(({ answer }) => answer.type !== first.type)) {
    throw new Error(`Jev chunks returned inconsistent answer types for ${answerId}.`);
  }
  const totalWeight = values.reduce((sum, value) => sum + value.weight, 0);
  if (first.type === 'noul') {
    return {
      type: 'noul',
      noul: weightedMean(
        values.map(({ answer, weight }) => ({
          value: answer.type === 'noul' ? answer.noul : 0,
          weight,
        })),
        totalWeight
      ),
    };
  }
  if (first.type === 'score') {
    const scoreValues = values.map(({ answer, weight }) => ({
      answer: answer.type === 'score' ? answer : first,
      weight,
    }));
    const probabilityKeys = Object.keys(first.probabilities);
    assertProbabilityKeys(
      scoreValues.map((value) => value.answer.probabilities),
      probabilityKeys,
      answerId
    );
    return {
      type: 'score',
      score: weightedMean(
        scoreValues.map(({ answer, weight }) => ({ value: answer.score, weight })),
        totalWeight
      ),
      legend: first.legend,
      probabilities: aggregateProbabilities(scoreValues, probabilityKeys, totalWeight),
      confidence: weightedMean(
        scoreValues.map(({ answer, weight }) => ({ value: answer.confidence, weight })),
        totalWeight
      ),
    };
  }
  const choiceValues = values.map(({ answer, weight }) => ({
    answer: answer.type === 'choice' ? answer : first,
    weight,
  }));
  const probabilityKeys = Object.keys(first.probabilities);
  assertProbabilityKeys(
    choiceValues.map((value) => value.answer.probabilities),
    probabilityKeys,
    answerId
  );
  const probabilities = aggregateProbabilities(choiceValues, probabilityKeys, totalWeight);
  const choice =
    probabilityKeys.length > 0
      ? probabilityKeys.reduce((best, key) =>
          probabilities[key] > probabilities[best] ? key : best
        )
      : aggregateSelectedChoice(choiceValues);
  return {
    type: 'choice',
    choice,
    probabilities,
    confidence: weightedMean(
      choiceValues.map(({ answer, weight }) => ({ value: answer.confidence, weight })),
      totalWeight
    ),
  };
}

function aggregateSelectedChoice(
  values: Array<{ answer: { choice: string }; weight: number }>
): string {
  const weights = new Map<string, number>();
  for (const { answer, weight } of values) {
    weights.set(answer.choice, (weights.get(answer.choice) ?? 0) + weight);
  }
  return [...weights.entries()].sort(
    ([leftChoice, leftWeight], [rightChoice, rightWeight]) =>
      rightWeight - leftWeight || leftChoice.localeCompare(rightChoice)
  )[0][0];
}

function aggregateProbabilities(
  values: Array<{ answer: { probabilities: Record<string, number> }; weight: number }>,
  keys: string[],
  totalWeight: number
): Record<string, number> {
  return Object.fromEntries(
    keys.map((key) => [
      key,
      weightedMean(
        values.map(({ answer, weight }) => ({ value: answer.probabilities[key], weight })),
        totalWeight
      ),
    ])
  );
}

function assertProbabilityKeys(
  maps: Array<Record<string, number>>,
  keys: string[],
  answerId: string
): void {
  if (
    maps.some((map) => {
      const candidate = Object.keys(map);
      return candidate.length !== keys.length || keys.some((key) => map[key] === undefined);
    })
  ) {
    throw new Error(`Jev chunks returned inconsistent probability sets for ${answerId}.`);
  }
}

function weightedMean(
  values: Array<{ value: number; weight: number }>,
  totalWeight: number
): number {
  const value = values.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / totalWeight;
  return Math.round(value * 1_000_000) / 1_000_000;
}
