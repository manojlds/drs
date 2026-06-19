import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { resolveWithinWorkingDir } from './path-utils.js';

export interface ArtifactOutputPointer {
  outputType: 'artifact_output';
  outputPath: string;
}

export function extractHtmlDocument(content: string): string {
  const doctypeMatch = /<!DOCTYPE\s+html\s*>/i.exec(content);
  if (!doctypeMatch) {
    throw new Error('HTML artifact output must contain <!DOCTYPE html>.');
  }

  const html = content.slice(doctypeMatch.index).trimStart();
  const closingHtmlMatch = /<\/html\s*>/i.exec(html);
  if (!closingHtmlMatch) {
    throw new Error('HTML artifact output must contain a closing </html> tag.');
  }

  return html.slice(0, closingHtmlMatch.index + closingHtmlMatch[0].length);
}

export function validateHtmlArtifact(content: string): void {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('<!DOCTYPE html>')) {
    throw new Error('HTML artifact must start with <!DOCTYPE html>.');
  }
  if (!/<\/html\s*>\s*$/i.test(trimmed)) {
    throw new Error('HTML artifact must end with a closing </html> tag.');
  }
  if (/^```/.test(trimmed) || /```\s*$/.test(trimmed)) {
    throw new Error('HTML artifact must not be wrapped in Markdown code fences.');
  }
}

export function parseArtifactOutputPointer(content: string): ArtifactOutputPointer | undefined {
  try {
    const parsed = JSON.parse(content.trim()) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (record.outputType !== 'artifact_output' || typeof record.outputPath !== 'string') {
      return undefined;
    }
    return { outputType: 'artifact_output', outputPath: record.outputPath };
  } catch {
    return undefined;
  }
}

export async function writeArtifactOutput({
  outputPath,
  content,
  workingDir,
}: {
  outputPath: string;
  content: string;
  workingDir?: string;
}): Promise<ArtifactOutputPointer> {
  const html = extractHtmlDocument(content);
  validateHtmlArtifact(html);
  const root = workingDir ?? process.env.DRS_PROJECT_ROOT ?? process.cwd();
  const resolvedPath = resolveWithinWorkingDir(root, outputPath, 'write');
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, html, 'utf-8');
  return { outputType: 'artifact_output', outputPath };
}

export async function readArtifactOutputPointer(
  workingDir: string,
  pointer: ArtifactOutputPointer
): Promise<string> {
  const resolvedPath = resolveWithinWorkingDir(workingDir, pointer.outputPath, 'read');
  const content = await readFile(resolvedPath, 'utf-8');
  validateHtmlArtifact(content);
  return content;
}
