import { Command, InvalidArgumentError, Option } from 'commander';
import { runQualityBenchmark } from '../lib/quality-benchmark.js';
import { runReviewBenchmark } from '../lib/review-benchmark.js';

const collect = (value: string, values: string[]): string[] => [...values, value];
const positive = (value: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('Expected a positive integer.');
  return n;
};

export function createBenchmarkCommand(
  run = runReviewBenchmark,
  runQuality = runQualityBenchmark
): Command {
  const command = new Command('benchmark').description('Run opt-in DRS calibration benchmarks');
  command
    .command('review')
    .requiredOption('--suite <name-or-path>')
    .option(
      '--model <provider/model>',
      'pinned execution model (repeatable for secondary sensitivity analysis)',
      collect,
      []
    )
    .addOption(
      new Option('--review-mode <mode>', 'review evaluator mode')
        .choices(['agent', 'jev', 'parallel', 'combined'])
        .default('agent')
    )
    .option('--profile <profile>', 'isolation profile', 'isolated')
    .option('--repeat <count>', 'repetitions', positive, 1)
    .option('--output <dir>', 'artifact directory', 'out/review-benchmark')
    .option('--live', 'acknowledge live provider calls')
    .action(async (options) => {
      try {
        const result = await run({
          projectRoot: process.cwd(),
          suite: options.suite,
          reviewMode: options.reviewMode,
          models: options.model,
          profile: options.profile,
          repeat: options.repeat,
          output: options.output,
          live: options.live === true,
        });
        console.log(`Wrote ${result.jsonPath}\nWrote ${result.markdownPath}`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
  command
    .command('quality')
    .description('Compare Jev and no-tool LLMs using the same quality rubric and prepared state')
    .requiredOption('--suite <name-or-path>')
    .requiredOption('--model <provider/model>', 'quality evaluator model (repeatable)', collect, [])
    .option('--profile <profile>', 'isolation profile', 'isolated')
    .option('--repeat <count>', 'repetitions', positive, 1)
    .option('--output <dir>', 'artifact directory', 'out/quality-benchmark')
    .option('--live', 'acknowledge live provider calls')
    .action(async (options) => {
      try {
        const result = await runQuality({
          projectRoot: process.cwd(),
          suite: options.suite,
          models: options.model,
          profile: options.profile,
          repeat: options.repeat,
          output: options.output,
          live: options.live === true,
        });
        console.log(`Wrote ${result.jsonPath}\nWrote ${result.markdownPath}`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
  return command;
}
