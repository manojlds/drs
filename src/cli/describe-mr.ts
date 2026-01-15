import chalk from 'chalk';
import { DRSConfig } from '../lib/config.js';
import { createGitLabClient } from '../gitlab/client.js';
import { GitLabPlatformAdapter } from '../gitlab/platform-adapter.js';
import { createOpencodeClientInstance } from '../opencode/client.js';
import { buildBaseInstructions } from '../lib/review-core.js';

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

  // Fetch MR details
  console.log(chalk.dim(`Fetching MR !${options.mrIid} from project ${options.projectId}...`));

  const mrDetails = await platformAdapter.getPullRequest(options.projectId, options.mrIid);
  const files = await platformAdapter.getChangedFiles(options.projectId, options.mrIid);

  console.log(chalk.dim(`Found ${files.length} changed files\n`));

  // Build context for the describer agent
  const label = `MR !${options.mrIid}`;
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

    // Post description to MR if requested
    if (options.postDescription) {
      await postDescriptionToMR(platformAdapter, options.projectId, options.mrIid, description);
    }

    console.log(chalk.green('\n✓ MR description generated successfully\n'));
  } finally {
    await opencode.shutdown();
  }
}

function displayDescription(description: any) {
  console.log(chalk.bold.cyan('📝 Generated MR Description\n'));

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

async function postDescriptionToMR(
  platformAdapter: GitLabPlatformAdapter,
  projectId: string,
  mrIid: number,
  description: any
) {
  console.log(chalk.dim('\nPosting description to MR...'));

  // Format the description as markdown
  let markdown = '## AI-Generated MR Description\n\n';

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

  // Post as a note (comment)
  await platformAdapter.createComment(projectId, mrIid, markdown);

  console.log(chalk.green('✓ Description posted to MR'));
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
