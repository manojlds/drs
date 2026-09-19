import { readFile } from 'fs/promises';
import { resolveWithinWorkingDir } from '../path-utils.js';
import { parseGuidanceRubric, type GuidanceRubric } from './rubric.js';

export const GUIDANCE_RUBRIC_PATH = '.drs/guidance-rubric.json';
const MAX_GUIDANCE_RUBRIC_BYTES = 2 * 1024 * 1024;

export async function loadGuidanceRubric(
  projectRoot: string,
  rubricPath = GUIDANCE_RUBRIC_PATH
): Promise<GuidanceRubric> {
  const resolvedPath = resolveWithinWorkingDir(projectRoot, rubricPath, 'read');
  const content = await readFile(resolvedPath, 'utf-8');
  if (Buffer.byteLength(content, 'utf-8') > MAX_GUIDANCE_RUBRIC_BYTES) {
    throw new Error(`Guidance rubric exceeds ${MAX_GUIDANCE_RUBRIC_BYTES} bytes.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Guidance rubric is not valid JSON: ${rubricPath}`);
  }
  return parseGuidanceRubric(parsed);
}
