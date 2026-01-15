import chalk from 'chalk';
import type { PlatformClient } from './platform-client.js';

export interface DescriptionWalkthroughEntry {
  file: string;
  changeType: string;
  semanticLabel: string;
  title: string;
  changes?: string[];
  significance?: string;
}

export interface Description {
  type: string;
  title: string;
  summary: string[];
  walkthrough?: DescriptionWalkthroughEntry[];
  labels?: string[];
  recommendations?: string[];
}

function normalizeStringArray(value: unknown, fieldName: string, required = false): string[] {
  if (value == null) {
    if (required) {
      throw new Error(`Missing required field: ${fieldName}`);
    }
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`Field "${fieldName}" must be an array of strings`);
  }

  const invalidEntry = value.find((entry) => typeof entry !== 'string');
  if (invalidEntry !== undefined) {
    throw new Error(`Field "${fieldName}" must contain only strings`);
  }

  return value;
}

export function normalizeDescription(description: unknown): Description {
  if (!description || typeof description !== 'object') {
    throw new Error('Description output must be a JSON object');
  }

  const typedDescription = description as Record<string, unknown>;

  const typeValue = typedDescription.type;
  if (typeof typeValue !== 'string' || typeValue.trim().length === 0) {
    throw new Error('Missing required field: type');
  }

  const titleValue = typedDescription.title;
  if (typeof titleValue !== 'string' || titleValue.trim().length === 0) {
    throw new Error('Missing required field: title');
  }

  const summary = normalizeStringArray(typedDescription.summary, 'summary', true);
  const labels = normalizeStringArray(typedDescription.labels, 'labels');
  const recommendations = normalizeStringArray(typedDescription.recommendations, 'recommendations');

  const walkthroughValue = typedDescription.walkthrough;
  if (walkthroughValue != null && !Array.isArray(walkthroughValue)) {
    throw new Error('Field "walkthrough" must be an array');
  }

  const walkthrough = Array.isArray(walkthroughValue)
    ? walkthroughValue.map((entry, index) => {
        if (!entry || typeof entry !== 'object') {
          throw new Error(`Walkthrough entry ${index + 1} must be an object`);
        }
        const typedEntry = entry as Record<string, unknown>;
        const file = typedEntry.file;
        const changeType = typedEntry.changeType;
        const semanticLabel = typedEntry.semanticLabel;
        const title = typedEntry.title;

        if (typeof file !== 'string' || file.trim().length === 0) {
          throw new Error(`Walkthrough entry ${index + 1} is missing "file"`);
        }
        if (typeof changeType !== 'string' || changeType.trim().length === 0) {
          throw new Error(`Walkthrough entry ${index + 1} is missing "changeType"`);
        }
        if (typeof semanticLabel !== 'string' || semanticLabel.trim().length === 0) {
          throw new Error(`Walkthrough entry ${index + 1} is missing "semanticLabel"`);
        }
        if (typeof title !== 'string' || title.trim().length === 0) {
          throw new Error(`Walkthrough entry ${index + 1} is missing "title"`);
        }

        const changes = normalizeStringArray(typedEntry.changes, 'walkthrough.changes');

        return {
          file,
          changeType,
          semanticLabel,
          title,
          changes,
          significance:
            typeof typedEntry.significance === 'string' ? typedEntry.significance : undefined,
        };
      })
    : undefined;

  return {
    type: typeValue,
    title: titleValue,
    summary,
    walkthrough,
    labels,
    recommendations,
  };
}

export type Platform = 'PR' | 'MR';

/**
 * Display description to console
 */
export function displayDescription(description: Description, platform: Platform = 'PR') {
  console.log(chalk.bold.cyan(`📝 Generated ${platform} Description\n`));

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
        chalk.cyan(`${icon} ${fileChange.file} ${significance} (${fileChange.semanticLabel})`)
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

/**
 * Get colored terminal icon for change type
 */
export function getChangeIcon(changeType: string): string {
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

/**
 * Get markdown emoji icon for change type
 */
export function getMarkdownChangeIcon(changeType: string): string {
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

/**
 * Format description as markdown
 */
export function formatDescriptionAsMarkdown(
  description: Description,
  platform: Platform = 'PR'
): string {
  let markdown = `## AI-Generated ${platform} Description\n\n`;

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

  return markdown;
}

/**
 * Post description to PR/MR as comment
 */
export async function postDescription(
  platformAdapter: PlatformClient,
  projectId: string,
  prNumber: number,
  description: Description,
  platform: Platform = 'PR'
) {
  console.log(chalk.dim(`\nPosting description to ${platform}...`));

  const markdown = formatDescriptionAsMarkdown(description, platform);
  await platformAdapter.createComment(projectId, prNumber, markdown);

  console.log(chalk.green(`✓ Description posted to ${platform}`));
}
