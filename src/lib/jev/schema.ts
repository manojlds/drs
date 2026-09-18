import Ajv from 'ajv';
import { Type, type Static } from '@sinclair/typebox';

const ProbabilityMapSchema = Type.Record(Type.String(), Type.Number({ minimum: 0, maximum: 1 }));

const JevNoulAnswerSchema = Type.Intersect([
  Type.Object({
    type: Type.Literal('noul'),
    noul: Type.Number({ minimum: 0, maximum: 1 }),
  }),
  Type.Record(Type.String(), Type.Unknown()),
]);

const JevChoiceAnswerSchema = Type.Intersect([
  Type.Object({
    type: Type.Literal('choice'),
    choice: Type.String(),
    probabilities: ProbabilityMapSchema,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  }),
  Type.Record(Type.String(), Type.Unknown()),
]);

const JevScoreAnswerSchema = Type.Intersect([
  Type.Object({
    type: Type.Literal('score'),
    score: Type.Number({ minimum: 0, maximum: 9 }),
    legend: Type.Record(Type.String(), Type.String()),
    probabilities: ProbabilityMapSchema,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  }),
  Type.Record(Type.String(), Type.Unknown()),
]);

export const JevAnswerSchema = Type.Union([
  JevNoulAnswerSchema,
  JevChoiceAnswerSchema,
  JevScoreAnswerSchema,
]);

export const JevResponseSchema = Type.Intersect([
  Type.Object({
    model: Type.String({ minLength: 1 }),
    answers: Type.Record(Type.String(), JevAnswerSchema),
    usage: Type.Intersect([
      Type.Object({
        input_tokens: Type.Integer({ minimum: 0 }),
        output_tokens: Type.Integer({ minimum: 0 }),
      }),
      Type.Record(Type.String(), Type.Unknown()),
    ]),
  }),
  Type.Record(Type.String(), Type.Unknown()),
]);

export type JevAnswer = Static<typeof JevAnswerSchema>;
export type JevResponse = Static<typeof JevResponseSchema>;

const ajv = new Ajv({ allErrors: true });
const validateJevResponse = ajv.compile(JevResponseSchema);

export function parseJevResponse(value: unknown): JevResponse {
  if (!validateJevResponse(value)) {
    throw new Error(ajv.errorsText(validateJevResponse.errors));
  }
  return value as JevResponse;
}
