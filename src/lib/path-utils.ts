import { isAbsolute, relative, resolve } from 'path';

/**
 * Resolve a path and ensure it stays within the provided working directory.
 */
export function resolveWithinWorkingDir(
  workingDir: string,
  targetPath: string,
  action: 'read' | 'write' | 'access' = 'access'
): string {
  const root = resolve(workingDir);
  const fullPath = resolve(root, targetPath);
  const relativePath = relative(root, fullPath);

  if (relativePath === '') {
    return fullPath;
  }

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Refusing to ${action} outside working directory: ${targetPath}`);
  }

  return fullPath;
}
