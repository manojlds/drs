import Ajv from 'ajv';
import { Type, type Static } from '@sinclair/typebox';

export const GUIDANCE_RUBRIC_VERSION = 1;
export const DEFAULT_GUIDANCE_THRESHOLDS = { act: 0.8, flag: 0.5 } as const;

const boundedString = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const strictObject = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const GuidanceBooleanQuestionSchema = strictObject({
  type: Type.Literal('boolean'),
  instructions: boundedString(2000),
  violating: Type.Boolean(),
  criteria: Type.Optional(
    strictObject({
      true: Type.Optional(Type.String({ maxLength: 1000 })),
      false: Type.Optional(Type.String({ maxLength: 1000 })),
    })
  ),
});

const GuidanceChoiceQuestionSchema = strictObject({
  type: Type.Literal('choice'),
  instructions: boundedString(2000),
  criteria: Type.Record(boundedString(100), Type.String({ maxLength: 1000 })),
  violating: Type.Array(boundedString(100), { minItems: 1, maxItems: 100, uniqueItems: true }),
});

const GuidanceScoreQuestionSchema = strictObject({
  type: Type.Literal('score'),
  instructions: boundedString(2000),
  criteria: Type.Array(Type.String({ maxLength: 1000 }), { minItems: 2, maxItems: 10 }),
  violatingFrom: Type.Integer({ minimum: 1 }),
});

export const GuidanceQuestionSchema = Type.Union([
  GuidanceBooleanQuestionSchema,
  GuidanceChoiceQuestionSchema,
  GuidanceScoreQuestionSchema,
]);

const GuidanceSourceReferenceSchema = strictObject({
  path: boundedString(4096),
  line: Type.Integer({ minimum: 1 }),
});

export const GuidanceRubricSourceSchema = strictObject({
  path: boundedString(4096),
  sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  scope: boundedString(4096),
});

const GuidanceLintCheckSchema = strictObject({
  type: Type.Literal('lint'),
  how: Type.Optional(boundedString(500)),
  pattern: Type.Optional(boundedString(1000)),
  overlaps: Type.Optional(boundedString(300)),
});

const GuidanceModelCheckSchema = strictObject({
  type: Type.Literal('model'),
  question: GuidanceQuestionSchema,
  overlaps: Type.Optional(boundedString(300)),
});

const GuidanceDeferredCheckSchema = strictObject({
  type: Type.Literal('deferred'),
  reason: boundedString(500),
});

const GuidanceUnenforceableCheckSchema = strictObject({
  type: Type.Literal('unenforceable'),
  reason: boundedString(500),
});

export const GuidanceCheckSchema = Type.Union([
  GuidanceLintCheckSchema,
  GuidanceModelCheckSchema,
  GuidanceDeferredCheckSchema,
  GuidanceUnenforceableCheckSchema,
]);

export const GuidanceRuleSchema = strictObject({
  id: Type.String({ pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 100 }),
  text: boundedString(1000),
  source: GuidanceSourceReferenceSchema,
  scope: Type.Array(boundedString(4096), { minItems: 1, maxItems: 100, uniqueItems: true }),
  when: Type.Literal('change'),
  check: GuidanceCheckSchema,
  status: Type.Union([
    Type.Literal('active'),
    Type.Literal('weak'),
    Type.Literal('noisy'),
    Type.Literal('disabled'),
  ]),
});

export const GuidanceRubricSchema = strictObject({
  version: Type.Literal(GUIDANCE_RUBRIC_VERSION),
  compiledAt: boundedString(100),
  compiledBy: Type.Optional(boundedString(200)),
  sources: Type.Array(GuidanceRubricSourceSchema, { minItems: 1, maxItems: 100 }),
  thresholds: strictObject({
    act: Type.Number({ minimum: 0, maximum: 1 }),
    flag: Type.Number({ minimum: 0, maximum: 1 }),
  }),
  rules: Type.Array(GuidanceRuleSchema, { maxItems: 1000 }),
});

