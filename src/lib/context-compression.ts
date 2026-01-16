import type { FileWithDiff } from './review-core.js';

export interface ContextCompressionOptions {
  enabled?: boolean;
  maxTokens?: number;
  softBufferTokens?: number;
  hardBufferTokens?: number;
  tokenEstimateDivisor?: number;
}

export interface ContextCompressionResult {
  files: FileWithDiff[];
  omitted: {
    deletionsOnly: string[];
    dueToBudget: string[];
  };
}

const DEFAULT_COMPRESSION_OPTIONS: Required<ContextCompressionOptions> = {
  enabled: true,
  maxTokens: 8000,
  softBufferTokens: 1500,
  hardBufferTokens: 1000,
  tokenEstimateDivisor: 4,
};

function normalizeOptions(
  options?: ContextCompressionOptions
): Required<ContextCompressionOptions> {
  return {
    ...DEFAULT_COMPRESSION_OPTIONS,
    ...options,
  };
}

function estimateTokens(text: string, divisor: number): number {
  const normalizedDivisor =
    divisor > 0 ? divisor : DEFAULT_COMPRESSION_OPTIONS.tokenEstimateDivisor;
  return Math.ceil(text.length / normalizedDivisor);
}

function buildDiffEntry(file: FileWithDiff): string {
  return `### ${file.filename}\n\n\`\`\`diff\n${file.patch}\n\`\`\``;
}

export function stripDeletionOnlyHunks(patch: string): string {
  const lines = patch.split('\n');
  const preserved: string[] = [];
  const prefix: string[] = [];
  let currentHunk: string[] = [];
  let sawHunk = false;
  let hunkHasAddition = false;

  const flushHunk = () => {
    if (currentHunk.length > 0) {
      if (hunkHasAddition) {
        preserved.push(...currentHunk);
      }
      currentHunk = [];
      hunkHasAddition = false;
    }
  };

  for (const line of lines) {
    if (line.startsWith('@@')) {
      sawHunk = true;
      flushHunk();
      currentHunk.push(line);
      continue;
    }

    if (!sawHunk) {
      prefix.push(line);
      continue;
    }

    currentHunk.push(line);
    if (line.startsWith('+') && !line.startsWith('+++')) {
      hunkHasAddition = true;
    }
  }

  flushHunk();

  if (!sawHunk) {
    return patch.trim();
  }

  if (preserved.length === 0) {
    return '';
  }

  return [...prefix, ...preserved].join('\n').trim();
}

export function compressFilesWithDiffs(
  files: FileWithDiff[],
  options?: ContextCompressionOptions
): ContextCompressionResult {
  const resolvedOptions = normalizeOptions(options);
  if (!resolvedOptions.enabled) {
    return {
      files,
      omitted: {
        deletionsOnly: [],
        dueToBudget: [],
      },
    };
  }

  const deletionsOnly: string[] = [];
  const budgetOmitted: string[] = [];

  const filesWithDiffs: FileWithDiff[] = [];
  for (const file of files) {
    if (!file.patch) continue;
    const trimmedPatch = stripDeletionOnlyHunks(file.patch ?? '');
    if (!trimmedPatch.trim()) {
      deletionsOnly.push(file.filename);
      continue;
    }
    filesWithDiffs.push({
      filename: file.filename,
      patch: trimmedPatch,
    });
  }

  if (filesWithDiffs.length === 0) {
    return {
      files,
      omitted: {
        deletionsOnly,
        dueToBudget: [],
      },
    };
  }

  const entries = filesWithDiffs.map((file) => {
    const entryText = buildDiffEntry(file);
    return {
      file,
      entryText,
      tokens: estimateTokens(entryText, resolvedOptions.tokenEstimateDivisor),
    };
  });

  const totalTokens = entries.reduce((sum, entry) => sum + entry.tokens, 0);
  const softLimit = resolvedOptions.maxTokens - resolvedOptions.softBufferTokens;
  const hardLimit = resolvedOptions.maxTokens - resolvedOptions.hardBufferTokens;

  if (totalTokens <= softLimit) {
    const patchLookup = new Map(filesWithDiffs.map((file) => [file.filename, file.patch]));
    return {
      files: files.map((file) =>
        file.patch ? { filename: file.filename, patch: patchLookup.get(file.filename) } : file
      ),
      omitted: {
        deletionsOnly,
        dueToBudget: [],
      },
    };
  }

  const sorted = [...entries].sort((a, b) => {
    if (b.tokens !== a.tokens) return b.tokens - a.tokens;
    return a.file.filename.localeCompare(b.file.filename);
  });

  const kept: FileWithDiff[] = [];
  let currentTokens = 0;

  for (const entry of sorted) {
    if (currentTokens > hardLimit) {
      budgetOmitted.push(entry.file.filename);
      continue;
    }

    if (currentTokens + entry.tokens > softLimit) {
      budgetOmitted.push(entry.file.filename);
      continue;
    }

    kept.push(entry.file);
    currentTokens += entry.tokens;
  }

  const keptLookup = new Map(kept.map((entry) => [entry.filename, entry.patch]));
  const keptFiles = files.map((file) => {
    if (!file.patch) return file;
    const keptPatch = keptLookup.get(file.filename);
    return keptPatch ? { filename: file.filename, patch: keptPatch } : { filename: file.filename };
  });

  return {
    files: keptFiles,
    omitted: {
      deletionsOnly,
      dueToBudget: budgetOmitted,
    },
  };
}

export function formatCompressionSummary(result: ContextCompressionResult): string {
  const sections: string[] = [];

  if (result.omitted.deletionsOnly.length > 0) {
    sections.push(
      `- Deletions-only changes (omitted from diff content):\n${result.omitted.deletionsOnly
        .map((name) => `  - ${name}`)
        .join('\n')}`
    );
  }

  if (result.omitted.dueToBudget.length > 0) {
    sections.push(
      `- Omitted due to token budget:\n${result.omitted.dueToBudget
        .map((name) => `  - ${name}`)
        .join('\n')}`
    );
  }

  if (sections.length === 0) {
    return '';
  }

  return `## Omitted Files\n\n${sections.join('\n\n')}`;
}
