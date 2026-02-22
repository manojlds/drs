import chalk from 'chalk';
import { getDescriberModelOverride, getRuntimeConfig, type DRSConfig } from '../lib/config.js';
import { createGitHubClient } from '../github/client.js';
import { GitHubPlatformAdapter } from '../github/platform-adapter.js';
import { createRuntimeClientInstance } from '../opencode/client.js';
import { buildDescribeInstructions } from '../lib/describe-core.js';
import { loadGlobalContext } from '../lib/context-loader.js';
import {
  displayDescription,
  normalizeDescription,
  postDescription,
} from '../lib/description-formatter.js';
import type { FileChange } from '../lib/platform-client.js';
import {
  prepareDiffsForAgent,
  formatCompressionSummary,
  resolveCompressionBudget,
} from '../lib/context-compression.js';
import { parseDescribeOutput } from '../lib/describe-parser.js';
import {
  aggregateAgentUsage,
  applyUsageMessage,
  createAgentUsageSummary,
} from '../lib/review-usage.js';

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

  // Initialize Pi runtime client with model overrides
  const modelOverrides = getDescriberModelOverride(config);
  const runtimeConfig = getRuntimeConfig(config);
  const configuredRuntimeEndpoint =
    runtimeConfig.serverUrl ?? process.env.PI_SERVER ?? process.env.OPENCODE_SERVER ?? undefined;

  if (configuredRuntimeEndpoint) {
    console.log(
      chalk.yellow(
        `⚠ Ignoring configured runtime endpoint (${configuredRuntimeEndpoint}). DRS uses Pi SDK in-process only.\n`
      )
    );
  }

  const runtimeClient = await createRuntimeClientInstance({
    directory: process.cwd(),
    modelOverrides,
    provider: runtimeConfig.provider,
    config,
    debug: options.debug,
  });

  const describeModelIds = [...new Set(Object.values(modelOverrides))].filter(
    (id): id is string => !!id
  );
  const contextWindow = runtimeClient.getMinContextWindow(describeModelIds);
  const compressionOptions = resolveCompressionBudget(contextWindow, config.contextCompression);

  const compression = prepareDiffsForAgent(filesWithDiffs, compressionOptions);
  const compressionSummary = formatCompressionSummary(compression);

  if (compressionSummary) {
    console.log(chalk.yellow('⚠ Diff content trimmed to fit token budget.\n'));
  }

  const includeProjectContext = config.describe?.includeProjectContext ?? true;
  const projectContext = includeProjectContext ? loadGlobalContext() : null;
  const instructions = buildDescribeInstructions(
    label,
    compression.files,
    compressionSummary,
    projectContext ?? undefined
  );

  if (options.debug) {
    console.log(chalk.yellow('\n=== Agent Instructions ==='));
    console.log(instructions);
    console.log(chalk.yellow('=== End Instructions ===\n'));
  }

  try {
    console.log(chalk.dim('Running PR describer agent...\n'));

    // Run the describer agent
    const agentType = 'describe/pr-describer';
    const session = await runtimeClient.createSession({
      agent: agentType,
      message: instructions,
    });

    // Collect all assistant messages from the session
    let usageByAgent = createAgentUsageSummary(agentType);
    let fullResponse = '';
    for await (const message of runtimeClient.streamMessages(session.id)) {
      if (message.role === 'assistant') {
        usageByAgent = applyUsageMessage(usageByAgent, message);
        fullResponse += message.content;
      }
    }

    // Parse the JSON output from the agent
    let description;
    try {
      description = await parseDescribeOutput(process.cwd(), options.debug, fullResponse);
    } catch (parseError) {
      console.error(chalk.red('Failed to parse agent output as JSON'));
      console.log(chalk.dim('Agent output:'), fullResponse);
      const reason = parseError instanceof Error ? `: ${parseError.message}` : '';
      throw new Error(`Agent did not return valid JSON output${reason}`);
    }

    let normalizedDescription;
    try {
      normalizedDescription = normalizeDescription(description);
    } catch (validationError) {
      console.error(chalk.red('Agent output did not match expected description schema'));
      console.log(chalk.dim('Agent output:'), fullResponse);
      throw validationError;
    }

    const usageSummary = aggregateAgentUsage([
      {
        ...usageByAgent,
        success: true,
      },
    ]);

    // Display the description unless we're posting it to avoid noisy CI logs
    if (options.postDescription) {
      console.log(
        chalk.gray(
          'Description generated (suppressed in logs because --post-description is enabled).'
        )
      );
    } else {
      displayDescription(normalizedDescription, 'PR', usageSummary);
    }

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
        'PR',
        usageSummary
      );
    }

    console.log(chalk.green('\n✓ PR description generated successfully\n'));
  } finally {
    await runtimeClient.shutdown();
  }
}
