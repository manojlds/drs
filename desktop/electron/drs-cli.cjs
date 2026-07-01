// @ts-check

/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { spawn } = require('node:child_process');
const { existsSync, statSync } = require('node:fs');
const { join } = require('node:path');

/**
 * DRS CLI resolver + spawner.
 *
 * The Electron main process is CommonJS, while DRS compiles to ESM. Rather than
 * fight the interop, we drive the DRS CLI as a child process (the same pattern
 * Codiff uses for its agent backends) and read structured JSON from stdout or
 * from artifact files on disk.
 *
 * Resolution order:
 *   1. DRS_CLI env var (absolute path to a `drs` executable)
 *   2. In dev: the DRS repo's built `dist/cli/index.js` (run with this Node)
 *   3. A `drs` executable discovered on PATH
 *   4. In dev: `npx tsx <repo>/src/cli/index.ts` (no build required)
 */

/**
 * @param {string} name
 * @returns {string | null}
 */
const findOnPath = (name) => {
  const separator = process.platform === 'win32' ? ';' : ':';
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(separator)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, `${name}${ext}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // ignore
      }
    }
  }
  return null;
};

const resolveNodeExecutable = () => {
  if (process.env.npm_node_execpath) return process.env.npm_node_execpath;
  if (process.env.NODE) return process.env.NODE;
  if (process.versions.electron) return findOnPath('node') || process.execPath;
  return process.execPath;
};

/**
 * @param {{ repoRoot?: string | null }} [options]
 * @returns {{ command: string; args: string[] }}
 */
const resolveDrsCli = (options = {}) => {
  const { repoRoot } = options;

  if (process.env.DRS_CLI && process.env.DRS_CLI.trim()) {
    return { command: process.env.DRS_CLI.trim(), args: [] };
  }

  if (repoRoot) {
    const distCli = join(repoRoot, 'dist', 'cli', 'index.js');
    if (existsSync(distCli)) {
      return { command: resolveNodeExecutable(), args: [distCli] };
    }
  }

  const onPath = findOnPath('drs');
  if (onPath) {
    return { command: onPath, args: [] };
  }

  if (repoRoot) {
    const srcCli = join(repoRoot, 'src', 'cli', 'index.ts');
    if (existsSync(srcCli)) {
      return { command: 'npx', args: ['--yes', 'tsx', srcCli] };
    }
  }

  throw new Error(
    'DRS CLI not found. Build the DRS repo (`npm run build` in the repo root), ' +
      'install @diff-review-system/drs globally, or set the DRS_CLI env var to the ' +
      'path of a `drs` executable.',
  );
};

/**
 * @typedef {{
 *   repoRoot?: string | null;
 *   workingDir: string;
 *   args: string[];
 *   onOutput?: (text: string, stream: 'stdout' | 'stderr') => void;
 *   onStart?: (child: import('child_process').ChildProcess) => void;
 *   timeoutMs?: number;
 * }} RunDrsOptions
 */

/**
 * Run a DRS CLI command and stream output.
 *
 * @param {RunDrsOptions} options
 * @returns {Promise<{ stdout: string; stderr: string }>}
 */
const runDrs = (options) =>
  new Promise((resolve, reject) => {
    const cli = resolveDrsCli({ repoRoot: options.repoRoot });
    const child = spawn(cli.command, [...cli.args, ...options.args], {
      cwd: options.workingDir,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    options.onStart?.(child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeoutMs = options.timeoutMs || 120000;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      options.onOutput?.(text, 'stdout');
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      options.onOutput?.(text, 'stderr');
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(
        error instanceof Error
          ? error
          : new Error(`Failed to launch DRS CLI: ${String(error)}`),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`DRS CLI timed out after ${timeoutMs}ms.`));
        return;
      }
      if (code !== 0) {
        const detail = (stderr || stdout).trim();
        reject(new Error(`DRS CLI exited with code ${code}.${detail ? `\n${detail}` : ''}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

module.exports = { findOnPath, resolveDrsCli, runDrs };
