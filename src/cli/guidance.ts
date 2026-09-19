import { Command } from 'commander';
import { loadConfig, type DRSConfig } from '../lib/config.js';
import {
  compileGuidanceRubric,
  type CompileGuidanceRubricOptions,
  type CompileGuidanceRubricResult,
} from '../lib/guidance/compiler.js';

type Compile = (
  config: DRSConfig,
  options: CompileGuidanceRubricOptions
) => Promise<CompileGuidanceRubricResult>;

export function createGuidanceCommand(
  compile: Compile = compileGuidanceRubric,
  load: (projectRoot: string) => DRSConfig = loadConfig
): Command {
  const command = new Command('guidance').description('Manage repository guidance compliance');

  command
    .command('compile')
    .description('Compile repository guidance into .drs/guidance-rubric.json')
    .action(async () => {
      try {
        const projectRoot = process.cwd();
        const result = await compile(load(projectRoot), { projectRoot });
        console.log(`Wrote ${result.outputPath} (${result.rubric.rules.length} rules)`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  return command;
}
