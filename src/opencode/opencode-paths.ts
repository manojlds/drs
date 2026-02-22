import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, '..', '..');

const piBuiltInAgentPath = join(packageRoot, '.pi', 'agents');

export function getBuiltInAgentPaths(): string[] {
  if (existsSync(piBuiltInAgentPath)) {
    return [piBuiltInAgentPath];
  }

  return [];
}
