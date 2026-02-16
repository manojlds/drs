/**
 * Subagent adapter for the describe pipeline.
 *
 * Spawns file-analyzer agents in parallel (with concurrency limiting)
 * to analyze individual file diffs, then collects their markdown summaries.
 */

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import chalk from 'chalk';
import type { PiClient, SessionMessage } from './client.js';

export interface FileChangeSummary {
  filename: string;
  summary: string;
  success: boolean;
}

export interface CollectFileChangesResult {
  summaries: FileChangeSummary[];
  combinedMarkdown: string;
  filesAnalyzed: number;
  filesFailed: number;
}

const FILE_ANALYZER_AGENT = 'describe/file-analyzer';

function sanitizeFilename(filepath: string): string {
  return filepath.replace(/\//g, '__').replace(/^\.+/, '');
}

async function analyzeFile(
  opencode: PiClient,
  filename: string,
  diffCommand: string,
  debug: boolean
): Promise<FileChangeSummary> {
  const message = [
    `Analyze the changes to the file \`${filename}\`.`,
    '',
    `Run this command to get the diff:`,
    '```',
    `git diff ${diffCommand} -- ${filename}`,
    '```',
    '',
    `Then read the full file \`${filename}\` (if it still exists) for context.`,
    'Output your structured markdown summary.',
  ].join('\n');

  if (debug) {
    console.error(chalk.gray(`  📄 Analyzing: ${filename}`));
  }

  const session = await opencode.createSession({
    agent: FILE_ANALYZER_AGENT,
    message,
  });

  try {
    const messages: SessionMessage[] = [];
    for await (const msg of opencode.streamMessages(session.id)) {
      messages.push(msg);
    }

    const assistantMessages = messages.filter((m) => m.role === 'assistant');
    const summary = assistantMessages.map((m) => m.content).join('\n\n');

    if (!summary.trim()) {
      return { filename, summary: '', success: false };
    }

    return { filename, summary: summary.trim(), success: true };
  } finally {
    await opencode.closeSession(session.id);
  }
}

export async function collectFileChanges(
  opencode: PiClient,
  files: string[],
  diffCommand: string,
  workingDir: string,
  options?: {
    concurrency?: number;
    debug?: boolean;
  }
): Promise<CollectFileChangesResult> {
  const concurrency = options?.concurrency ?? 1;
  const debug = options?.debug ?? false;

  console.error(
    chalk.blue(`\n📂 Analyzing ${files.length} file(s) with concurrency ${concurrency}...\n`)
  );

  const summaries: FileChangeSummary[] = [];

  // Process files in batches
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    const batchNum = Math.floor(i / concurrency) + 1;
    const totalBatches = Math.ceil(files.length / concurrency);

    console.error(chalk.gray(`  Batch ${batchNum}/${totalBatches} (${batch.length} files)`));

    const results = await Promise.allSettled(
      batch.map((filename) => analyzeFile(opencode, filename, diffCommand, debug))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        summaries.push(result.value);
      } else {
        const errorMsg =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.error(chalk.yellow(`  ⚠ Failed to analyze file: ${errorMsg}`));
        summaries.push({ filename: '(unknown)', summary: '', success: false });
      }
    }
  }

  // Write individual summaries to .drs/file-changes/
  const outputDir = join(workingDir, '.drs', 'file-changes');
  await mkdir(outputDir, { recursive: true });

  for (const summary of summaries) {
    if (summary.success && summary.summary) {
      const sanitized = sanitizeFilename(summary.filename);
      const outputPath = join(outputDir, `${sanitized}.md`);
      await writeFile(outputPath, summary.summary, 'utf-8');
    }
  }

  // Combine all summaries
  const successfulSummaries = summaries.filter((s) => s.success && s.summary);
  const combinedMarkdown = successfulSummaries.map((s) => s.summary).join('\n\n---\n\n');

  const filesAnalyzed = successfulSummaries.length;
  const filesFailed = summaries.length - filesAnalyzed;

  console.error(
    chalk.blue(`\n✅ File analysis complete: ${filesAnalyzed} succeeded, ${filesFailed} failed\n`)
  );

  return {
    summaries,
    combinedMarkdown,
    filesAnalyzed,
    filesFailed,
  };
}
