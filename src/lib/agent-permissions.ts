import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { lstat, readFile, readlink, realpath } from 'fs/promises';
import { isAbsolute, relative, resolve, sep } from 'path';
import { minimatch } from 'minimatch';
import { promisify } from 'util';

export interface AgentPathPermissions {
  roots: string[];
  allow: string[];
  deny?: string[];
}

export interface AgentFilesystemPermissions {
  read?: AgentPathPermissions;
  write?: AgentPathPermissions;
  delete?: AgentPathPermissions;
}

export interface AgentPermissions {
  filesystem?: AgentFilesystemPermissions;
  shell?: boolean;
}

export interface AgentMutationValidator {
  name: 'okf-document';
  root: string;
}

export interface AgentValidation {
  afterMutation?: AgentMutationValidator[];
}

export type AgentFilesystemOperation = 'read' | 'write' | 'delete';

export interface AgentWorkspaceSnapshot {
  files: Record<string, string>;
}

export interface AgentWorkspaceChanges {
  added: string[];
  modified: string[];
  deleted: string[];
}

const execFileAsync = promisify(execFile);

const PERMISSION_FIELDS = new Set(['filesystem', 'shell']);
const FILESYSTEM_FIELDS = new Set(['read', 'write', 'delete']);
const PATH_PERMISSION_FIELDS = new Set(['roots', 'allow', 'deny']);
const VALIDATION_FIELDS = new Set(['afterMutation']);
const AFTER_WRITE_VALIDATOR_FIELDS = new Set(['name', 'root']);

export function validateAgentPermissions(value: unknown, subject = 'Agent permissions'): void {
  if (!isRecord(value)) throw new Error(`${subject} must be an object.`);
  rejectUnknownFields(value, PERMISSION_FIELDS, subject);

  if (value.shell !== undefined && typeof value.shell !== 'boolean') {
    throw new Error(`${subject}.shell must be boolean.`);
  }
  if (value.filesystem === undefined) return;
  if (!isRecord(value.filesystem)) {
    throw new Error(`${subject}.filesystem must be an object.`);
  }
  rejectUnknownFields(value.filesystem, FILESYSTEM_FIELDS, `${subject}.filesystem`);

  if (value.shell !== false) {
    throw new Error(`${subject} with filesystem rules must explicitly set shell: false.`);
  }
  for (const operation of ['read', 'write', 'delete'] as const) {
    const rule = value.filesystem[operation];
    if (rule === undefined) continue;
    validatePathPermissions(rule, `${subject}.filesystem.${operation}`);
  }
}

export function validateAgentValidation(value: unknown, subject = 'Agent validation'): void {
  if (!isRecord(value)) throw new Error(`${subject} must be an object.`);
  rejectUnknownFields(value, VALIDATION_FIELDS, subject);
  if (value.afterMutation === undefined) return;
  if (!Array.isArray(value.afterMutation)) {
    throw new Error(`${subject}.afterMutation must be an array.`);
  }
  for (const [index, validator] of value.afterMutation.entries()) {
    const validatorSubject = `${subject}.afterMutation[${index}]`;
    if (!isRecord(validator)) throw new Error(`${validatorSubject} must be an object.`);
    rejectUnknownFields(validator, AFTER_WRITE_VALIDATOR_FIELDS, validatorSubject);
    if (validator.name !== 'okf-document') {
      throw new Error(
        `${validatorSubject}.name has unsupported validator "${String(validator.name)}".`
      );
    }
    if (typeof validator.root !== 'string' || !validator.root.trim()) {
      throw new Error(`${validatorSubject}.root must be a non-empty string.`);
    }
  }
}

export function renderAgentPermissions(
  permissions: AgentPermissions,
  render: (value: string) => string
): AgentPermissions {
  const rendered: AgentPermissions = {
    ...(permissions.shell !== undefined ? { shell: permissions.shell } : {}),
    ...(permissions.filesystem
      ? {
          filesystem: Object.fromEntries(
            (['read', 'write', 'delete'] as const).flatMap((operation) => {
              const rule = permissions.filesystem?.[operation];
              return rule
                ? [
                    [
                      operation,
                      {
                        roots: rule.roots.map(render),
                        allow: rule.allow.map(render),
                        ...(rule.deny ? { deny: rule.deny.map(render) } : {}),
                      },
                    ],
                  ]
                : [];
            })
          ),
        }
      : {}),
  };
  validateAgentPermissions(rendered);
  return rendered;
}

export function renderAgentValidation(
  validation: AgentValidation,
  render: (value: string) => string
): AgentValidation {
  const rendered: AgentValidation = {
    ...(validation.afterMutation
      ? {
          afterMutation: validation.afterMutation.map((validator) => ({
            name: validator.name,
            root: render(validator.root),
          })),
        }
      : {}),
  };
  validateAgentValidation(rendered);
  return rendered;
}

export class AgentFilesystemAuthorizer {
  private readonly workingDir: string;

  constructor(
    workingDir: string,
    private readonly permissions: AgentFilesystemPermissions
  ) {
    this.workingDir = resolve(workingDir);
  }

