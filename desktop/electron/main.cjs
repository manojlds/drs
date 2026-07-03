// @ts-check

/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { join, dirname, relative } = require('node:path');
const { pathToFileURL } = require('node:url');
const http = require('node:http');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { runDrs } = require('./drs-cli.cjs');
const { getDiff } = require('./git.cjs');

const isDev = !app.isPackaged;
// desktop/ — electron/ is one level below it.
const root = dirname(__dirname);
// In dev the DRS repo is the parent of desktop/. In packaged builds this is
// null and the DRS CLI is resolved via DRS_CLI or a global `drs` on PATH.
const repoRoot = isDev ? join(root, '..') : null;
const distRenderer = join(root, 'dist-renderer');
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:5173';

// Relative to the reviewed repo's working directory.
const RUN_OUTPUT_REL = '.drs/.desktop-run.json';
const REVIEW_OUTPUT_REL = '.drs/review-output.json';
const WORKFLOW_RUN_TIMEOUT_MS = 30 * 60 * 1000;

/** @type {Map<string, import('child_process').ChildProcess>} */
const runningProcesses = new Map();

/** @type {Map<string, { service: any; workingDir: string }>} */
const reviewChatSessions = new Map();
/** @type {Set<string>} */
const activeReviewChatTurns = new Set();

/** @param {string} url */
const probeDevServer = (url) =>
  new Promise((resolveProbe) => {
    let settled = false;
    const finish = (ok) => {
      if (!settled) {
        settled = true;
        resolveProbe(ok);
      }
    };
    let target;
    try {
      target = new URL(url);
    } catch {
      finish(false);
      return;
    }
    const req = http.get(target, (res) => {
      res.resume();
      finish(res.statusCode === 200);
    });
    req.on('error', () => finish(false));
    req.setTimeout(1500, () => {
      req.destroy();
      finish(false);
    });
  });

/** @param {string} text */
const parseJsonSafe = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** @param {string} workingDir @param {string} relPath */
const readJsonFile = (workingDir, relPath) => {
  const abs = join(workingDir, relPath);
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, 'utf-8'));
  } catch {
    return null;
  }
};

/** @param {unknown} value */
const isReviewArtifactPayload = (value) =>
  !!value &&
  typeof value === 'object' &&
  value.schemaVersion === 1 &&
  typeof value.reviewId === 'string' &&
  typeof value.reviewedAt === 'string' &&
  !!value.summary &&
  typeof value.summary === 'object' &&
  Array.isArray(value.findings);

/** @param {unknown} value */
const isReviewArtifactEnvelope = (value) =>
  !!value &&
  typeof value === 'object' &&
  value.schemaVersion === 1 &&
  value.kind === 'review' &&
  typeof value.id === 'string' &&
  typeof value.createdAt === 'string' &&
  typeof value.updatedAt === 'string' &&
  !!value.scope &&
  typeof value.scope === 'object' &&
  isReviewArtifactPayload(value.payload);

/** @param {string} directory */
const collectLatestReviewArtifactPaths = (directory) => {
  if (!existsSync(directory)) return [];
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const entryPath = join(directory, entry.name);
    if (entry.name === 'review') {
      paths.push(join(entryPath, 'latest.json'));
    } else {
      paths.push(...collectLatestReviewArtifactPaths(entryPath));
    }
  }
  return paths;
};

/** @param {string} workingDir */
const readLatestReviewArtifact = (workingDir) => {
  const latestPaths = collectLatestReviewArtifactPaths(join(workingDir, '.drs/artifacts'));
  const candidates = [];
  for (const absPath of latestPaths) {
    if (!existsSync(absPath)) continue;
    const parsed = parseJsonSafe(readFileSync(absPath, 'utf-8'));
    if (isReviewArtifactEnvelope(parsed)) {
      candidates.push({ artifact: parsed, path: absPath });
    }
  }
  candidates.sort((a, b) => b.artifact.updatedAt.localeCompare(a.artifact.updatedAt));
  const latest = candidates[0];
  if (!latest) return null;
  const payload = latest.artifact.payload;
  return {
    timestamp: payload.reviewedAt,
    summary: payload.summary,
    issues: payload.findings.map((finding) => ({
      ...finding.issue,
      findingId: finding.id,
      findingState: finding.state,
      findingDisposition: finding.disposition,
    })),
    usage: payload.usage,
    metadata: payload.metadata,
    artifact: {
      reviewId: payload.reviewId,
      path: relative(workingDir, latest.path).replace(/\\/g, '/'),
    },
  };
};

