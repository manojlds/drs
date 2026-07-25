import { Command, InvalidArgumentError } from 'commander';
import { runReviewBenchmark } from '../lib/review-benchmark.js';

const collect = (value: string, values: string[]): string[] => [...values, value];
const positive = (value: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('Expected a positive integer.');
  return n;
};

export function createBenchmarkCommand(run = runReviewBenchmark): Command {
  const command = new Command('benchmark').description('Run opt-in DRS calibration benchmarks');
  command
    .command('review')
    .requiredOption('--suite <name-or-path>')
    .requiredOption('--model <provider/model>', 'candidate model (repeatable)', collect, [])
    .option('--profile <profile>', 'isolation profile', 'isolated')
    .option('--repeat <count>', 'repetitions', positive, 1)
    .option('--output <dir>', 'artifact directory', 'out/review-benchmark')
    .option('--live', 'acknowledge live provider calls')
    .action(async (options) => {
      try {
        const result = await run({
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