  hasRule(operation: AgentFilesystemOperation): boolean {
    return this.permissions[operation] !== undefined;
  }

  async authorize(operation: AgentFilesystemOperation, requestedPath: string): Promise<string> {
    const rule = this.permissions[operation];
    const absolutePath = isAbsolute(requestedPath)
      ? resolve(requestedPath)
      : resolve(this.workingDir, requestedPath);
    const relativePath = relative(this.workingDir, absolutePath);
    if (
      (relativePath === '' && operation !== 'read') ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw permissionError(operation, requestedPath, 'path is outside the working directory');
    }

    if (rule) {
      const scopedPaths = rule.roots.flatMap((root) => {
        const absoluteRoot = resolve(this.workingDir, root);
        const scopedPath = relative(absoluteRoot, absolutePath);
        return scopedPath === '' || (!scopedPath.startsWith(`..${sep}`) && !isAbsolute(scopedPath))
          ? [toPosixPath(scopedPath)]
          : [];
      });
      if (scopedPaths.length === 0) {
        throw permissionError(operation, requestedPath, 'path is outside the allowed roots');
      }
      const allowed = scopedPaths.some((scopedPath) =>
        rule.allow.some((pattern) => matchesPath(scopedPath, pattern))
      );
      if (!allowed) {
        throw permissionError(operation, requestedPath, 'path is not in the allow list');
      }
      const denied = scopedPaths.some((scopedPath) =>
        (rule.deny ?? []).some((pattern) => matchesPath(scopedPath, pattern))
      );
      if (denied) {
        throw permissionError(operation, requestedPath, 'path is in the deny list');
      }
    }

    await assertNoSymbolicLinks(this.workingDir, absolutePath, operation, requestedPath);
    return absolutePath;
  }
}

