import chalk from 'chalk';
import { getDescriberModelOverride, getRuntimeConfig, type DRSConfig } from '../lib/config.js';
import { createGitLabClient } from '../gitlab/client.js';
import { GitLabPlatformAdapter } from '../gitlab/platform-adapter.js';
import { createRuntimeClientInstance } from '../runtime/client.js';
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

  // Initialize Pi runtime client with model overrides
  const modelOverrides = getDescriberModelOverride(config);
  const runtimeConfig = getRuntimeConfig(config);

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
    console.log(chalk.dim('Running MR describer agent...\n'));

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
      displayDescription(normalizedDescription, 'MR', usageSummary);
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

    // Post description to MR if requested
    if (options.postDescription) {
      await postDescription(
        platformAdapter,
        options.projectId,
        options.mrIid,
        normalizedDescription,
        'MR',
        usageSummary
      );
    }

    console.log(chalk.green('\n✓ MR description generated successfully\n'));
  } finally {
    await runtimeClient.shutdown();
  }
}
