// @ts-check

/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const fs = require('node:fs/promises');
const { join, dirname, relative } = require('node:path');
const { pathToFileURL } = require('node:url');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { Writable, Readable } = require('node:stream');
const Ajv2020 = require('ajv/dist/2020');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const yaml = require('yaml');
const drsConfigSchema = require('../src/shared/drs-config-schema.json');
const { runDrs } = require('./drs-cli.cjs');
const { getDiff, getFileDiff } = require('./git.cjs');

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
const WORKFLOW_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const CONFIG_REL = '.drs/drs.config.yaml';
const DEFAULT_PROJECT_CONFIG_YAML = `# DRS project configuration
# Edit structured settings in the form, or use this YAML editor for advanced keys.

workflow:
  default: local-review

review:
  agents:
    - review/unified-reviewer
  ignorePatterns:
    - "*.test.ts"
    - "*.spec.ts"
    - "**/__tests__/**"
    - "**/__mocks__/**"
    - "package-lock.json"
    - "yarn.lock"
    - "pnpm-lock.yaml"
`;

const configValidator = new Ajv2020({ allErrors: true, strict: false }).compile(drsConfigSchema);

/** @type {Map<string, import('child_process').ChildProcess>} */
const runningProcesses = new Map();

/** @type {Map<string, { service: any; workingDir: string }>} */
const reviewChatSessions = new Map();
/** @type {Set<string>} */
const activeReviewChatTurns = new Set();

/** @type {Map<string, any>} */
const acpChatSessions = new Map();
/** @type {Map<string, { conversationId: string; resolve: (value: any) => void }>} */
const acpPermissionRequests = new Map();
/** @type {Map<string, { conversationId: string; resolve: (value: any) => void }>} */
const acpElicitationRequests = new Map();
/** @type {Map<string, { child: import('child_process').ChildProcess; output: string; truncated: boolean; exitStatus: null | { exitCode: number | null; signal: string | null } }>} */
const acpTerminals = new Map();

const defaultGlobalSettings = () => ({ codingAgents: [], defaultCodingAgentId: undefined });

const normalizeThinkingLevel = (value) =>
  ['minimal', 'low', 'medium', 'high'].includes(value) ? value : undefined;

const buildCodingAgentLaunch = (agent, overrides = {}) => {
  const args = Array.isArray(agent.args) ? agent.args.map(String) : [];
  const provider = typeof agent.provider === 'string' ? agent.provider.trim() : '';
  const model = typeof agent.model === 'string' ? agent.model.trim() : '';
  if (agent.kind === 'opencode' && model && !args.includes('--model')) {
    args.push('--model', provider && !model.includes('/') ? `${provider}/${model}` : model);
  }
  return {
    command: agent.command,
    args,
    env: { ...process.env, ...(agent.env || {}), ...(overrides.env || {}) },
  };
};

const getGlobalSettingsPath = () => join(app.getPath('userData'), 'drs-global-settings.json');

const readGlobalSettings = () => {
  const settingsPath = getGlobalSettingsPath();
  if (!existsSync(settingsPath)) return defaultGlobalSettings();
  const parsed = parseJsonSafe(readFileSync(settingsPath, 'utf-8'));
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.codingAgents)) {
    return defaultGlobalSettings();
  }
  return {
    codingAgents: parsed.codingAgents
      .filter((agent) => agent && typeof agent.id === 'string' && typeof agent.command === 'string')
      .map((agent) => ({
        id: agent.id,
        name: typeof agent.name === 'string' && agent.name.trim() ? agent.name : agent.id,
        kind: agent.kind === 'opencode' ? 'opencode' : 'generic',
        command: agent.command,
        args: Array.isArray(agent.args) ? agent.args.map(String) : [],
        provider: typeof agent.provider === 'string' ? agent.provider : undefined,
        model: typeof agent.model === 'string' ? agent.model : undefined,
        thinkingLevel: normalizeThinkingLevel(agent.thinkingLevel),
        env: agent.env && typeof agent.env === 'object' && !Array.isArray(agent.env) ? agent.env : undefined,
      })),
    defaultCodingAgentId:
      typeof parsed.defaultCodingAgentId === 'string' ? parsed.defaultCodingAgentId : undefined,
  };
};

