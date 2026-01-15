import chalk from 'chalk';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import type { DRSConfig } from '../lib/config.js';
import { buildBaseInstructions, type FileWithDiff } from '../lib/review-core.js';
import { filterIgnoredFiles } from '../lib/review-orchestrator.js';
import { createGitHubClient } from '../github/client.js';
import { GitHubPlatformAdapter } from '../github/platform-adapter.js';
import { createGitLabClient } from '../gitlab/client.js';
import { GitLabPlatformAdapter } from '../gitlab/platform-adapter.js';

export interface ShowChangesOptions {
  owner?: string;
  repo?: string;
  prNumber?: number;
  projectId?: string;
  mrIid?: number;
  file?: string;
  outputPath?: string;
  jsonOutput?: boolean;
  workingDir?: string;
}

interface ShowChangesPayload {
  label: string;
  files: FileWithDiff[];
  instructions: string;
  metadata: {
    projectId: string;
    prNumber: number;
    title: string;
    sourceBranch: string;
    targetBranch: string;
    headSha: string;
  };
}

function parseNumber(value: string | number | undefined, label: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`${label} is required`);
}

function ensureFileMatch(files: FileWithDiff[], filename?: string): FileWithDiff[] {
  if (!filename) return files;
  const matches = files.filter((file) => file.filename === filename);
  if (matches.length === 0) {
    throw new Error(`No matching file "${filename}" found in PR/MR changes.`);
  }
  return matches;
}

export async function showChanges(config: DRSConfig, options: ShowChangesOptions): Promise<void> {
  const workingDir = options.workingDir || process.cwd();
  const isGitHub = Boolean(options.owner || options.repo || options.prNumber);
  const isGitLab = Boolean(options.projectId || options.mrIid);

  if (isGitHub && isGitLab) {
    throw new Error(
      'Specify either GitHub options (--owner/--repo/--pr) or GitLab options (--project/--mr), not both.'
    );
  }

  if (!isGitHub && !isGitLab) {
    throw new Error(
      'Specify GitHub options (--owner/--repo/--pr) or GitLab options (--project/--mr).'
    );
  }

  if (isGitHub) {
    const owner = options.owner;
    const repo = options.repo;
    if (!owner || !repo) {
      throw new Error('GitHub requires --owner and --repo');
    }
    const prNumber = parseNumber(options.prNumber, 'PR number (--pr)');
    const projectId = `${owner}/${repo}`;
    const githubClient = createGitHubClient();
    const platformClient = new GitHubPlatformAdapter(githubClient);

    const pr = await platformClient.getPullRequest(projectId, prNumber);
    const allFiles = await platformClient.getChangedFiles(projectId, prNumber);
    const filesWithDiffs: FileWithDiff[] = allFiles
      .filter((file) => file.status !== 'removed')
      .map((file) => ({ filename: file.filename, patch: file.patch }));

    const filteredNames = filterIgnoredFiles(
      filesWithDiffs.map((file) => file.filename),
      config
    );
    const filteredFiles = filesWithDiffs.filter((file) => filteredNames.includes(file.filename));
    const scopedFiles = ensureFileMatch(filteredFiles, options.file);

    const label = `PR/MR #${pr.number}`;
    const instructions = buildBaseInstructions(label, scopedFiles, 'git diff HEAD~1 -- <file>');

    const payload: ShowChangesPayload = {
      label,
      files: scopedFiles,
      instructions,
      metadata: {
        projectId,
        prNumber: pr.number,
        title: pr.title,
        sourceBranch: pr.sourceBranch,
        targetBranch: pr.targetBranch,
        headSha: pr.headSha,
      },
    };

    await writeOutput(payload, options.outputPath, options.jsonOutput, workingDir);
    return;
  }

  const projectId = options.projectId;
  if (!projectId) {
    throw new Error('GitLab requires --project');
  }
  const mrIid = parseNumber(options.mrIid, 'MR IID (--mr)');
  const gitlabClient = createGitLabClient();
  const platformClient = new GitLabPlatformAdapter(gitlabClient);

  const pr = await platformClient.getPullRequest(projectId, mrIid);
  const allFiles = await platformClient.getChangedFiles(projectId, mrIid);
  const filesWithDiffs: FileWithDiff[] = allFiles
    .filter((file) => file.status !== 'removed')
    .map((file) => ({ filename: file.filename, patch: file.patch }));

  const filteredNames = filterIgnoredFiles(
    filesWithDiffs.map((file) => file.filename),
    config
  );
  const filteredFiles = filesWithDiffs.filter((file) => filteredNames.includes(file.filename));
  const scopedFiles = ensureFileMatch(filteredFiles, options.file);

  const label = `PR/MR #${pr.number}`;
  const instructions = buildBaseInstructions(label, scopedFiles, 'git diff HEAD~1 -- <file>');

  const payload: ShowChangesPayload = {
    label,
    files: scopedFiles,
    instructions,
    metadata: {
      projectId,
      prNumber: pr.number,
      title: pr.title,
      sourceBranch: pr.sourceBranch,
      targetBranch: pr.targetBranch,
      headSha: pr.headSha,
    },
  };

  await writeOutput(payload, options.outputPath, options.jsonOutput, workingDir);
}

async function writeOutput(
  payload: ShowChangesPayload,
  outputPath?: string,
  jsonOutput?: boolean,
  workingDir: string = process.cwd()
): Promise<void> {
  const output = jsonOutput ? JSON.stringify(payload, null, 2) : payload.instructions;

  if (outputPath) {
    const fullPath = resolve(workingDir, outputPath);
    await writeFile(fullPath, output, 'utf-8');
    console.log(chalk.green(`✓ Output written to ${outputPath}\n`));
  }

  if (jsonOutput || !outputPath) {
    console.log(output);
  }
}
