import chalk from 'chalk';
import { Command, InvalidArgumentError } from 'commander';
import { buildWikiSite, serveWikiSite, type WikiSiteOptions } from '../lib/wiki-site.js';
import { waitForWikiSite } from '../lib/wiki-site-smoke.js';
import { searchWiki, type WikiSearchResult } from '../lib/wiki-search.js';

export function createWikiCommand(): Command {
  const command = new Command('wiki').description(
    'Search, build, serve, and verify an OKF repository wiki'
  );

  command
    .command('search <query...>')
    .description('Search OKF concepts without a model or generated site index')
    .option('--source <path>', 'Repository-relative OKF bundle root', 'wiki')
    .option('--limit <count>', 'Maximum results to return', parsePositiveInteger, 10)
    .option('--json', 'Output the search result as JSON')
    .action(async (query: string[], options) => {
      try {
        const result = await searchWiki(process.cwd(), query.join(' '), {
          source: stringOption(options.source),
          limit: options.limit,
        });
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else console.log(formatSearchResult(result));
      } catch (error) {
        printError(error);
        process.exitCode = 1;
      }
    });

  command
    .command('build')
    .description('Build a static website from an OKF bundle')
    .option('--source <path>', 'Repository-relative OKF bundle root', 'wiki')
    .option('--output <path>', 'Repository-relative site output directory', '.drs/wiki-site')
    .option('--base <path>', 'Public URL base path', '/')
    .option('--site-url <url>', 'Public site URL used by sitemap and llms.txt')
    .option('--repository <owner/name>', 'GitHub repository used by source links')
    .option('--title <title>', 'Site title')
    .option('--json', 'Output the build result as JSON')
    .action(async (options) => {
      try {
        const result = await buildWikiSite({
          ...toSiteOptions(options),
          quiet: options.json === true,
        });
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else console.log(`Built wiki site from ${result.source} to ${result.output}`);
      } catch (error) {
        printError(error);
        process.exitCode = 1;
      }
    });

  command
    .command('serve')
    .description('Start a local development server for an OKF bundle')
    .option('--source <path>', 'Repository-relative OKF bundle root', 'wiki')
    .option('--output <path>', 'Repository-relative site output directory', '.drs/wiki-site')
    .option('--base <path>', 'Public URL base path', '/')
    .option('--site-url <url>', 'Public site URL used by sitemap and llms.txt')
    .option('--repository <owner/name>', 'GitHub repository used by source links')
    .option('--title <title>', 'Site title')
    .option('--host <host>', 'Host interface', '127.0.0.1')
    .option('--port <port>', 'TCP port', parsePositiveInteger, 4173)
    .action(async (options) => {
      try {
        const server = await serveWikiSite({
          ...toSiteOptions(options),
          host: options.host,
          port: options.port,
        });
        const fallbackUrl = `http://${options.host}:${options.port}${options.base}`;
        console.log(`Serving wiki site at ${server.urls[0] ?? fallbackUrl}`);
        await waitForShutdown(() => server.close());
      } catch (error) {
        printError(error);
        process.exitCode = 1;
      }
    });

  command
    .command('check-site <url>')
    .description('Verify a deployed wiki site and its linked artifacts')
    .option(
      '--attempts <count>',
      'Maximum attempts while deployment propagates',
      parsePositiveInteger,
      6
    )
    .option('--delay-ms <milliseconds>', 'Delay between attempts', parseNonNegativeInteger, 5000)
    .option('--timeout-ms <milliseconds>', 'Timeout for each request', parsePositiveInteger, 15000)
    .option('--json', 'Output the check result as JSON')
    .action(async (url: string, options) => {
      try {
        const result = await waitForWikiSite(url, {
          attempts: options.attempts,
          delayMs: options.delayMs,
          timeoutMs: options.timeoutMs,
        });
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(
            `Verified ${result.baseUrl}: ${result.pagesChecked} page(s), ${result.assetsChecked} artifact(s)`
          );
        }
      } catch (error) {
        printError(error);
        process.exitCode = 1;
      }
    });

  return command;
}

function toSiteOptions(options: Record<string, unknown>): WikiSiteOptions {
  return {
    projectRoot: process.cwd(),
    source: stringOption(options.source),
    output: stringOption(options.output),
    base: stringOption(options.base),
    siteUrl: stringOption(options.siteUrl),
    repository: stringOption(options.repository),
    title: stringOption(options.title),
  };
}

function stringOption(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('Expected a positive integer.');
  }
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError('Expected a non-negative integer.');
  }
  return parsed;
}

function formatSearchResult(result: WikiSearchResult): string {
  if (result.results.length === 0) {
    return `No wiki concepts matched "${terminalText(result.query)}" in ${terminalText(result.source)}.`;
  }
  const summary =
    result.total === result.results.length
      ? `Found ${result.total} wiki concept(s) for "${terminalText(result.query)}" in ${terminalText(result.source)}.`
      : `Found ${result.total} wiki concept(s) for "${terminalText(result.query)}" in ${terminalText(result.source)}; showing ${result.results.length}.`;
  const matches = result.results.map((match, index) => {
    const metadata = match.tags.length > 0 ? ` | ${match.tags.join(', ')}` : '';
    return [
      `${index + 1}. ${match.title} [${match.type}] (score ${match.score}${metadata})`,
      `   ${terminalText(match.path)}`,
      `   ${match.snippet}`,
    ].join('\n');
  });
  return [summary, '', ...matches].join('\n');
}

function terminalText(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

async function waitForShutdown(close: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      close().then(resolve, reject);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

function printError(error: unknown): void {
  console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
}