const writeGlobalSettings = (settings) => {
  const normalized = {
    codingAgents: Array.isArray(settings?.codingAgents)
      ? settings.codingAgents.map((agent) => ({
          id: String(agent.id || '').trim(),
          name: String(agent.name || agent.id || '').trim(),
          kind: agent.kind === 'opencode' ? 'opencode' : 'generic',
          command: String(agent.command || '').trim(),
          args: Array.isArray(agent.args) ? agent.args.map(String) : [],
          provider: typeof agent.provider === 'string' && agent.provider.trim() ? agent.provider.trim() : undefined,
          model: typeof agent.model === 'string' && agent.model.trim() ? agent.model.trim() : undefined,
          thinkingLevel: normalizeThinkingLevel(agent.thinkingLevel),
          env: agent.env && typeof agent.env === 'object' && !Array.isArray(agent.env) ? agent.env : undefined,
        }))
      : [],
    defaultCodingAgentId:
      typeof settings?.defaultCodingAgentId === 'string' && settings.defaultCodingAgentId.trim()
        ? settings.defaultCodingAgentId.trim()
        : undefined,
  };
  for (const agent of normalized.codingAgents) {
    if (!agent.id || !agent.name || !agent.command) {
      throw new Error('Each coding agent needs an id, name, and command.');
    }
  }
  const settingsPath = getGlobalSettingsPath();
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  return normalized;
};

