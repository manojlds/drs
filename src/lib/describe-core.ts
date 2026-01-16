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

  return `Generate a comprehensive PR/MR description for ${label}.

Changed files:
${fileList}

${hasDiffs ? `## Diff Content\n\n${diffContent}\n` : ''}

${compressionSummary ? `${compressionSummary}\n\n` : ''}Instructions:
1. Focus on new or modified code (lines starting with + in diffs).
2. Summarize intent and impact. Avoid code review feedback.
3. Use the Read tool for additional context if needed.
4. Follow the JSON output schema exactly as defined in the describer agent prompt.`;
}
