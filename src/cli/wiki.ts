import chalk from 'chalk';
import { Command, InvalidArgumentError } from 'commander';
import { buildWikiSite, serveWikiSite, type WikiSiteOptions } from '../lib/wiki-site.js';
import { waitForWikiSite } from '../lib/wiki-site-smoke.js';

export function createWikiCommand(): Command {
  const command = new Command('wiki').description(
    'Build, serve, and verify a human-readable OKF repository wiki'
  );

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