export type GuidanceQuestion = Static<typeof GuidanceQuestionSchema>;
export type GuidanceCheck = Static<typeof GuidanceCheckSchema>;
export type GuidanceRule = Static<typeof GuidanceRuleSchema>;
export type GuidanceRubricSource = Static<typeof GuidanceRubricSourceSchema>;
export type GuidanceRubric = Static<typeof GuidanceRubricSchema>;
export type GuidanceRuleStatus = GuidanceRule['status'];
export type GuidanceBand = 'act' | 'flag' | 'clear';

const ajv = new Ajv({ allErrors: true });
const validateGuidanceRubric = ajv.compile(GuidanceRubricSchema);

export function parseGuidanceRubric(value: unknown): GuidanceRubric {
  if (!validateGuidanceRubric(value)) {
    throw new Error(`Guidance rubric is invalid: ${ajv.errorsText(validateGuidanceRubric.errors)}`);
  }

  const rubric = value as GuidanceRubric;
  validateRubricSemantics(rubric);
  return rubric;
}

function validateRubricSemantics(rubric: GuidanceRubric): void {
  const compiledAt = new Date(rubric.compiledAt);
  if (Number.isNaN(compiledAt.getTime()) || compiledAt.toISOString() !== rubric.compiledAt) {
    throw new Error('Guidance rubric compiledAt must be a canonical ISO timestamp.');
  }
  if (rubric.thresholds.flag >= rubric.thresholds.act) {
    throw new Error('Guidance rubric flag threshold must be lower than act threshold.');
  }

  const sourcePaths = new Set<string>();
  for (const source of rubric.sources) {
    assertSafeRelativePath(source.path, `source path ${source.path}`);
    assertSafeScope(source.scope, `source scope ${source.scope}`);
    if (sourcePaths.has(source.path)) {
      throw new Error(`Guidance rubric contains duplicate source path: ${source.path}`);
    }
    sourcePaths.add(source.path);
  }

  const ruleIds = new Set<string>();
  for (const rule of rubric.rules) {
    if (ruleIds.has(rule.id)) {
      throw new Error(`Guidance rubric contains duplicate rule id: ${rule.id}`);
    }
    ruleIds.add(rule.id);
    assertSafeRelativePath(rule.source.path, `rule ${rule.id} source path`);
    if (!sourcePaths.has(rule.source.path)) {
      throw new Error(`Guidance rule ${rule.id} references an unknown source: ${rule.source.path}`);
    }
    for (const scope of rule.scope) assertSafeScope(scope, `rule ${rule.id} scope`);
    validateCheck(rule);
  }
}

function validateCheck(rule: GuidanceRule): void {
  if (rule.check.type === 'lint' && !rule.check.how && !rule.check.pattern) {
    throw new Error(`Guidance lint rule ${rule.id} must define how or pattern.`);
  }
  if (rule.check.type !== 'model') return;

  const question = rule.check.question;
  if (question.type === 'choice') {
    const options = Object.keys(question.criteria);
    if (options.length < 2 || options.length > 100) {
      throw new Error(`Guidance choice rule ${rule.id} must define between 2 and 100 options.`);
    }
    if (options.some((option) => option.length === 0 || option.length > 100)) {
      throw new Error(`Guidance choice rule ${rule.id} has an invalid option name.`);
    }
    if (question.violating.some((option) => !options.includes(option))) {
      throw new Error(`Guidance choice rule ${rule.id} names an unknown violating option.`);
    }
    if (question.violating.length === options.length) {
      throw new Error(`Guidance choice rule ${rule.id} must have a compliant option.`);
    }
  }
  if (question.type === 'score' && question.violatingFrom >= question.criteria.length) {
    throw new Error(`Guidance score rule ${rule.id} has an invalid violatingFrom index.`);
  }
}

function assertSafeRelativePath(value: string, field: string): void {
  if (
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`Guidance rubric ${field} must be a safe repository-relative path.`);
  }
}

function assertSafeScope(value: string, field: string): void {
  if (
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error(`Guidance rubric ${field} must be a safe repository-relative glob.`);
  }
}