const testCodingAgent = async (agentId) => {
  const settings = readGlobalSettings();
  const agent = settings.codingAgents.find((candidate) => candidate.id === agentId);
  if (!agent) throw new Error(`Coding agent not found: ${agentId}`);
  return new Promise((resolve) => {
    let settled = false;
    const launch = buildCodingAgentLaunch(agent);
    const child = spawn(launch.command, launch.args, {
      env: launch.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const chunks = [];
    const finish = (ok, message) => {
      if (settled) return;
      settled = true;
      if (!child.killed) child.kill('SIGTERM');
      resolve({ ok, message });
    };
    child.stderr?.on('data', (chunk) => chunks.push(chunk.toString()));
    child.on('error', (error) => finish(false, error instanceof Error ? error.message : String(error)));
    child.on('exit', (code, signal) => {
      if (settled) return;
      const detail = chunks.join('').trim();
      finish(code === 0, `Process exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}${detail ? `: ${detail}` : ''}`);
    });
    setTimeout(() => finish(true, 'Agent command launched successfully.'), 1500);
  });
};

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

const parseJsonRequired = (text, label) => {
  const parsed = parseJsonSafe(text);
  if (parsed === null) throw new Error(`Could not parse ${label} JSON.`);
  return parsed;
};

/** @param {string[]} args @param {string | undefined} value */
const pushOptional = (args, flag, value) => {
  if (value !== undefined && value !== null && String(value).trim() !== '') args.push(flag, String(value));
};

/** @param {string[]} args @param {string[] | undefined} values */
const pushRepeated = (args, flag, values) => {
  for (const value of values || []) pushOptional(args, flag, value);
};

const runDrsJson = async (workingDir, args) => {
  const { stdout } = await runDrs({
    repoRoot,
    workingDir,
    args: [...args, '--json'],
    timeoutMs: 30000,
  });
  return parseJsonRequired(stdout, 'task');
};

const runDrsJsonAllowNonZero = async (workingDir, args) => {
  const { stdout } = await runDrs({
    repoRoot,
    workingDir,
    args: [...args, '--json'],
    timeoutMs: 30000,
    allowNonZero: true,
  });
  return parseJsonRequired(stdout, 'project setup');
};

const runTaskJson = async (workingDir, args) => runDrsJson(workingDir, ['task', ...args]);

const contentToText = (content) => {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(contentToText).filter(Boolean).join('\n');
  if (content.type === 'text' && typeof content.text === 'string') return content.text;
  if (content.type === 'content') return contentToText(content.content);
  if (content.type === 'terminal' && content.terminalId) {
    const terminal = acpTerminals.get(content.terminalId);
    return terminal?.output || '';
  }
  return '';
};

const inferPermissionRisk = (toolCall) => {
  const kind = toolCall?.kind;
  const title = `${toolCall?.title || ''}`.toLowerCase();
  const rawInput = JSON.stringify(toolCall?.rawInput || {}).toLowerCase();
  if (kind === 'delete' || kind === 'move' || title.includes('delete')) return 'high';
  if (kind === 'execute' || kind === 'edit' || rawInput.includes('prd-update') || rawInput.includes('stories-import')) return 'high';
  if (kind === 'write' || kind === 'other') return 'medium';
  return 'low';
};

const permissionAllows = (response) => {
  const outcome = response?.outcome;
  if (!outcome || outcome.outcome === 'cancelled') return false;
  return !String(outcome.optionId || '').toLowerCase().includes('reject');
};

const createTerminal = (params) => {
  const terminalId = `term_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const cwd = typeof params.cwd === 'string' && params.cwd ? params.cwd : undefined;
  const outputByteLimit = typeof params.outputByteLimit === 'number' ? params.outputByteLimit : 1024 * 1024;
  const child = spawn(params.command, Array.isArray(params.args) ? params.args.map(String) : [], {
    cwd,
    env: {
      ...process.env,
      ...(Array.isArray(params.env)
        ? Object.fromEntries(params.env.map((entry) => [entry.name, entry.value]))
        : {}),
    },
    shell: false,
  });
  const record = { child, output: '', truncated: false, exitStatus: null };
  const append = (chunk) => {
    record.output += chunk.toString();
    if (Buffer.byteLength(record.output, 'utf-8') > outputByteLimit) {
      record.truncated = true;
      record.output = record.output.slice(-outputByteLimit);
    }
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.on('exit', (exitCode, signal) => {
    record.exitStatus = { exitCode, signal };
  });
  acpTerminals.set(terminalId, record);
  return { terminalId };
};

const waitForTerminalExit = async (terminalId) => {
  const record = acpTerminals.get(terminalId);
  if (!record) throw new Error(`Unknown terminal: ${terminalId}`);
  if (record.exitStatus) return record.exitStatus;
  return new Promise((resolve) => {
    record.child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });
};

const requestAcpPermission = (conversationId, webContents, params) => {
  const permissionId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  webContents.send('drs:reviewChatEvent', {
    type: 'permission_request',
    conversationId,
    permissionId,
    toolCallId: params.toolCall?.toolCallId,
    title: params.toolCall?.title,
    kind: params.toolCall?.kind,
    status: params.toolCall?.status,
    content: contentToText(params.toolCall?.content),
    risk: inferPermissionRisk(params.toolCall),
    rawInput: params.toolCall?.rawInput,
    options: (params.options || []).map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    })),
  });
  return new Promise((resolve) => {
    acpPermissionRequests.set(permissionId, { conversationId, resolve });
  });
};

const requestAcpElicitation = (conversationId, webContents, params) => {
  const elicitationId = params.elicitationId || `elic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  webContents.send('drs:reviewChatEvent', {
    type: 'elicitation_request',
    conversationId,
    elicitationId,
    mode: params.mode,
    message: params.message || 'Input required',
    toolCallId: params.toolCallId,
    url: params.url,
    schema: params.requestedSchema,
  });
  return new Promise((resolve) => {
    acpElicitationRequests.set(elicitationId, { conversationId, resolve });
  });
};

const requireClientToolPermission = async (conversationId, webContents, toolCall) => {
  const response = await requestAcpPermission(conversationId, webContents, {
    toolCall,
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
  });
  if (!permissionAllows(response)) throw new Error(`Rejected ${toolCall.title || 'tool call'}.`);
};

const startAcpFactorySession = async ({ workingDir, prdId, codingAgentId, thinkingLevel }, webContents) => {
  const settings = readGlobalSettings();
  const selectedId = codingAgentId || settings.defaultCodingAgentId || settings.codingAgents[0]?.id;
  const agent = settings.codingAgents.find((candidate) => candidate.id === selectedId);
  if (!agent) throw new Error('Configure a global ACP coding agent in Settings before using Factory agent chat.');

  await runDrsJsonAllowNonZero(workingDir, ['sync']);

  const acp = await import('@agentclientprotocol/sdk');
  const launch = buildCodingAgentLaunch(agent);
  const child = spawn(launch.command, launch.args, {
    cwd: workingDir,
    env: launch.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (chunk) => {
    // Keep stderr visible without treating agent diagnostics as turn failures.
    webContents.send('drs:reviewChatEvent', {
      type: 'tool_call_update',
      conversationId: sessionId,
      toolCallId: 'agent-stderr',
      status: 'in_progress',
      content: chunk.toString(),
    });
  });

  const input = Writable.toWeb(child.stdin);
  const output = Readable.toWeb(child.stdout);
  const stream = acp.ndJsonStream(input, output);
  const sessionId = `acp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const client = acp
    .client({ name: 'drs-desktop' })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
      requestAcpPermission(sessionId, webContents, ctx.params)
    )
    .onRequest(acp.methods.client.elicitation.create, (ctx) =>
      requestAcpElicitation(sessionId, webContents, ctx.params)
    )
    .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => ({
      content: await fs.readFile(ctx.params.path, 'utf-8'),
    }))
    .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
      await requireClientToolPermission(sessionId, webContents, {
        toolCallId: `write-${Date.now()}`,
        title: `Write ${ctx.params.path}`,
        kind: 'edit',
        status: 'pending',
        rawInput: { path: ctx.params.path },
      });
      await fs.mkdir(dirname(ctx.params.path), { recursive: true });
      await fs.writeFile(ctx.params.path, ctx.params.content, 'utf-8');
      return {};
    })
    .onRequest('terminal/create', async (ctx) => {
      await requireClientToolPermission(sessionId, webContents, {
        toolCallId: `terminal-${Date.now()}`,
        title: `Run ${ctx.params.command}`,
        kind: 'execute',
        status: 'pending',
        rawInput: ctx.params,
      });
      return createTerminal(ctx.params);
    })
    .onRequest('terminal/output', (ctx) => {
      const terminal = acpTerminals.get(ctx.params.terminalId);
      if (!terminal) throw new Error(`Unknown terminal: ${ctx.params.terminalId}`);
      return { output: terminal.output, truncated: terminal.truncated, exitStatus: terminal.exitStatus };
    })
    .onRequest('terminal/wait_for_exit', async (ctx) => waitForTerminalExit(ctx.params.terminalId))
    .onRequest('terminal/kill', (ctx) => {
      const terminal = acpTerminals.get(ctx.params.terminalId);
      if (terminal) terminal.child.kill('SIGTERM');
      return {};
    })
    .onRequest('terminal/release', (ctx) => {
      const terminal = acpTerminals.get(ctx.params.terminalId);
      if (terminal && !terminal.exitStatus) terminal.child.kill('SIGTERM');
      acpTerminals.delete(ctx.params.terminalId);
      return {};
    });

  const connectionPromise = client.connectWith(stream, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        elicitation: { form: {}, url: {} },
      },
    });
    return ctx.buildSession(workingDir).withSession(async (builtSession) => new Promise((resolve) => {
      acpChatSessions.set(sessionId, { child, session: builtSession, resolve, active: false, agent });
    }));
  });

  const start = Date.now();
  while (!acpChatSessions.has(sessionId)) {
    if (Date.now() - start > 5000) throw new Error('Timed out starting ACP agent session.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const selectedThinkingLevel = normalizeThinkingLevel(thinkingLevel) || agent.thinkingLevel;
  acpChatSessions.get(sessionId).systemPrompt = [
    'You are running inside DRS Desktop Factory as a planning-only coding agent.',
    `Working directory: ${workingDir}`,
    prdId ? `Selected PRD id: ${prdId}` : 'No PRD is selected yet.',
    selectedThinkingLevel ? `Requested reasoning/thinking level for this session: ${selectedThinkingLevel}.` : null,
    'Use the Factory planning skill when planning, refining, or reviewing Factory PRDs and stories.',
    'Use DRS CLI commands to persist Factory artifacts. Prefer drs factory prd-show/prd-update/prd-history/prd-revert/stories-generate/status/import commands.',
    'Stay in planning mode. Do not implement application code or claim implementation tasks.',
  ].filter(Boolean).join('\n\n');

  connectionPromise.catch((error) => {
    webContents.send('drs:reviewChatEvent', {
      type: 'error',
      conversationId: sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
  });

  return { conversationId: sessionId };
};

const sendAcpFactoryMessage = async ({ conversationId, prompt }, webContents) => {
  const record = acpChatSessions.get(conversationId);
  if (!record) throw new Error(`ACP Factory chat session not found: ${conversationId}`);
  if (record.active) throw new Error('An ACP Factory chat turn is already running.');
  record.active = true;
  try {
    record.session.prompt(`${record.systemPrompt}\n\nUser message:\n${prompt}`);
    for (;;) {
      const message = await record.session.nextUpdate();
      if (message.kind === 'stop') break;
      const update = message.notification.update;
      if (update.sessionUpdate === 'agent_message_chunk') {
        webContents.send('drs:reviewChatEvent', {
          type: 'message_delta',
          conversationId,
          messageId: update.messageId || `acp-${Date.now()}`,
          text: contentToText(update.content),
        });
      } else if (update.sessionUpdate === 'tool_call') {
        webContents.send('drs:reviewChatEvent', {
          type: 'tool_call',
          conversationId,
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind,
          status: update.status,
          content: contentToText(update.content),
        });
      } else if (update.sessionUpdate === 'tool_call_update') {
        webContents.send('drs:reviewChatEvent', {
          type: 'tool_call_update',
          conversationId,
          toolCallId: update.toolCallId,
          status: update.status,
          content: contentToText(update.content),
        });
      }
    }
    webContents.send('drs:reviewChatEvent', { type: 'turn_done', conversationId });
  } finally {
    record.active = false;
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

/** @param {string} workingDir */
const getProjectConfigPath = (workingDir) => join(workingDir, CONFIG_REL);

/** @param {unknown} value */
const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} value */
const validateProjectConfigValue = (value) => {
  if (!isPlainObject(value)) return ['Configuration must be a YAML object.'];
  const valid = configValidator(value);
  if (valid) return [];
  return (configValidator.errors || []).map((error) => {
    const path = error.instancePath || '/';
    return `${path} ${error.message || 'is invalid'}`;
  });
};

/** @param {string} source */
const parseProjectConfigYaml = (source) => {
  try {
    const value = yaml.parse(source) ?? {};
    return { value, errors: validateProjectConfigValue(value) };
  } catch (error) {
    return {
      value: {},
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
};

/** @param {string} workingDir */
const readProjectConfigFile = (workingDir) => {
  const configPath = getProjectConfigPath(workingDir);
  const exists = existsSync(configPath);
  const source = exists ? readFileSync(configPath, 'utf-8') : DEFAULT_PROJECT_CONFIG_YAML;
  const parsed = parseProjectConfigYaml(source);
  return {
    path: configPath,
    exists,
    yaml: source,
    value: isPlainObject(parsed.value) ? parsed.value : {},
    errors: parsed.errors,
  };
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
const collectLatestReviewArtifactPaths = async (directory) => {
  const paths = [];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = join(directory, entry.name);
    if (entry.name === 'review') {
      paths.push(join(entryPath, 'latest.json'));
    } else {
      paths.push(...(await collectLatestReviewArtifactPaths(entryPath)));
    }
  }
  return paths;
};

/** @param {string} workingDir */
const readLatestReviewArtifact = async (workingDir) => {
  const latestPaths = await collectLatestReviewArtifactPaths(join(workingDir, '.drs/artifacts'));
  const candidates = [];
  for (const absPath of latestPaths) {
    let source;
    try {
      source = await fs.readFile(absPath, 'utf-8');
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    const parsed = parseJsonSafe(source);
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
    throw new Error(
      'Live review chat requires a bundled DRS runtime. Use DRS_CLI one-shot chat fallback in packaged builds for now.'
    );
  }
  const conversationPath = join(repoRoot, 'dist', 'lib', 'conversation.js');
  const configPath = join(repoRoot, 'dist', 'lib', 'config.js');
  if (!existsSync(conversationPath) || !existsSync(configPath)) {
    throw new Error(
      'Live review chat requires a built DRS runtime. Run `npm --prefix ../ run build` or `npm run setup:drs` from desktop/.'
    );
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

  ipcMain.handle('drs:getProjectSetupStatus', async (_event, workingDir) => {
    return runDrsJsonAllowNonZero(workingDir, ['doctor']);
  });

  ipcMain.handle('drs:initProject', async (_event, workingDir) => {
    await runDrs({ repoRoot, workingDir, args: ['init', '--yes'], timeoutMs: 30000 });
    return runDrsJsonAllowNonZero(workingDir, ['doctor']);
  });

  ipcMain.handle('drs:syncProjectSetup', async (_event, workingDir) => {
    return runDrsJsonAllowNonZero(workingDir, ['sync']);
  });

  ipcMain.handle('drs:getFileDiff', async (_event, workingDir, opts) => {
    return getFileDiff(workingDir, opts || {});
  });

  ipcMain.handle('drs:listTasks', async (_event, workingDir) => {
    const result = await runTaskJson(workingDir, ['list', '--all']);
    return result.tasks || [];
  });

  ipcMain.handle('drs:addTask', async (_event, req) => {
    const args = ['add', '--title', req.title];
    pushOptional(args, '--description', req.description);
    pushOptional(args, '--status', req.status);
    pushOptional(args, '--priority', req.priority);
    pushRepeated(args, '--acceptance', req.acceptanceCriteria);
    return runTaskJson(req.workingDir, args);
  });

  ipcMain.handle('drs:updateTask', async (_event, req) => {
    const args = ['edit', req.id];
    pushOptional(args, '--title', req.title);
    pushOptional(args, '--description', req.description);
    pushOptional(args, '--status', req.status);
    pushOptional(args, '--priority', req.priority);
    pushRepeated(args, '--acceptance', req.acceptanceCriteria);
    return runTaskJson(req.workingDir, args);
  });

  ipcMain.handle('drs:listPrds', async (_event, workingDir) => {
    const result = await runDrsJson(workingDir, ['factory', 'list']);
    return result.prds || [];
  });

  ipcMain.handle('drs:createPrd', async (_event, req) => {
    const args = ['factory', 'prd-create', '--title', req.title];
    pushOptional(args, '--prompt', req.prompt);
    pushOptional(args, '--markdown', req.markdown);
    return runDrsJson(req.workingDir, args);
  });

  ipcMain.handle('drs:getPrd', async (_event, workingDir, id) => {
    return runDrsJson(workingDir, ['factory', 'prd-show', id]);
  });

  ipcMain.handle('drs:updatePrd', async (_event, req) => {
    return runDrsJson(req.workingDir, ['factory', 'prd-update', req.id, '--markdown', req.markdown]);
  });

  ipcMain.handle('drs:updatePrdStatus', async (_event, req) => {
    return runDrsJson(req.workingDir, ['factory', 'prd-status', req.id, req.status]);
  });

  ipcMain.handle('drs:generateStories', async (_event, workingDir, prdId) => {
    return runDrsJson(workingDir, ['factory', 'stories-generate', prdId]);
  });

  ipcMain.handle('drs:updateStoryStatus', async (_event, req) => {
    return runDrsJson(req.workingDir, ['factory', 'story-status', req.prdId, req.storyId, req.status]);
  });

  ipcMain.handle('drs:importStories', async (_event, workingDir, prdId) => {
    const result = await runDrsJson(workingDir, ['factory', 'stories-import', prdId]);
    return result.tasks || [];
  });

  ipcMain.handle('drs:listPrdVersions', async (_event, workingDir, prdId) => {
    const result = await runDrsJson(workingDir, ['factory', 'prd-history', prdId]);
    return result.versions || [];
  });

  ipcMain.handle('drs:revertPrdVersion', async (_event, workingDir, prdId, versionId) => {
    return runDrsJson(workingDir, ['factory', 'prd-revert', prdId, versionId]);
  });

  ipcMain.handle('drs:getReviewArtifact', async (_event, workingDir) => {
    return await readLatestReviewArtifact(workingDir);
  });

  ipcMain.handle('drs:getProjectConfig', async (_event, workingDir) => {
    if (!workingDir || typeof workingDir !== 'string') {
      throw new Error('A working directory is required for project settings.');
    }
    return readProjectConfigFile(workingDir);
  });

  ipcMain.handle('drs:saveProjectConfig', async (_event, req) => {
    const { workingDir, yaml: source } = req || {};
    if (!workingDir || typeof workingDir !== 'string') {
      throw new Error('A working directory is required for project settings.');
    }
    if (typeof source !== 'string') {
      throw new Error('Configuration YAML is required.');
    }

    const parsed = parseProjectConfigYaml(source);
    if (parsed.errors.length > 0) {
      throw new Error(`Configuration is invalid:\n${parsed.errors.join('\n')}`);
    }

    mkdirSync(join(workingDir, '.drs'), { recursive: true });
    writeFileSync(getProjectConfigPath(workingDir), source, 'utf-8');
    return { config: readProjectConfigFile(workingDir) };
  });

  ipcMain.handle('drs:getGlobalSettings', async () => readGlobalSettings());

  ipcMain.handle('drs:saveGlobalSettings', async (_event, settings) => writeGlobalSettings(settings));

  ipcMain.handle('drs:testCodingAgent', async (_event, agentId) => {
    if (!agentId || typeof agentId !== 'string') throw new Error('A coding agent id is required.');
    return testCodingAgent(agentId);
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
    const reviewOutput = await readLatestReviewArtifact(workingDir);
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

  ipcMain.handle('drs:startFactoryChat', async (_event, req) => {
    const { workingDir, prdId, agent, codingAgentId, thinkingLevel } = req || {};
    if (!workingDir || typeof workingDir !== 'string') {
      throw new Error('A working directory is required for factory chat.');
    }
    const globalSettings = readGlobalSettings();
    const selectedCodingAgentId = codingAgentId || globalSettings.defaultCodingAgentId;
    if (selectedCodingAgentId) {
      return startAcpFactorySession({ workingDir, prdId, codingAgentId: selectedCodingAgentId, thinkingLevel }, _event.sender);
    }
    const { ConversationService, loadConfig } = await loadDrsConversationRuntime();
    const config = loadConfig(workingDir);
    const service = new ConversationService({ config, workingDir });
    const conversation = await service.startConversation({
      agent,
      subject: { kind: 'factory', prdId },
    });
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
    if (!record && acpChatSessions.has(conversationId)) {
      return sendAcpFactoryMessage({ conversationId, prompt }, event.sender);
    }
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

  ipcMain.handle('drs:respondChatPermission', async (_event, req) => {
    const { conversationId, permissionId, optionId, cancelled } = req || {};
    if (!conversationId || typeof conversationId !== 'string') {
      throw new Error('A conversation id is required for permission responses.');
    }
    if (!permissionId || typeof permissionId !== 'string') {
      throw new Error('A permission id is required for permission responses.');
    }
    const pending = acpPermissionRequests.get(permissionId);
    if (!pending || pending.conversationId !== conversationId) {
      throw new Error(`Permission request not found: ${permissionId}`);
    }
    acpPermissionRequests.delete(permissionId);
    const fallbackOption = optionId || (cancelled ? undefined : 'reject-once');
    pending.resolve({
      outcome: cancelled
        ? { outcome: 'cancelled' }
        : { outcome: 'selected', optionId: fallbackOption },
    });
    return null;
  });

  ipcMain.handle('drs:respondChatElicitation', async (_event, req) => {
    const { conversationId, elicitationId, action, content } = req || {};
    if (!conversationId || typeof conversationId !== 'string') {
      throw new Error('A conversation id is required for elicitation responses.');
    }
    if (!elicitationId || typeof elicitationId !== 'string') {
      throw new Error('An elicitation id is required for elicitation responses.');
    }
    if (!['accept', 'decline', 'cancel'].includes(action)) {
      throw new Error('A valid elicitation action is required.');
    }
    const pending = acpElicitationRequests.get(elicitationId);
    if (!pending || pending.conversationId !== conversationId) {
      throw new Error(`Elicitation request not found: ${elicitationId}`);
    }
    acpElicitationRequests.delete(elicitationId);
    pending.resolve(action === 'accept' ? { action, content: content || {} } : { action });
    return null;
  });

  ipcMain.handle('drs:closeReviewChat', async (_event, conversationId) => {
    const acpRecord = acpChatSessions.get(conversationId);
    if (acpRecord) {
      for (const [permissionId, pending] of acpPermissionRequests) {
        if (pending.conversationId === conversationId) {
          pending.resolve({ outcome: { outcome: 'cancelled' } });
          acpPermissionRequests.delete(permissionId);
        }
      }
      for (const [elicitationId, pending] of acpElicitationRequests) {
        if (pending.conversationId === conversationId) {
          pending.resolve({ action: 'cancel' });
          acpElicitationRequests.delete(elicitationId);
        }
      }
      acpRecord.resolve?.({ stopReason: 'cancelled' });
      acpRecord.child?.kill('SIGTERM');
      acpChatSessions.delete(conversationId);
      return null;
    }
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
