import chalk from 'chalk';
import { DRSConfig } from '../lib/config.js';
import { createGitHubClient } from '../github/client.js';
import { GitHubPlatformAdapter } from '../github/platform-adapter.js';
import { createOpencodeClientInstance } from '../opencode/client.js';
import { buildBaseInstructions } from '../lib/review-core.js';
import { displayDescription, postDescription } from '../lib/description-formatter.js';

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

  // Fetch PR details
  console.log(
    chalk.dim(`Fetching PR #${options.prNumber} from ${options.owner}/${options.repo}...`)
  );

  const prDetails = await platformAdapter.getPullRequest(projectId, options.prNumber);
  const files = await githubClient.getPRFiles(options.owner, options.repo, options.prNumber);

  console.log(chalk.dim(`Found ${files.length} changed files\n`));

  // Build context for the describer agent
  const label = `PR #${options.prNumber}`;
  const filesWithDiffs = files.map((file: any) => ({
    filename: file.filename,
    diff: file.patch,
  }));

  const instructions = buildBaseInstructions(label, filesWithDiffs);

  if (options.debug) {
    console.log(chalk.yellow('\n=== Agent Instructions ==='));
    console.log(instructions);
    console.log(chalk.yellow('=== End Instructions ===\n'));
  }

  // Initialize OpenCode client
  const opencode = await createOpencodeClientInstance({
    baseUrl: config.opencode.serverUrl || undefined,
    directory: process.cwd(),
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

    // Display the description
    displayDescription(description, 'PR');

    // Save to JSON file if requested
    if (options.outputPath) {
      const fs = await import('fs/promises');
      await fs.writeFile(options.outputPath, JSON.stringify(description, null, 2), 'utf-8');
      console.log(chalk.green(`\n✓ Description saved to ${options.outputPath}`));
    }

    // Output JSON if requested
    if (options.jsonOutput) {
      console.log('\n' + JSON.stringify(description, null, 2));
    }

    // Post description to PR if requested
    if (options.postDescription) {
      await postDescription(platformAdapter, projectId, options.prNumber, description, 'PR');
    }

    console.log(chalk.green('\n✓ PR description generated successfully\n'));
  } finally {
    await opencode.shutdown();
  }
}
