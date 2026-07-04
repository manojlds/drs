// @ts-check

/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { spawn } = require('node:child_process');

/**
 * Minimal git helpers for reading the working-tree diff.
 *
 * The renderer parses the raw unified diff patch into a structured model for
 * display. We also surface `--name-status` (for add/delete/modify/rename) and a
 * short `--stat` summary.
 */

const DEFAULT_MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_BYTES = Number(process.env.DRS_DESKTOP_MAX_DIFF_BYTES || DEFAULT_MAX_PATCH_BYTES);

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
 * @param {{ staged?: boolean }} [opts]
 * @returns {Promise<{ patch: string; nameStatus: string; stat: string; truncated?: boolean; patchBytes?: number; maxPatchBytes?: number }>}
 */
const getDiff = async (workingDir, opts = {}) => {
  const flag = opts.staged ? ['--cached'] : [];
  const [patch, nameStatus, stat] = await Promise.all([
    runGit(workingDir, ['diff', ...flag, '--no-color']),
    runGit(workingDir, ['diff', ...flag, '--name-status']),
    runGit(workingDir, ['diff', ...flag, '--stat', '--no-color']),
  ]);
  const patchBytes = Buffer.byteLength(patch, 'utf-8');
  if (patchBytes > MAX_PATCH_BYTES) {
    return {
      patch: '',
      nameStatus,
      stat,
      truncated: true,
      patchBytes,
      maxPatchBytes: MAX_PATCH_BYTES,
    };
  }
  return { patch, nameStatus, stat, patchBytes, maxPatchBytes: MAX_PATCH_BYTES };
};

module.exports = { runGit, getDiff };
