import type { FileWithDiff } from './review-core.js';

/**
 * Build base instructions for the describe agent.
 *
 * @param label - Human-readable label for the description (e.g., "PR #123", "MR !456")
 * @param files - List of files with optional diff content
 */
export function buildDescribeInstructions(
  label: string,
  files: FileWithDiff[],
  compressionSummary?: string
): string {
  const filesWithDiffs = files.filter((f) => f.patch);
  const hasDiffs = filesWithDiffs.length > 0;
  const fileList = files.map((f) => `- ${f.filename}`).join('\n');

  const diffContent = hasDiffs
    ? filesWithDiffs.map((f) => `### ${f.filename}\n\`\`\`diff\n${f.patch}\n\`\`\``).join('\n\n')
    : '';

  const outputSchema = `Output requirements:
- Return only raw JSON. No markdown, no code fences, no extra text.
- Output must start with "{" and end with "}".
- Follow this exact schema:
{
  "type": "feature" | "bugfix" | "refactor" | "docs" | "test" | "chore" | "perf",
  "title": "Concise, theme-capturing title (50-70 chars)",
  "summary": [
    "Bullet point 1 (max 12 words)",
    "Bullet point 2 (max 12 words)",
    "Bullet point 3 (max 12 words)"
  ],
  "walkthrough": [
    {
      "file": "path/to/file.ts",
      "changeType": "added" | "modified" | "deleted" | "renamed",
      "semanticLabel": "feature" | "bugfix" | "refactor" | "test" | "docs" | "infrastructure" | "configuration",
      "title": "Brief change description (5-10 words)",
      "changes": [
        "Specific change 1 (max 12 words)",
        "Specific change 2 (max 12 words)"
      ],
      "significance": "major" | "minor"
    }
  ],
  "labels": ["suggested", "labels", "for", "categorization"],
  "recommendations": [
    "Optional suggestion 1",
    "Optional suggestion 2"
  ]
}`;

  return `Generate a comprehensive PR/MR description for ${label}.

Changed files:
${fileList}

${hasDiffs ? `## Diff Content\n\n${diffContent}\n` : ''}

${compressionSummary ? `${compressionSummary}\n\n` : ''}${outputSchema}

Instructions:
1. Focus on new or modified code (lines starting with + in diffs).
2. Summarize intent and impact. Avoid code review feedback.
3. Use the Read tool for additional context if needed.
4. Follow the output requirements and schema above exactly.`;
}
