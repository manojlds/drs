// @ts-check

/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

/**
 * Minimal git helpers for reading the working-tree diff.
 *
 * The renderer receives file summaries up front, then asks for individual file
 * patches as those files become visible. This keeps large patches out of the
 * initial IPC response and protects the renderer from parsing entire repo diffs.
 */

const DEFAULT_MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_BYTES = Number(process.env.DRS_DESKTOP_MAX_DIFF_BYTES || DEFAULT_MAX_PATCH_BYTES);
const STATUS_MAP = {
  A: 'added',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
  C: 'modified',
  T: 'modified',
  U: 'modified',
  X: 'modified',
};

/**
 * @param {string} workingDir
 * @param {string[]} args
 * @returns {Promise<string>}
 */
const runGit = (workingDir, args) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', workingDir, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });

/**
 * @param {string} workingDir
 * @param {string[]} args
 * @param {number} maxBytes
 * @returns {Promise<{ stdout: string; bytes: number; truncated: boolean }>}
 */
const runGitLimited = (workingDir, args, maxBytes) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', workingDir, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    let bytes = 0;
    let stderr = '';
    let truncated = false;
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes <= maxBytes) {
        chunks.push(chunk);
        return;
      }
      truncated = true;
      child.kill();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (truncated) {
        resolve({ stdout: '', bytes, truncated: true });
        return;
      }
      if (code !== 0) {
        reject(new Error(`git ${args.join(' ')} failed (exit ${code}, signal ${signal}): ${stderr.trim()}`));
        return;
      }
      resolve({ stdout: Buffer.concat(chunks).toString('utf-8'), bytes, truncated: false });
    });
  });

/** @param {string} value */
const hashString = (value) => createHash('sha256').update(value).digest('hex');

/**
 * @param {string} nameStatus
 * @param {string} numstat
 */
const parseDiffFiles = (nameStatus, numstat) => {
  const counts = new Map();
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const path = parts.at(-1) || '';
    counts.set(path, {
      additions: Number(parts[0]) || 0,
      deletions: Number(parts[1]) || 0,
    });
  }

  return nameStatus
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const parts = line.split('\t');
      const rawStatus = parts[0] || 'M';
      const statusCode = rawStatus[0];
      const renamed = statusCode === 'R';
      const path = renamed ? parts[2] : parts[1];
      const oldPath = renamed ? parts[1] : null;
      const count = counts.get(path) || { additions: 0, deletions: 0 };
      return {
        path,
        oldPath,
        status: STATUS_MAP[statusCode] || 'modified',
        additions: count.additions,
        deletions: count.deletions,
        binary: false,
      };
    })
    .filter((file) => file.path);
};

/**
 * @param {string} workingDir
 * @param {{ staged?: boolean; maxPatchBytes?: number }} [opts]
 * @returns {Promise<{ patch: string; nameStatus: string; stat: string; files: Array<{ path: string; oldPath: string | null; status: string; additions: number; deletions: number; binary: boolean }>; fingerprint: string; truncated?: boolean; patchBytes?: number; maxPatchBytes?: number }>}
 */
const getDiff = async (workingDir, opts = {}) => {
  const flag = opts.staged ? ['--cached'] : [];
  const maxPatchBytes = opts.maxPatchBytes || MAX_PATCH_BYTES;
  const [probe, nameStatus, numstat, stat] = await Promise.all([
    runGitLimited(workingDir, ['diff', ...flag, '--no-color'], maxPatchBytes),
    runGit(workingDir, ['diff', ...flag, '--name-status']),
    runGit(workingDir, ['diff', ...flag, '--numstat']),
    runGit(workingDir, ['diff', ...flag, '--stat', '--no-color']),
  ]);
  const files = parseDiffFiles(nameStatus, numstat);
  const fingerprint = hashString([nameStatus, numstat, stat].join('\n'));
  if (probe.truncated) {
    return {
      patch: '',
      nameStatus,
      stat,
      files,
      fingerprint,
      truncated: true,
      patchBytes: probe.bytes,
      maxPatchBytes,
    };
  }
  return { patch: '', nameStatus, stat, files, fingerprint, patchBytes: probe.bytes, maxPatchBytes };
};

/**
 * @param {string} workingDir
 * @param {{ staged?: boolean; path: string; maxPatchBytes?: number }} opts
 * @returns {Promise<{ patch: string; truncated?: boolean; patchBytes?: number; maxPatchBytes?: number }>}
 */
const getFileDiff = async (workingDir, opts) => {
  const flag = opts.staged ? ['--cached'] : [];
  const maxPatchBytes = opts.maxPatchBytes || MAX_PATCH_BYTES;
  const result = await runGitLimited(
    workingDir,
    ['diff', ...flag, '--no-color', '--', opts.path],
    maxPatchBytes
  );
  if (result.truncated) {
    return { patch: '', truncated: true, patchBytes: result.bytes, maxPatchBytes };
  }
  return { patch: result.stdout, patchBytes: result.bytes, maxPatchBytes };
};

module.exports = { runGit, getDiff, getFileDiff, parseDiffFiles };
