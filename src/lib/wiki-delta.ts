import { createHash } from 'crypto';
import { execFile } from 'child_process';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from 'fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'path';
import { promisify } from 'util';
import { resolveWithinWorkingDir } from './path-utils.js';

const execFileAsync = promisify(execFile);
const WIKI_STATE_VERSION = 1 as const;
const MAX_CHANGED_PATHS = 500;

export interface WikiUpdatePlan {
  mode: 'generate' | 'reconcile' | 'update' | 'noop';
  shouldRun: boolean;
  reason: string;
  root: string;
  statePath: string;
  gitHead: string;
  previousGitHead?: string;
  sourceHash: string;
  previousSourceHash?: string;
  wikiHash?: string;
  previousWikiHash?: string;
  changedPaths: string[];
  changedPathCount: number;
  changedPathsTruncated: boolean;
}

export interface WikiState {
  version: typeof WIKI_STATE_VERSION;
  okfVersion: '0.1';
  root: string;
  gitHead: string;
  sourceHash: string;
  sourceFiles?: Record<string, string>;
  wikiHash: string;
  updatedAt: string;
}

export interface WikiCleanResult {
  clean: boolean;
  root: string;
  statePath: string;
  changedPaths: string[];
}

/** Plan a generate, reconciliation, delta update, or model-free no-op run. */
export async function planWikiUpdate(
  workingDir: string,
  root = 'wiki',
  statePath = '.drs/wiki-state.json'
): Promise<WikiUpdatePlan> {
  const paths = resolveWikiPaths(workingDir, root, statePath);
  await assertSafeWikiPaths(workingDir, paths);
  await requireGitRepository(workingDir);
  const [gitHead, sourceFiles] = await Promise.all([
    runGit(workingDir, ['rev-parse', 'HEAD']),
    listSourceFiles(workingDir, paths),
  ]);
  const sourceSnapshot = await fingerprintSourceFiles(workingDir, sourceFiles);
  const sourceHash = sourceSnapshot.hash;
  const wikiExists = await isDirectory(paths.absoluteRoot);
  const state = await readWikiState(paths.absoluteStatePath);

  if (!wikiExists) {
    return createPlan('generate', 'Wiki bundle does not exist.', paths, gitHead, sourceHash);
  }

  const wikiHash = await hashDirectory(paths.absoluteRoot);
  if (!state) {
    return createPlan(
      'reconcile',
      'Wiki state is missing or invalid.',
      paths,
      gitHead,
      sourceHash,
      { wikiHash }
    );
  }
  if (state.root !== paths.root) {
    return createPlan(
      'reconcile',
      `Wiki state targets ${state.root} instead of ${paths.root}.`,
      paths,
      gitHead,
      sourceHash,
      { state, wikiHash }
    );
  }

  if (state.sourceHash !== sourceHash) {
    const changedPaths = state.sourceFiles
      ? compareSourceFiles(state.sourceFiles, sourceSnapshot.files)
      : await collectChangedSourcePaths(
          workingDir,
          paths,
          state,
          sourceFiles.map((entry) => entry.path)
        );
    return createPlan(
      'update',
      `${changedPaths.length} source path(s) changed since the last recorded wiki state.`,
      paths,
      gitHead,
      sourceHash,
      { state, wikiHash, changedPaths }
    );
  }

  if (state.wikiHash !== wikiHash) {
    return createPlan(
      'reconcile',
      'Wiki content changed without a corresponding state update.',
      paths,
      gitHead,
      sourceHash,
      { state, wikiHash }
    );
  }

  return createPlan(
    'noop',
    'Source and wiki content match the recorded state.',
    paths,
    gitHead,
    sourceHash,
    { state, wikiHash }
  );
}

