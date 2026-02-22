import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, '..', '..');

const piBuiltInAgentPath = join(packageRoot, '.pi', 'agents');
const legacyBuiltInAgentPath = join(packageRoot, '.opencode', 'agent');

export function getBuiltInAgentPaths(): string[] {
  const paths: string[] = [];

  if (existsSync(piBuiltInAgentPath)) {
    paths.push(piBuiltInAgentPath);
  }

  if (existsSync(legacyBuiltInAgentPath)) {
    paths.push(legacyBuiltInAgentPath);
  }

  return paths;
}
