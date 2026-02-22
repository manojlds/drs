import chalk from 'chalk';
import { formatCost, formatCount } from './format-utils.js';
import type { PlatformClient } from './platform-client.js';
import type { ReviewUsageSummary } from './review-usage.js';

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

function hasUsageDetails(usage?: ReviewUsageSummary): usage is ReviewUsageSummary {
  if (!usage) {
    return false;
  }

  return usage.agents.some((agent) => agent.turns > 0);
}

function formatUsageMarkdown(usage: ReviewUsageSummary): string {
  const total = usage.total;

  let markdown = '## 💰 Model Usage\n\n';
  markdown += '<details>\n<summary>View token and cost breakdown</summary>\n\n';
  markdown += `- **Input Tokens**: ${formatCount(total.input)}\n`;
  markdown += `- **Output Tokens**: ${formatCount(total.output)}\n`;
  markdown += `- **Cache Read Tokens**: ${formatCount(total.cacheRead)}\n`;
  markdown += `- **Cache Write Tokens**: ${formatCount(total.cacheWrite)}\n`;
  markdown += `- **Total Tokens**: ${formatCount(total.totalTokens)}\n`;
  markdown += `- **Estimated Cost**: ${formatCost(total.cost)}\n`;
  if (total.totalTokens > 0 && total.cost === 0) {
    markdown +=
      '- _Cost is $0.0000 because model pricing is unknown or configured as free. Add `pricing.models` in `.drs/drs.config.yaml` to override._\n';
  }
  markdown += '\n';

  if (usage.agents.length > 0) {
    markdown += '| Agent | Model | Turns | Input | Output | Total Tokens | Cost |\n';
    markdown += '| --- | --- | ---: | ---: | ---: | ---: | ---: |\n';

    for (const agent of usage.agents) {
      markdown += `| ${agent.agentType} | ${agent.model ?? 'n/a'} | ${formatCount(agent.turns)} | ${formatCount(agent.usage.input)} | ${formatCount(agent.usage.output)} | ${formatCount(agent.usage.totalTokens)} | ${formatCost(agent.usage.cost)} |\n`;
    }

    markdown += '\n';
  }

  markdown += '</details>\n\n';
  return markdown;
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
export function displayDescription(
  description: Description,
  platform: Platform = 'PR',
  usage?: ReviewUsageSummary
) {
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

  if (hasUsageDetails(usage)) {
    console.log(chalk.bold('💰 Model Usage'));
    console.log(chalk.white(`  Input tokens: ${formatCount(usage.total.input)}`));
    console.log(chalk.white(`  Output tokens: ${formatCount(usage.total.output)}`));
    console.log(chalk.white(`  Total tokens: ${formatCount(usage.total.totalTokens)}`));
    console.log(chalk.white(`  Estimated cost: ${formatCost(usage.total.cost)}`));
    if (usage.total.totalTokens > 0 && usage.total.cost === 0) {
      console.log(
        chalk.gray(
          '  Cost is $0.0000 because model pricing is unknown or configured as free. Configure pricing.models to override.'
        )
      );
    }

    const primaryAgent = usage.agents[0];
    if (primaryAgent) {
      console.log(
        chalk.dim(
          `  Agent: ${primaryAgent.agentType} | Model: ${primaryAgent.model ?? 'n/a'} | Turns: ${primaryAgent.turns}`
        )
      );
    }

    console.log();
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
const DESCRIPTION_COMMENT_ID = 'drs-description';

function findExistingDescriptionComment(comments: Array<{ id: number | string; body: string }>) {
  return (
    comments.find((comment) =>
      comment.body.includes(`<!-- drs-description-id: ${DESCRIPTION_COMMENT_ID} -->`)
    ) ?? null
  );
}

export function formatDescriptionAsMarkdown(
  description: Description,
  platform: Platform = 'PR',
  usage?: ReviewUsageSummary
): string {
  let markdown = `<!-- drs-description-id: ${DESCRIPTION_COMMENT_ID} -->\n`;
  markdown += `# 📋 ${platform} Description Analysis\n\n`;

  markdown += `## 🧭 Change Summary\n\n`;
  markdown += `- **Type**: ${description.type}\n`;
  markdown += `- **Title**: ${description.title}\n\n`;

  markdown += `## 📌 Summary\n\n`;
  for (const bullet of description.summary) {
    markdown += `- ${bullet}\n`;
  }
  markdown += '\n';

  if (description.walkthrough && description.walkthrough.length > 0) {
    markdown += '## 📂 Changes Walkthrough\n\n';
    markdown += '<details>\n<summary>View file-by-file changes</summary>\n\n';

    for (const fileChange of description.walkthrough) {
      const icon = getMarkdownChangeIcon(fileChange.changeType);
      markdown += `### ${icon} \`${fileChange.file}\` (${fileChange.semanticLabel})\n\n`;
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

  if (hasUsageDetails(usage)) {
    markdown += formatUsageMarkdown(usage);
  }

  if (description.labels && description.labels.length > 0) {
    markdown += '## 🏷️ Suggested Labels\n\n';
    markdown += description.labels.map((l: string) => `\`${l}\``).join(', ') + '\n\n';
  }

  if (description.recommendations && description.recommendations.length > 0) {
    markdown += '## 💡 Recommendations\n\n';
    for (const rec of description.recommendations) {
      markdown += `- ${rec}\n`;
    }
    markdown += '\n';
  }

  markdown += '\n---\n\n*Analyzed by **DRS** | Diff Review System*\n';

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
  platform: Platform = 'PR',
  usage?: ReviewUsageSummary
) {
  console.log(chalk.dim(`\nPosting description to ${platform}...`));

  const markdown = formatDescriptionAsMarkdown(description, platform, usage);
  const existingComments = await platformAdapter.getComments(projectId, prNumber);
  const existingDescription = findExistingDescriptionComment(existingComments);

  if (existingDescription) {
    await platformAdapter.updateComment(projectId, prNumber, existingDescription.id, markdown);
  } else {
    await platformAdapter.createComment(projectId, prNumber, markdown);
  }

  console.log(chalk.green(`✓ Description posted to ${platform}`));
}