/** Record source and wiki fingerprints after successful index synchronization and validation. */
export async function recordWikiState(
  workingDir: string,
  root = 'wiki',
  statePath = '.drs/wiki-state.json'
): Promise<WikiState> {
  const paths = resolveWikiPaths(workingDir, root, statePath);
  await assertSafeWikiPaths(workingDir, paths);
  await requireGitRepository(workingDir);
  if (!(await isDirectory(paths.absoluteRoot))) {
    throw new Error(`Cannot record wiki state because the bundle does not exist: ${paths.root}`);
  }

  const [gitHead, sourceFiles, wikiHash] = await Promise.all([
    runGit(workingDir, ['rev-parse', 'HEAD']),
    listSourceFiles(workingDir, paths),
    hashDirectory(paths.absoluteRoot),
  ]);
  const sourceSnapshot = await fingerprintSourceFiles(workingDir, sourceFiles, true);
  const state: WikiState = {
    version: WIKI_STATE_VERSION,
    okfVersion: '0.1',
    root: paths.root,
    gitHead,
    sourceHash: sourceSnapshot.hash,
    sourceFiles: sourceSnapshot.files,
    wikiHash,
    updatedAt: new Date().toISOString(),
  };

  await mkdir(dirname(paths.absoluteStatePath), { recursive: true });
  const temporaryPath = `${paths.absoluteStatePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    await rename(temporaryPath, paths.absoluteStatePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return state;
}

/** Fail CI check mode when running the workflow changed the bundle or its state file. */
export async function checkWikiClean(
  workingDir: string,
  root = 'wiki',
  statePath = '.drs/wiki-state.json'
): Promise<WikiCleanResult> {
  const paths = resolveWikiPaths(workingDir, root, statePath);
  await assertSafeWikiPaths(workingDir, paths);
  await requireGitRepository(workingDir);
  const [trackedChanges, untrackedChanges, ignoredChanges] = await Promise.all([
    listNullSeparatedGitOutput(workingDir, [
      '--literal-pathspecs',
      'diff',
      '--name-only',
      '-z',
      'HEAD',
      '--',
      paths.root,
      paths.statePath,
    ]),
    listNullSeparatedGitOutput(workingDir, [
      '--literal-pathspecs',
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      paths.root,
      paths.statePath,
    ]),
    listNullSeparatedGitOutput(workingDir, [
      '--literal-pathspecs',
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '-z',
      '--',
      paths.root,
      paths.statePath,
    ]),
  ]);
  const changedPaths = [
    ...new Set([...trackedChanges, ...untrackedChanges, ...ignoredChanges]),
  ].sort();
  return {
    clean: changedPaths.length === 0,
    root: paths.root,
    statePath: paths.statePath,
    changedPaths,
  };
}

interface ResolvedWikiPaths {
  absoluteRoot: string;
  absoluteStatePath: string;
  root: string;
  statePath: string;
}

interface PlanDetails {
  state?: WikiState;
  wikiHash?: string;
  changedPaths?: string[];
}

interface SourceFileEntry {
  path: string;
  gitlinkOid?: string;
}

interface SourceSnapshot {
  hash: string;
  files: Record<string, string>;
}

function createPlan(
  mode: WikiUpdatePlan['mode'],
  reason: string,
  paths: ResolvedWikiPaths,
  gitHead: string,
  sourceHash: string,
  details: PlanDetails = {}
): WikiUpdatePlan {
  const changedPaths = details.changedPaths ?? [];
  return {
    mode,
    shouldRun: mode !== 'noop',
    reason,
    root: paths.root,
    statePath: paths.statePath,
    gitHead,
    ...(details.state?.gitHead ? { previousGitHead: details.state.gitHead } : {}),
    sourceHash,
    ...(details.state?.sourceHash ? { previousSourceHash: details.state.sourceHash } : {}),
    ...(details.wikiHash ? { wikiHash: details.wikiHash } : {}),
    ...(details.state?.wikiHash ? { previousWikiHash: details.state.wikiHash } : {}),
    changedPaths: changedPaths.slice(0, MAX_CHANGED_PATHS),
    changedPathCount: changedPaths.length,
    changedPathsTruncated: changedPaths.length > MAX_CHANGED_PATHS,
  };
}

function resolveWikiPaths(workingDir: string, root: string, statePath: string): ResolvedWikiPaths {
  const requestedRoot = normalizeRelativePath(root, 'Wiki bundle root');
  const requestedStatePath = normalizeRelativePath(statePath, 'Wiki state path');
  const absoluteWorkingDir = resolve(workingDir);
  const absoluteRoot = resolveWithinWorkingDir(workingDir, requestedRoot, 'access');
  const absoluteStatePath = resolveWithinWorkingDir(workingDir, requestedStatePath, 'access');
  if (absoluteRoot === absoluteWorkingDir) {
    throw new Error('Wiki bundle root must be a subdirectory of the working directory.');
  }

  const normalizedRoot = toPosixPath(relative(absoluteWorkingDir, absoluteRoot));
  const normalizedStatePath = toPosixPath(relative(absoluteWorkingDir, absoluteStatePath));
  if (isPathWithin(normalizedStatePath, normalizedRoot)) {
    throw new Error('Wiki state path must be outside the portable OKF bundle.');
  }
  return {
    absoluteRoot,
    absoluteStatePath,
    root: normalizedRoot,
    statePath: normalizedStatePath,
  };
}

async function assertSafeWikiPaths(workingDir: string, paths: ResolvedWikiPaths): Promise<void> {
  await Promise.all([
    assertNoSymlinkAncestors(workingDir, paths.absoluteRoot, 'Wiki bundle root'),
    assertNoSymlinkAncestors(workingDir, paths.absoluteStatePath, 'Wiki state path'),
  ]);
}

async function assertNoSymlinkAncestors(
  workingDir: string,
  targetPath: string,
  label: string
): Promise<void> {
  const absoluteWorkingDir = resolve(workingDir);
  const relativePath = relative(absoluteWorkingDir, targetPath);
  let currentPath = absoluteWorkingDir;
  for (const part of relativePath.split(sep).filter(Boolean)) {
    currentPath = resolve(currentPath, part);
    try {
      if ((await lstat(currentPath)).isSymbolicLink()) {
        throw new Error(`${label} cannot contain symbolic links: ${relativePath}`);
      }
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
  }
}

function normalizeRelativePath(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} cannot be empty.`);
  if (isAbsolute(trimmed)) throw new Error(`${label} must be repository-relative: ${trimmed}`);
  return trimmed;
}