async function loadDrsConversationRuntime() {
  if (!repoRoot) {
    throw new Error('Live review chat requires a bundled DRS runtime. Use DRS_CLI one-shot chat fallback in packaged builds for now.');
  }
  const conversationPath = join(repoRoot, 'dist', 'lib', 'conversation.js');
  const configPath = join(repoRoot, 'dist', 'lib', 'config.js');
  if (!existsSync(conversationPath) || !existsSync(configPath)) {
    throw new Error('Live review chat requires a built DRS runtime. Run `npm --prefix ../ run build` or `npm run setup:drs` from desktop/.');
  }
  const [{ ConversationService }, { loadConfig }] = await Promise.all([
    import(pathToFileURL(conversationPath).href),
    import(pathToFileURL(configPath).href),
  ]);
  return { ConversationService, loadConfig };
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#181825',
    title: 'DRS Desktop',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devUp = await probeDevServer(DEV_SERVER_URL);
  if (process.env.ELECTRON_RENDERER_URL || devUp) {
    await win.loadURL(DEV_SERVER_URL);
  } else if (existsSync(join(distRenderer, 'index.html'))) {
    await win.loadFile(join(distRenderer, 'index.html'));
  } else {
    // No build and no dev server: load the dev URL so Electron surfaces a
    // visible error prompting the user to run `npm run dev`.
    await win.loadURL(DEV_SERVER_URL);
  }
}

