import chalk from 'chalk';
import { DRSConfig } from '../lib/config.js';
import { createGitHubClient } from '../github/client.js';
import { GitHubPlatformAdapter } from '../github/platform-adapter.js';
import { createOpencodeClientInstance } from '../opencode/client.js';
import { buildBaseInstructions } from '../lib/review-core.js';

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
    displayDescription(description);

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
      await postDescriptionToPR(platformAdapter, projectId, options.prNumber, description);
    }

    console.log(chalk.green('\n✓ PR description generated successfully\n'));
  } finally {
    await opencode.shutdown();
  }
}

function displayDescription(description: any) {
  console.log(chalk.bold.cyan('📝 Generated PR Description\n'));

  // Type
  console.log(chalk.bold('Type: ') + chalk.yellow(description.type));

  // Title
  console.log(chalk.bold('\nTitle:'));
  console.log(chalk.white(description.title));

  // Summary
  console.log(chalk.bold('\nSummary:'));
  for (const bullet of description.summary) {
    console.log(chalk.white(`  • ${bullet}`));
  }

  // Walkthrough
  if (description.walkthrough && description.walkthrough.length > 0) {
    console.log(chalk.bold('\n📂 Changes Walkthrough:\n'));

    for (const fileChange of description.walkthrough) {
      const icon = getChangeIcon(fileChange.changeType);
      const significance = fileChange.significance === 'major' ? chalk.red('⭐') : '';

      console.log(
        chalk.cyan(
          `${icon} ${fileChange.file} ${significance} (${fileChange.semanticLabel})`
        )
      );
      console.log(chalk.dim(`   ${fileChange.title}`));

      if (fileChange.changes && fileChange.changes.length > 0) {
        for (const change of fileChange.changes) {
          console.log(chalk.white(`     • ${change}`));
        }
      }
      console.log();
    }
  }

  // Labels
  if (description.labels && description.labels.length > 0) {
    console.log(chalk.bold('🏷️  Suggested Labels:'));
    console.log(chalk.white('  ' + description.labels.join(', ')));
  }

  // Recommendations
  if (description.recommendations && description.recommendations.length > 0) {
    console.log(chalk.bold('\n💡 Recommendations:\n'));
    for (const rec of description.recommendations) {
      console.log(chalk.yellow(`  • ${rec}`));
    }
  }
}

function getChangeIcon(changeType: string): string {
  switch (changeType) {
    case 'added':
      return chalk.green('+');
    case 'modified':
      return chalk.yellow('~');
    case 'deleted':
      return chalk.red('-');
    case 'renamed':
      return chalk.blue('→');
    default:
      return chalk.gray('•');
  }
}

async function postDescriptionToPR(
  platformAdapter: GitHubPlatformAdapter,
  projectId: string,
  prNumber: number,
  description: any
) {
  console.log(chalk.dim('\nPosting description to PR...'));

  // Format the description as markdown
  let markdown = '## AI-Generated PR Description\n\n';

  markdown += `**Type:** ${description.type}\n\n`;

  markdown += '### Summary\n\n';
  for (const bullet of description.summary) {
    markdown += `- ${bullet}\n`;
  }

  if (description.walkthrough && description.walkthrough.length > 0) {
    markdown += '\n### Changes Walkthrough\n\n';
    markdown += '<details>\n<summary>View file-by-file changes</summary>\n\n';

    for (const fileChange of description.walkthrough) {
      const icon = getMarkdownChangeIcon(fileChange.changeType);
      markdown += `#### ${icon} \`${fileChange.file}\` (${fileChange.semanticLabel})\n\n`;
      markdown += `**${fileChange.title}**\n\n`;

      if (fileChange.changes && fileChange.changes.length > 0) {
        for (const change of fileChange.changes) {
          markdown += `- ${change}\n`;
        }
        markdown += '\n';
      }
    }

    markdown += '</details>\n\n';
  }

  if (description.labels && description.labels.length > 0) {
    markdown += '### Suggested Labels\n\n';
    markdown += description.labels.map((l: string) => `\`${l}\``).join(', ') + '\n\n';
  }

  if (description.recommendations && description.recommendations.length > 0) {
    markdown += '### Recommendations\n\n';
    for (const rec of description.recommendations) {
      markdown += `- ${rec}\n`;
    }
    markdown += '\n';
  }

  markdown += '\n---\n*Generated by DRS - Diff Review System*\n';

  // Post as a comment
  await platformAdapter.createComment(projectId, prNumber, markdown);

  console.log(chalk.green('✓ Description posted to PR'));
}

function getMarkdownChangeIcon(changeType: string): string {
  switch (changeType) {
    case 'added':
      return '➕';
    case 'modified':
      return '✏️';
    case 'deleted':
      return '➖';
    case 'renamed':
      return '➡️';
    default:
      return '📄';
  }
}