async function requireGitRepository(workingDir: string): Promise<void> {
  const gitRoot = await realpath(
    resolve(await runGit(workingDir, ['rev-parse', '--show-toplevel']))
  );
  const realWorkingDir = await realpath(resolve(workingDir));
  if (gitRoot !== realWorkingDir) {
    throw new Error(`Wiki delta workflow must run from the repository root: ${gitRoot}`);
  }
}

async function listSourceFiles(
  workingDir: string,
  paths: ResolvedWikiPaths
): Promise<SourceFileEntry[]> {
  const [stagedOutput, untracked] = await Promise.all([
    runGit(workingDir, ['ls-files', '--stage', '-z'], false, false),
    listNullSeparatedGitOutput(workingDir, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const entries = new Map<string, SourceFileEntry>();
  for (const value of splitNullSeparatedOutput(stagedOutput)) {
    const separator = value.indexOf('\t');
    if (separator < 0) continue;
    const metadata = value.slice(0, separator).split(' ');
    const filePath = toPosixPath(value.slice(separator + 1));
    if (metadata[2] !== '0') continue;
    entries.set(filePath, {
      path: filePath,
      ...(metadata[0] === '160000' && metadata[1] ? { gitlinkOid: metadata[1] } : {}),
    });
  }
  for (const filePath of untracked) {
    entries.set(filePath, { path: filePath });
  }
  return [...entries.values()]
    .filter((entry) => !isPathWithin(entry.path, paths.root) && entry.path !== paths.statePath)
    .sort((left, right) => compareStrings(left.path, right.path));
}

async function fingerprintSourceFiles(
  workingDir: string,
  entries: SourceFileEntry[],
  rejectDirtySubmodules = false
): Promise<SourceSnapshot> {
  const hash = createHash('sha256');
  const files = Object.create(null) as Record<string, string>;
  for (const entry of entries) {
    const fingerprint = await fingerprintSourcePath(workingDir, entry, rejectDirtySubmodules);
    if (!fingerprint) continue;
    files[entry.path] = fingerprint;
    hash.update(`path:${entry.path}\0${fingerprint}\0`);
  }
  return { hash: hash.digest('hex'), files };
}

async function fingerprintSourcePath(
  workingDir: string,
  entry: SourceFileEntry,
  rejectDirtySubmodules = false
): Promise<string | null> {
  const absolutePath = resolveWithinWorkingDir(workingDir, entry.path, 'read');
  let fileStat;
  try {
    fileStat = await lstat(absolutePath);
  } catch (error) {
    if (entry.gitlinkOid) return hashValue(`gitlink:${entry.gitlinkOid}`);
    if (isMissingPathError(error)) return null;
    throw error;
  }

  if (fileStat.isDirectory() && entry.gitlinkOid) {
    return fingerprintSubmodule(absolutePath, entry.gitlinkOid, rejectDirtySubmodules);
  }

  const hash = createHash('sha256');
  if (fileStat.isSymbolicLink()) {
    hash.update(`symlink:${await readlink(absolutePath)}\0`);
  } else if (fileStat.isFile()) {
    hash.update(`file:executable:${fileStat.mode & 0o111 ? 'yes' : 'no'}\0`);
    hash.update(await readFile(absolutePath));
  } else {
    return null;
  }
  return hash.digest('hex');
}

async function fingerprintSubmodule(
  absolutePath: string,
  gitlinkOid: string,
  rejectDirty: boolean
): Promise<string> {
  const submoduleRoot = await runGit(absolutePath, ['rev-parse', '--show-toplevel'], true);
  if (!submoduleRoot) return hashValue(`gitlink:${gitlinkOid}`);
  const [realSubmoduleRoot, realAbsolutePath] = await Promise.all([
    realpath(resolve(submoduleRoot)),
    realpath(absolutePath),
  ]);
  if (realSubmoduleRoot !== realAbsolutePath) return hashValue(`gitlink:${gitlinkOid}`);

  const [head, status] = await Promise.all([
    runGit(absolutePath, ['rev-parse', 'HEAD']),
    runGit(absolutePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], false, false),
  ]);
  if (!status) return hashValue(`gitlink:${head}`);
  if (rejectDirty) {
    throw new Error(`Cannot record wiki state while Git submodule is dirty: ${absolutePath}`);
  }

  const [diff, untracked] = await Promise.all([
    runGit(absolutePath, ['diff', '--binary', 'HEAD'], false, false),
    listNullSeparatedGitOutput(absolutePath, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const hash = createHash('sha256');
  hash.update(`gitlink:dirty:head:${head}\0diff:\0${diff}\0`);
  for (const filePath of untracked.sort()) {
    const fingerprint = await fingerprintSourcePath(absolutePath, { path: filePath });
    if (fingerprint) hash.update(`untracked:${filePath}\0${fingerprint}\0`);
  }
  return hash.digest('hex');
}

async function hashDirectory(absoluteRoot: string, relativeDirectory = ''): Promise<string> {
  const hash = createHash('sha256');
  await addDirectoryToHash(hash, absoluteRoot, relativeDirectory);
  return hash.digest('hex');
}

async function addDirectoryToHash(
  hash: ReturnType<typeof createHash>,
  absoluteDirectory: string,
  relativeDirectory: string
): Promise<void> {
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
    const absolutePath = resolve(absoluteDirectory, entry.name);
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      hash.update(`dir:${relativePath}\0`);
      await addDirectoryToHash(hash, absolutePath, relativePath);
    } else if (entry.isFile()) {
      hash.update(`file:${relativePath}\0`);
      hash.update(await readFile(absolutePath));
      hash.update('\0');
    } else if (entry.isSymbolicLink()) {
      hash.update(`symlink:${relativePath}:${await readlink(absolutePath)}\0`);
    }
  }
}

async function readWikiState(absoluteStatePath: string): Promise<WikiState | null> {
  try {
    const value = JSON.parse(await readFile(absoluteStatePath, 'utf-8')) as unknown;
    if (!isRecord(value)) return null;
    if (
      value.version !== WIKI_STATE_VERSION ||
      value.okfVersion !== '0.1' ||
      typeof value.root !== 'string' ||
      typeof value.gitHead !== 'string' ||
      !isFullObjectId(value.gitHead) ||
      typeof value.sourceHash !== 'string' ||
      (value.sourceFiles !== undefined && !isSourceFileManifest(value.sourceFiles)) ||
      typeof value.wikiHash !== 'string' ||
      typeof value.updatedAt !== 'string'
    ) {
      return null;
    }
    return value as unknown as WikiState;
  } catch {
    return null;
  }
}

async function collectChangedSourcePaths(
  workingDir: string,
  paths: ResolvedWikiPaths,
  state: WikiState,
  sourceFiles: string[]
): Promise<string[]> {
  const [committed, working, untracked] = await Promise.all([
    listNullSeparatedGitOutput(
      workingDir,
      ['diff', '--name-only', '-z', '--end-of-options', `${state.gitHead}..HEAD`],
      true
    ),
    listNullSeparatedGitOutput(workingDir, ['diff', '--name-only', '-z', 'HEAD']),
    listNullSeparatedGitOutput(workingDir, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const changed = [...new Set([...committed, ...working, ...untracked])]
    .filter((filePath) => !isPathWithin(filePath, paths.root) && filePath !== paths.statePath)
    .sort();
  return changed.length > 0 ? changed : sourceFiles;
}

function compareSourceFiles(
  previous: Record<string, string>,
  current: Record<string, string>
): string[] {
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .filter((filePath) => previous[filePath] !== current[filePath])
    .sort();
}

async function listNullSeparatedGitOutput(
  workingDir: string,
  args: string[],
  allowFailure = false
): Promise<string[]> {
  const output = await runGit(workingDir, args, allowFailure, false);
  return splitNullSeparatedOutput(output).map(toPosixPath);
}

async function runGit(
  workingDir: string,
  args: string[],
  allowFailure = false,
  trim = true
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['--no-pager', ...args], {
      cwd: workingDir,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
    return trim ? stdout.trim() : stdout;
  } catch (error) {
    if (allowFailure) return '';
    throw new Error(`Git command failed: git ${args.join(' ')}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function splitNullSeparatedOutput(output: string): string[] {
  return output.split('\0').filter((value) => value.length > 0);
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await lstat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

function isPathWithin(filePath: string, directoryPath: string): boolean {
  return filePath === directoryPath || filePath.startsWith(`${directoryPath}/`);
}

function toPosixPath(value: string): string {
  return sep === '/' ? value : value.split(sep).join('/');
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSourceFileManifest(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([filePath, fingerprint]) => filePath.length > 0 && typeof fingerprint === 'string'
    )
  );
}

function isFullObjectId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
