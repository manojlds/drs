import { readFile } from 'fs/promises';
import { join } from 'path';

const ARTIFACT_ID_PATTERN = /^(art|rev)_[0-9]+_[a-z0-9]+$/;

function assertSafeArtifactId(id: string): void {
  if (!ARTIFACT_ID_PATTERN.test(id)) throw new Error(`Invalid artifact id: ${id}`);
}

export async function loadWorkflowArtifact(directory: string, id?: string): Promise<unknown> {
  if (id !== undefined) assertSafeArtifactId(id);
  const path = join(directory, id ? `${id}.json` : 'latest.json');
  return JSON.parse(await readFile(path, 'utf8'));
}
