import chalk from 'chalk';
import { getDescriberModelOverride, type DRSConfig } from '../lib/config.js';
import { createGitHubClient } from '../github/client.js';
import { GitHubPlatformAdapter } from '../github/platform-adapter.js';
import { createOpencodeClientInstance } from '../opencode/client.js';
import { buildDescribeInstructions } from '../lib/describe-core.js';
import {
  displayDescription,
  normalizeDescription,
  postDescription,
} from '../lib/description-formatter.js';
import type { FileChange } from '../lib/platform-client.js';
import { compressFilesWithDiffs, formatCompressionSummary } from '../lib/context-compression.js';

export interface DescribePROptions {
  owner: string;
  repo: string;
  prNumber: number;
  postDescription?: boolean;
  outputPath?: string;
  jsonOutput?: boolean;
  debug?: boolean;
}

export async function describePR(config: DRSConfig, options: DescribePROptions) {
  console.log(chalk.bold.blue('\n🔍 Generating PR Description\n'));

  // Initialize GitHub client
  const githubClient = createGitHubClient();
  const platformAdapter = new GitHubPlatformAdapter(githubClient);
  const projectId = `${options.owner}/${options.repo}`;

  // Fetch PR files
  console.log(
    chalk.dim(`Fetching PR #${options.prNumber} from ${options.owner}/${options.repo}...`)
  );

  const files = await githubClient.getPRFiles(options.owner, options.repo, options.prNumber);

  console.log(chalk.dim(`Found ${files.length} changed files\n`));

  // Build context for the describer agent
  const label = `PR #${options.prNumber}`;
  const filesWithDiffs = files.map((file: FileChange) => ({
    filename: file.filename,
    patch: file.patch,
  }));

  const compression = compressFilesWithDiffs(filesWithDiffs, config.contextCompression);
  const compressionSummary = formatCompressionSummary(compression);

  if (compressionSummary) {
    console.log(chalk.yellow('⚠ Diff content trimmed to fit token budget.\n'));
  }

  const instructions = buildDescribeInstructions(label, compression.files, compressionSummary);

  if (options.debug) {
    console.log(chalk.yellow('\n=== Agent Instructions ==='));
    console.log(instructions);
    console.log(chalk.yellow('=== End Instructions ===\n'));
  }

  // Initialize OpenCode client with model overrides
  const modelOverrides = getDescriberModelOverride(config);
  const opencode = await createOpencodeClientInstance({
    baseUrl: config.opencode.serverUrl ?? undefined,
    directory: process.cwd(),
    modelOverrides,
    provider: config.opencode.provider,
    debug: options.debug,
  });

  try {
    console.log(chalk.dim('Running PR describer agent...\n'));

    // Run the describer agent
    const session = await opencode.createSession({
      agent: 'describe/pr-describer',
      message: instructions,
    });

    // Collect all assistant messages from the session
    let fullResponse = '';
    for await (const message of opencode.streamMessages(session.id)) {
      if (message.role === 'assistant') {
        fullResponse += message.content;
      }
    }

    // Parse the JSON output from the agent
    let description;
    try {
      // Extract JSON from the agent output
      const jsonMatch = fullResponse.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        description = JSON.parse(jsonMatch[1]);
      } else {
        // Try parsing the whole output as JSON
        description = JSON.parse(fullResponse);
      }
    } catch (parseError) {
      console.error(chalk.red('Failed to parse agent output as JSON'));
      console.log(chalk.dim('Agent output:'), fullResponse);
      throw new Error('Agent did not return valid JSON output');
    }

    let normalizedDescription;
    try {
      normalizedDescription = normalizeDescription(description);
    } catch (validationError) {
      console.error(chalk.red('Agent output did not match expected description schema'));
      console.log(chalk.dim('Agent output:'), fullResponse);
      throw validationError;
    }

    // Display the description
    displayDescription(normalizedDescription, 'PR');

    // Save to JSON file if requested
    if (options.outputPath) {
      const fs = await import('fs/promises');
      await fs.writeFile(
        options.outputPath,
        JSON.stringify(normalizedDescription, null, 2),
        'utf-8'
      );
      console.log(chalk.green(`\n✓ Description saved to ${options.outputPath}`));
    }

    // Output JSON if requested
    if (options.jsonOutput) {
      console.log('\n' + JSON.stringify(normalizedDescription, null, 2));
    }

    // Post description to PR if requested
    if (options.postDescription) {
      await postDescription(
        platformAdapter,
        projectId,
        options.prNumber,
        normalizedDescription,
        'PR'
      );
    }

    console.log(chalk.green('\n✓ PR description generated successfully\n'));
  } finally {
    await opencode.shutdown();
  }
}
