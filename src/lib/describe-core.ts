import type { FileWithDiff } from './review-core.js';

const OUTPUT_SCHEMA = `Output requirements:
- You MUST call the write_json_output tool with:
  - outputType: "describe_output"
  - payload: the JSON object
  - After calling the tool, return only the JSON pointer returned by the tool
    (e.g. {"outputType":"describe_output","outputPath":".drs/describe-output.json"})
- Do not return raw JSON directly.
- Do not include markdown, code fences, or extra text.
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

function buildProjectContextSection(projectContext?: string): string {
  const trimmedContext = projectContext?.trim();
  if (!trimmedContext) return '';
  return /^#\s*project context/i.test(trimmedContext.split('\n')[0] ?? '')
    ? `${trimmedContext}\n\n`
    : `# Project Context\n\n${trimmedContext}\n\n`;
}

/**
 * Build base instructions for the describe agent.
 *
 * @param label - Human-readable label for the description (e.g., "PR #123", "MR !456")
 * @param files - List of files with optional diff content
 */
export function buildDescribeInstructions(
  label: string,
  files: FileWithDiff[],
  compressionSummary?: string,
  projectContext?: string
): string {
  const filesWithDiffs = files.filter((f) => f.patch);
  const hasDiffs = filesWithDiffs.length > 0;
  const fileList = files.map((f) => `- ${f.filename}`).join('\n');
  const contextSection = buildProjectContextSection(projectContext);

  const diffContent = hasDiffs
    ? filesWithDiffs.map((f) => `### ${f.filename}\n\`\`\`diff\n${f.patch}\n\`\`\``).join('\n\n')
    : '';

  return `${contextSection}Generate a comprehensive PR/MR description for ${label}.

Changed files:
${fileList}

${hasDiffs ? `## Diff Content\n\n${diffContent}\n` : ''}

${compressionSummary ? `${compressionSummary}\n\n` : ''}${OUTPUT_SCHEMA}

Instructions:
1. Focus on new or modified code (lines starting with + in diffs).
2. Summarize intent and impact. Avoid code review feedback.
3. Use the Read tool for additional context if needed.
4. Follow the output requirements and schema above exactly.`;
}

/**
 * Build instructions for the describe agent when using subagent-collected file summaries.
 *
 * Instead of receiving raw diffs in the prompt, the describe agent receives
 * pre-analyzed per-file change summaries from file-analyzer subagents.
 * This avoids token budget trimming and allows full coverage of all files.
 *
 * @param label - Human-readable label (e.g., "PR #123")
 * @param filesSummaryMarkdown - Combined markdown from file-analyzer subagents
 * @param projectContext - Optional project context
 */
export function buildDescribeInstructionsFromSummaries(
  label: string,
  filesSummaryMarkdown: string,
  projectContext?: string
): string {
  const contextSection = buildProjectContextSection(projectContext);

  return `${contextSection}Generate a comprehensive PR/MR description for ${label}.

## Per-File Change Summaries

The following summaries were produced by analyzing each file's diff individually.
Use them to understand what changed across the entire PR/MR.

${filesSummaryMarkdown}

${OUTPUT_SCHEMA}

Instructions:
1. Use the per-file summaries above to understand all changes.
2. You may use the Read tool to examine full files for additional context if needed.
3. Focus on new or modified code. Summarize intent and impact. Avoid code review feedback.
4. Follow the output requirements and schema above exactly.
5. Make sure every file mentioned in the summaries appears in the walkthrough.`;
}
