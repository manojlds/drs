import chalk from 'chalk';
import { getDescriberModelOverride, type DRSConfig } from '../lib/config.js';
import { createGitLabClient } from '../gitlab/client.js';
import { GitLabPlatformAdapter } from '../gitlab/platform-adapter.js';
import { createOpencodeClientInstance } from '../opencode/client.js';
import { buildDescribeInstructions } from '../lib/describe-core.js';
import {
  displayDescription,
  normalizeDescription,
  postDescription,
} from '../lib/description-formatter.js';
import type { FileChange } from '../lib/platform-client.js';
import { compressFilesWithDiffs, formatCompressionSummary } from '../lib/context-compression.js';

export interface DescribeMROptions {
  projectId: string;
  mrIid: number;
  postDescription?: boolean;
  outputPath?: string;
  jsonOutput?: boolean;
  debug?: boolean;
}

export async function describeMR(config: DRSConfig, options: DescribeMROptions) {
  console.log(chalk.bold.blue('\n🔍 Generating MR Description\n'));

  // Initialize GitLab client
  const gitlabClient = createGitLabClient();
  const platformAdapter = new GitLabPlatformAdapter(gitlabClient);

  // Fetch MR files
  console.log(chalk.dim(`Fetching MR !${options.mrIid} from project ${options.projectId}...`));

  const files = await platformAdapter.getChangedFiles(options.projectId, options.mrIid);

  console.log(chalk.dim(`Found ${files.length} changed files\n`));

  // Build context for the describer agent
  const label = `MR !${options.mrIid}`;
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
    console.log(chalk.dim('Running MR describer agent...\n'));

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
    displayDescription(normalizedDescription, 'MR');

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

    // Post description to MR if requested
    if (options.postDescription) {
      await postDescription(
        platformAdapter,
        options.projectId,
        options.mrIid,
        normalizedDescription,
        'MR'
      );
    }

    console.log(chalk.green('\n✓ MR description generated successfully\n'));
  } finally {
    await opencode.shutdown();
  }
}
