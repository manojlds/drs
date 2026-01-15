import { z } from 'zod';

const lineRangeSchema = z.object({
  start: z.number(),
  end: z.number(),
  reason: z.string(),
});

const fileContextSchema = z.object({
  filename: z.string(),
  filePurpose: z.string(),
  changeDescription: z.string(),
  scopeContext: z.string(),
  dependencies: z.array(z.string()),
  concerns: z.array(z.string()),
  relatedLineRanges: z.array(lineRangeSchema),
});

const changeSummarySchema = z.object({
  type: z.enum(['feature', 'bugfix', 'refactor', 'docs', 'test', 'config', 'other']),
  description: z.string(),
  subsystems: z.array(z.string()),
  complexity: z.enum(['simple', 'medium', 'high']),
  riskLevel: z.enum(['low', 'medium', 'high']),
});

const diffAnalysisSchema = z.object({
  changeSummary: changeSummarySchema,
  recommendedAgents: z.array(z.string()),
  fileContexts: z.array(fileContextSchema),
  overallConcerns: z.array(z.string()),
});

export default {
  description: 'Validate diff analyzer JSON output matches the required schema',
  args: {
    content: z.string().describe('Draft JSON string to validate'),
  },
  async execute(args: { content: string }) {
    try {
      const parsed = JSON.parse(args.content);
      const result = diffAnalysisSchema.safeParse(parsed);
      if (!result.success) {
        const errors = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
        return {
          valid: false,
          errors,
          message: 'Invalid diff analysis JSON',
        };
      }
      return { valid: true, message: 'Diff analysis JSON is valid' };
    } catch (err: any) {
      return {
        valid: false,
        errors: [err?.message ?? 'Failed to parse JSON'],
        message: 'Invalid JSON',
      };
    }
  },
};