export async function captureAgentWorkspaceSnapshot(
  workingDir: string
): Promise<AgentWorkspaceSnapshot> {
  const root = resolve(workingDir);
  let output: string;
  try {
    const { stdout: gitRootOutput } = await execFileAsync(
      'git',
      ['--no-pager', 'rev-parse', '--show-toplevel'],
      { cwd: root, encoding: 'utf-8' }
    );
    const [gitRoot, workspaceRoot] = await Promise.all([
      realpath(resolve(gitRootOutput.trim())),
      realpath(root),
    ]);
    if (gitRoot !== workspaceRoot) {
      throw new Error(`agent working directory must be the Git repository root (${gitRoot})`);
    }
    ({ stdout: output } = await execFileAsync(
      'git',
      ['--no-pager', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: root, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    ));
  } catch (error) {
    throw new Error(
      `Agent filesystem permissions require a Git repository: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const files = Object.create(null) as Record<string, string>;
  for (const filePath of output.split('\0').filter(Boolean).sort()) {
    const fingerprint = await fingerprintWorkspacePath(root, filePath);
    if (fingerprint) files[toPosixPath(filePath)] = fingerprint;
  }
  return { files };
}

export async function assertAgentWorkspaceChangesAllowed(
  workingDir: string,
  permissions: AgentFilesystemPermissions,
  before: AgentWorkspaceSnapshot
): Promise<AgentWorkspaceChanges> {
  const after = await captureAgentWorkspaceSnapshot(workingDir);
  const changedPaths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter((filePath) => before.files[filePath] !== after.files[filePath])
    .sort();
  const changes: AgentWorkspaceChanges = {
    added: changedPaths.filter((filePath) => before.files[filePath] === undefined),
    modified: changedPaths.filter(
      (filePath) => before.files[filePath] !== undefined && after.files[filePath] !== undefined
    ),
    deleted: changedPaths.filter((filePath) => after.files[filePath] === undefined),
  };
  if (changedPaths.length === 0) return changes;
  if (!permissions.write && !permissions.delete) {
    throw new Error(
      `Agent changed path(s) without filesystem write permission:\n${changedPaths.map((filePath) => `- ${filePath}`).join('\n')}`
    );
  }

  const authorizer = new AgentFilesystemAuthorizer(workingDir, permissions);
  const denied: Array<{ path: string; reason: string }> = [];
  for (const filePath of changedPaths) {
    const operation =
      before.files[filePath] !== undefined && after.files[filePath] === undefined
        ? 'delete'
        : 'write';
    if (!permissions[operation]) {
      denied.push({ path: filePath, reason: `Agent has no filesystem ${operation} permission.` });
      continue;
    }
    try {
      await authorizer.authorize(operation, filePath);
    } catch (error) {
      denied.push({
        path: filePath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (denied.length > 0) {
    throw new Error(
      `Agent changed path(s) outside its filesystem permissions:\n${denied.map(({ path, reason }) => `- ${path}: ${reason}`).join('\n')}`
    );
  }
  return changes;
}

function validatePathPermissions(value: unknown, subject: string): void {
  if (!isRecord(value)) throw new Error(`${subject} must be an object.`);
  rejectUnknownFields(value, PATH_PERMISSION_FIELDS, subject);
  validateLiteralRoots(value.roots, `${subject}.roots`);
  validatePathPatterns(value.allow, `${subject}.allow`, true);
  if (value.deny !== undefined) validatePathPatterns(value.deny, `${subject}.deny`, false);
}

function validateLiteralRoots(value: unknown, subject: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${subject} must contain at least one repository-relative path.`);
  }
  for (const root of value) {
    if (typeof root !== 'string' || !root.trim()) {
      throw new Error(`${subject} must contain only non-empty strings.`);
    }
    const normalized = root.replaceAll('\\', '/');
    if (isAbsolute(root) || normalized.split('/').includes('..')) {
      throw new Error(`${subject} must contain repository-relative paths: ${root}`);
    }
  }
}

function validatePathPatterns(value: unknown, subject: string, required: boolean): void {
  if (!Array.isArray(value)) {
    throw new Error(`${subject} must be an array of repository-relative glob patterns.`);
  }
  if (required && value.length === 0) {
    throw new Error(`${subject} must contain at least one repository-relative glob pattern.`);
  }
  for (const pattern of value) {
    if (typeof pattern !== 'string' || !pattern.trim()) {
      throw new Error(`${subject} must contain only non-empty strings.`);
    }
    const normalized = pattern.replaceAll('\\', '/');
    if (isAbsolute(pattern) || normalized.split('/').includes('..')) {
      throw new Error(`${subject} must contain repository-relative patterns: ${pattern}`);
    }
  }
}

function matchesPath(filePath: string, pattern: string): boolean {
  const normalizedPattern = pattern.replaceAll('\\', '/').replace(/^\.\//u, '');
  return minimatch(filePath, normalizedPattern, {
    dot: true,
    nocase: false,
    nocomment: true,
    nonegate: true,
  });
}

async function assertNoSymbolicLinks(
  workingDir: string,
  targetPath: string,
  operation: AgentFilesystemOperation,
  requestedPath: string
): Promise<void> {
  if ((await lstat(workingDir)).isSymbolicLink()) {
    throw permissionError(operation, requestedPath, 'working directory is a symbolic link');
  }

  const relativePath = relative(workingDir, targetPath);
  let currentPath = workingDir;
  for (const part of relativePath.split(sep).filter(Boolean)) {
    currentPath = resolve(currentPath, part);
    try {
      const pathStat = await lstat(currentPath);
      if (pathStat.isSymbolicLink()) {
        throw permissionError(operation, requestedPath, 'path contains a symbolic link');
      }
      if (
        operation === 'write' &&
        currentPath === targetPath &&
        pathStat.isFile() &&
        pathStat.nlink > 1
      ) {
        throw permissionError(operation, requestedPath, 'target has multiple hard links');
      }
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
  }
}

async function fingerprintWorkspacePath(
  workingDir: string,
  relativePath: string
): Promise<string | null> {
  const absolutePath = resolve(workingDir, relativePath);
  try {
    const pathStat = await lstat(absolutePath);
    if (pathStat.isSymbolicLink()) {
      return createHash('sha256')
        .update(`symlink:${await readlink(absolutePath)}`)
        .digest('hex');
    }
    if (pathStat.isDirectory()) return fingerprintNestedGitWorkspace(absolutePath);
    if (!pathStat.isFile()) return null;
    const hash = createHash('sha256');
    hash.update(`mode:${pathStat.mode & 0o111 ? 'executable' : 'regular'}\0`);
    hash.update(await readFile(absolutePath));
    return hash.digest('hex');
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

async function fingerprintNestedGitWorkspace(workingDir: string): Promise<string | null> {
  try {
    const [headResult, diffResult, untrackedResult] = await Promise.all([
      execFileAsync('git', ['--no-pager', 'rev-parse', 'HEAD'], {
        cwd: workingDir,
        encoding: 'utf-8',
      }),
      execFileAsync('git', ['--no-pager', 'diff', '--binary', 'HEAD'], {
        cwd: workingDir,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      }),
      execFileAsync('git', ['--no-pager', 'ls-files', '--others', '--exclude-standard', '-z'], {
        cwd: workingDir,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      }),
    ]);
    const hash = createHash('sha256');
    hash.update(`head:${headResult.stdout.trim()}\0diff:\0${diffResult.stdout}\0`);
    for (const filePath of untrackedResult.stdout.split('\0').filter(Boolean).sort()) {
      const fingerprint = await fingerprintWorkspacePath(workingDir, filePath);
      if (fingerprint) hash.update(`untracked:${toPosixPath(filePath)}\0${fingerprint}\0`);
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

function permissionError(
  operation: AgentFilesystemOperation,
  requestedPath: string,
  reason: string
): Error {
  return new Error(
    `Agent filesystem permission denied for ${operation} "${requestedPath}": ${reason}.`
  );
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: Set<string>,
  subject: string
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${subject} has unsupported field(s): ${unknown.join(', ')}.`);
  }
}

function toPosixPath(value: string): string {
  return sep === '/' ? value : value.split(sep).join('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