app.whenReady().then(() => {
  ipcMain.handle('drs:selectDirectory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('drs:getCwd', () => process.cwd());

  ipcMain.handle('drs:listWorkflows', async (_event, workingDir) => {
    const { stdout, stderr } = await runDrs({
      repoRoot,
      workingDir,
      args: ['workflow', 'list', '--json'],
      timeoutMs: 30000,
    });
    const parsed = parseJsonSafe(stdout);
    if (!Array.isArray(parsed)) {
      const detail = (stderr || stdout).trim();
      throw new Error(`Could not parse workflow list JSON.${detail ? `\n${detail}` : ''}`);
    }
    return parsed;
  });

  ipcMain.handle('drs:showWorkflow', async (_event, name, workingDir) => {
    const { stdout } = await runDrs({
      repoRoot,
      workingDir,
      args: ['workflow', 'show', name, '--json'],
      timeoutMs: 30000,
    });
    return parseJsonSafe(stdout);
  });

  ipcMain.handle('drs:getDiff', async (_event, workingDir, opts) => {
    return getDiff(workingDir, opts || {});
  });

  ipcMain.handle('drs:getReviewArtifact', async (_event, workingDir) => {
    return readLatestReviewArtifact(workingDir) || readJsonFile(workingDir, REVIEW_OUTPUT_REL);
  });

  ipcMain.handle('drs:runWorkflow', async (event, req) => {
    const { name, inputs = {}, workingDir, runId } = req;
    const effectiveRunId = runId || `${name}-${Date.now()}`;
    const inputArgs = Object.entries(inputs)
      .map(([key, value]) => ['--input', `${key}=${value}`])
      .flat();
    const args = ['workflow', 'run', name, '--output', RUN_OUTPUT_REL, ...inputArgs];

    try {
      await runDrs({
        repoRoot,
        workingDir,
        args,
        timeoutMs: WORKFLOW_RUN_TIMEOUT_MS,
        onStart: (child) => {
          runningProcesses.set(effectiveRunId, child);
        },
        onOutput: (text, stream) => {
          event.sender.send('drs:workflowLog', { runId: effectiveRunId, stream, text });
        },
      });
    } finally {
      runningProcesses.delete(effectiveRunId);
    }

    const result = readJsonFile(workingDir, RUN_OUTPUT_REL);
    if (!result) {
      throw new Error('Workflow completed but no result file was produced.');
    }
    const reviewOutput = readLatestReviewArtifact(workingDir) || readJsonFile(workingDir, REVIEW_OUTPUT_REL);
    return { result, reviewOutput };
  });

  ipcMain.handle('drs:askReviewChat', async (_event, req) => {
    const { workingDir, prompt } = req || {};
    if (!workingDir || typeof workingDir !== 'string') {
      throw new Error('A working directory is required for review chat.');
    }
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('A prompt is required for review chat.');
    }

    const { stdout, stderr } = await runDrs({
      repoRoot,
      workingDir,
      args: ['chat', '--prompt', prompt, '--json'],
      timeoutMs: WORKFLOW_RUN_TIMEOUT_MS,
    });
    const parsed = parseJsonSafe(stdout);
    if (!parsed || typeof parsed !== 'object') {
      const detail = (stderr || stdout).trim();
      throw new Error(`Could not parse review chat JSON.${detail ? `\n${detail}` : ''}`);
    }
    return {
      conversationId: parsed.conversation?.id || parsed.conversationId || '',
      response: typeof parsed.response === 'string' ? parsed.response : '',
    };
  });

  ipcMain.handle('drs:startReviewChat', async (_event, req) => {
    const { workingDir } = req || {};
    if (!workingDir || typeof workingDir !== 'string') {
      throw new Error('A working directory is required for review chat.');
    }
    const { ConversationService, loadConfig } = await loadDrsConversationRuntime();
    const config = loadConfig(workingDir);
    const service = new ConversationService({ config, workingDir });
    const conversation = await service.startConversation();
    reviewChatSessions.set(conversation.id, { service, workingDir });
    return { conversationId: conversation.id };
  });

  ipcMain.handle('drs:sendReviewChatMessage', async (event, req) => {
    const { conversationId, prompt } = req || {};
    if (!conversationId || typeof conversationId !== 'string') {
      throw new Error('A conversation id is required for review chat.');
    }
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('A prompt is required for review chat.');
    }
    const record = reviewChatSessions.get(conversationId);
    if (!record) {
      throw new Error(`Review chat conversation not found: ${conversationId}`);
    }
    if (activeReviewChatTurns.has(conversationId)) {
      throw new Error('A review chat turn is already running for this conversation.');
    }

    activeReviewChatTurns.add(conversationId);
    try {
      for await (const chatEvent of record.service.streamMessage({
        conversationId,
        message: prompt,
      })) {
        if (chatEvent.type === 'response_delta') {
          event.sender.send('drs:reviewChatEvent', {
            type: 'message_delta',
            conversationId,
            messageId: chatEvent.messageId,
            text: chatEvent.text,
          });
        } else if (chatEvent.type === 'turn_done') {
          event.sender.send('drs:reviewChatEvent', { type: 'turn_done', conversationId });
        }
      }
    } catch (error) {
      event.sender.send('drs:reviewChatEvent', {
        type: 'error',
        conversationId,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      activeReviewChatTurns.delete(conversationId);
    }
  });

  ipcMain.handle('drs:closeReviewChat', async (_event, conversationId) => {
    const record = reviewChatSessions.get(conversationId);
    if (record) {
      await record.service.closeConversation(conversationId);
      reviewChatSessions.delete(conversationId);
      activeReviewChatTurns.delete(conversationId);
    }
    return null;
  });

  ipcMain.handle('drs:cancelWorkflow', async (_event, runId) => {
    const child = runningProcesses.get(runId);
    if (child) {
      child.kill('SIGTERM');
      runningProcesses.delete(runId);
    }
    return null;
  });

  ipcMain.handle('drs:readFile', async (_event, filePath) => {
    return readFileSync(filePath, 'utf-8');
  });

  ipcMain.handle('drs:openExternal', async (_event, url) => {
    await shell.openExternal(url);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
