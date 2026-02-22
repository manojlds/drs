import { randomUUID } from 'crypto';
import { isAbsolute, join, resolve } from 'path';
import { Type } from '@sinclair/typebox';
import {
  AuthStorage,
  createAgentSession,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import { writeJsonOutput } from '../lib/write-json-output.js';

export interface PiSessionPart {
  text?: string;
}

export interface PiSessionMessage {
  info?: {
    id?: string;
    role?: string;
    time?: { completed?: number };
    error?: unknown;
  };
  parts?: PiSessionPart[];
}

export interface PiSessionApi {
  create(input: { query: { directory?: string } }): Promise<{ data?: { id?: string } }>;
  prompt(input: {
    path: { id: string };
    query: { directory?: string };
    body: { agent: string; parts: Array<{ type: 'text'; text: string }> };
  }): Promise<unknown>;
  messages(input: { path: { id: string } }): Promise<{ data?: PiSessionMessage[] }>;
  delete(input: { path: { id: string } }): Promise<unknown>;
  sendMessage?(input: { path: { id: string }; body: { content: string } }): Promise<unknown>;
}

export interface PiClient {
  session: PiSessionApi;
}

export interface PiInProcessServer {
  server: {
    url: string;
    close: () => void;
  };
  client: PiClient;
}

interface PiRuntimeConfig {
  tools?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  provider?: Record<string, unknown>;
  skillSearchPaths?: string[];
  agentSkills?: Record<string, string[]>;
}

interface SessionRecord {
  id: string;
  cwd: string;
  agent?: string;
  session?: AgentSession;
  error?: unknown;
}

type PiBuiltInTool =
  | ReturnType<typeof createReadTool>
  | ReturnType<typeof createBashTool>
  | ReturnType<typeof createEditTool>
  | ReturnType<typeof createWriteTool>
  | ReturnType<typeof createGrepTool>
  | ReturnType<typeof createFindTool>
  | ReturnType<typeof createLsTool>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
}

function normalizeAgentSkills(value: Record<string, unknown>): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};

  for (const [agentName, skills] of Object.entries(value)) {
    const parsedSkills = asStringArray(skills);
    if (parsedSkills.length > 0) {
      normalized[agentName] = parsedSkills;
    }
  }

  return normalized;
}

function normalizeSkillPath(cwd: string, skillPath: string): string {
  return isAbsolute(skillPath) ? resolve(skillPath) : resolve(cwd, skillPath);
}

function extractText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return '';
      }

      const typedPart = part as { type?: string; text?: string; thinking?: string };
      if (typedPart.type === 'text') {
        return typedPart.text ?? '';
      }
      if (typedPart.type === 'thinking') {
        return typedPart.thinking ?? '';
      }
      return '';
    })
    .join('');
}

function toSessionMessage(
  rawMessage: unknown,
  sessionId: string,
  index: number
): PiSessionMessage | null {
  const message = asRecord(rawMessage);
  const role = asString(message.role);
  if (!role) {
    return null;
  }

  const timestamp = typeof message.timestamp === 'number' ? message.timestamp : Date.now();

  if (role === 'user') {
    return {
      info: {
        id: `${sessionId}-${index}`,
        role: 'user',
        time: { completed: timestamp },
      },
      parts: [{ text: extractText(message.content) }],
    };
  }

  if (role === 'assistant') {
    return {
      info: {
        id: `${sessionId}-${index}`,
        role: 'assistant',
        time: { completed: timestamp },
        error: message.errorMessage,
      },
      parts: [{ text: extractText(message.content) }],
    };
  }

  if (role === 'toolResult') {
    const isError = message.isError === true;
    return {
      info: {
        id: `${sessionId}-${index}`,
        role: 'tool',
        time: { completed: timestamp },
        error: isError ? extractText(message.content) : undefined,
      },
      parts: [{ text: extractText(message.content) }],
    };
  }

  return null;
}

class PiSessionRuntime {
  private readonly runtimeConfig: PiRuntimeConfig;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly sessions = new Map<string, SessionRecord>();

  readonly sessionApi: PiSessionApi;

  constructor(config: Record<string, unknown>) {
    this.runtimeConfig = {
      tools: asRecord(config.tools),
      agent: asRecord(config.agent),
      provider: asRecord(config.provider),
      skillSearchPaths: asStringArray(config.skillSearchPaths),
      agentSkills: normalizeAgentSkills(asRecord(config.agentSkills)),
    };

    this.authStorage = AuthStorage.create();
    this.modelRegistry = new ModelRegistry(this.authStorage);
    this.registerCustomProviders();

    this.sessionApi = {
      create: (input) => this.createSession(input),
      prompt: (input) => this.promptSession(input),
      messages: (input) => this.readMessages(input),
      delete: (input) => this.deleteSession(input),
      sendMessage: (input) => this.sendMessage(input),
    };
  }

  close(): void {
    for (const record of this.sessions.values()) {
      record.session?.dispose();
    }
    this.sessions.clear();
  }

  private registerCustomProviders(): void {
    for (const [providerName, providerConfig] of Object.entries(
      this.runtimeConfig.provider ?? {}
    )) {
      const provider = asRecord(providerConfig);
      const options = asRecord(provider.options);
      const models = asRecord(provider.models);

      const modelEntries = Object.entries(models).map(([id, modelValue]) => ({
        id,
        name: asString(asRecord(modelValue).name) ?? id,
        api: 'openai-completions',
        reasoning: true,
        input: ['text'] as Array<'text' | 'image'>,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 128000,
        maxTokens: 16384,
      }));

      const providerInput: Record<string, unknown> = {
        api: 'openai-completions',
      };

      if (typeof options.baseURL === 'string' && options.baseURL.length > 0) {
        providerInput.baseUrl = options.baseURL;
      }

      if (typeof options.apiKey === 'string' && options.apiKey.length > 0) {
        providerInput.apiKey = options.apiKey;
      }

      if (modelEntries.length > 0) {
        providerInput.models = modelEntries;
      }

      this.modelRegistry.registerProvider(
        providerName,
        providerInput as Parameters<ModelRegistry['registerProvider']>[1]
      );
    }
  }

  private resolveAgentSettings(agentName: string): { prompt?: string; model?: string } {
    const agentConfig = asRecord(this.runtimeConfig.agent?.[agentName]);
    return {
      prompt: asString(agentConfig.prompt),
      model: asString(agentConfig.model),
    };
  }

  private resolveModel(modelId?: string) {
    if (!modelId) {
      return undefined;
    }

    const [provider, ...rest] = modelId.split('/');
    if (!provider || rest.length === 0) {
      throw new Error(`Failed to resolve model "${modelId}"`);
    }

    const model = this.modelRegistry.find(provider, rest.join('/'));
    if (!model) {
      throw new Error(`Failed to resolve model "${modelId}"`);
    }

    return model;
  }

  private isToolEnabled(toolName: string, defaultValue: boolean): boolean {
    const value = this.runtimeConfig.tools?.[toolName];
    return typeof value === 'boolean' ? value : defaultValue;
  }

  private resolveTools(cwd: string): PiBuiltInTool[] {
    const tools: PiBuiltInTool[] = [];

    if (this.isToolEnabled('Read', true)) {
      tools.push(createReadTool(cwd));
    }
    if (this.isToolEnabled('Bash', true)) {
      tools.push(createBashTool(cwd));
    }
    if (this.isToolEnabled('Edit', false)) {
      tools.push(createEditTool(cwd));
    }
    if (this.isToolEnabled('Write', false)) {
      tools.push(createWriteTool(cwd));
    }
    if (this.isToolEnabled('Grep', true)) {
      tools.push(createGrepTool(cwd));
    }
    if (this.isToolEnabled('Glob', true)) {
      tools.push(createFindTool(cwd));
      tools.push(createLsTool(cwd));
    }

    if (tools.length === 0) {
      tools.push(createReadTool(cwd), createBashTool(cwd));
    }

    return tools;
  }

  private resolveSkillSearchPaths(cwd: string): string[] {
    const configuredPaths = this.runtimeConfig.skillSearchPaths ?? [];

    if (configuredPaths.length === 0) {
      return [join(cwd, '.drs', 'skills'), join(cwd, '.pi', 'skills')];
    }

    return configuredPaths.map((skillPath) => normalizeSkillPath(cwd, skillPath));
  }

  private resolveAgentSkills(agentName: string): string[] {
    return this.runtimeConfig.agentSkills?.[agentName] ?? [];
  }

  private resolveCustomTools(workingDir: string): ToolDefinition[] {
    const customTools: ToolDefinition[] = [];

    if (this.isToolEnabled('write_json_output', true)) {
      customTools.push({
        name: 'write_json_output',
        label: 'write_json_output',
        description: 'Validate and write structured JSON output for DRS agents.',
        parameters: Type.Object({
          outputType: Type.Union([Type.Literal('describe_output'), Type.Literal('review_output')]),
          payload: Type.Any(),
          pretty: Type.Optional(Type.Boolean()),
          indent: Type.Optional(Type.Number({ minimum: 2, maximum: 8 })),
        }),
        execute: async (
          _toolCallId,
          params: {
            outputType: 'describe_output' | 'review_output';
            payload: unknown;
            pretty?: boolean;
            indent?: number;
          }
        ) => {
          const pointer = await writeJsonOutput({
            outputType: params.outputType,
            payload: params.payload,
            pretty: params.pretty,
            indent: params.indent,
            workingDir,
          });

          return {
            content: [{ type: 'text', text: JSON.stringify(pointer) }],
            details: pointer,
          };
        },
      });
    }

    return customTools;
  }

  private async createAgentSession(cwd: string, agentName: string): Promise<AgentSession> {
    const settings = this.resolveAgentSettings(agentName);
    const configuredSkillNames = new Set(this.resolveAgentSkills(agentName));
    const skillSearchPaths = this.resolveSkillSearchPaths(cwd);

    const resourceLoader = new DefaultResourceLoader({
      cwd,
      noSkills: true,
      additionalSkillPaths: skillSearchPaths,
      skillsOverride:
        configuredSkillNames.size > 0
          ? (base) => ({
              skills: base.skills.filter((skill) => configuredSkillNames.has(skill.name)),
              diagnostics: base.diagnostics,
            })
          : undefined,
      systemPromptOverride: () =>
        settings.prompt ?? `You are ${agentName}. Provide concise, actionable answers.`,
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();

    if (configuredSkillNames.size > 0) {
      const loadedSkillNames = new Set(
        resourceLoader.getSkills().skills.map((skill) => skill.name)
      );
      const missingSkills = Array.from(configuredSkillNames).filter(
        (skillName) => !loadedSkillNames.has(skillName)
      );
      if (missingSkills.length > 0) {
        console.warn(`⚠️  Missing skill definitions for ${agentName}: ${missingSkills.join(', ')}`);
      }
    }

    const { session } = await createAgentSession({
      cwd,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      model: this.resolveModel(settings.model),
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      tools: this.resolveTools(cwd),
      customTools: this.resolveCustomTools(cwd),
    });

    return session;
  }

  private getSessionRecord(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    return record;
  }

  private createSession(input: {
    query: { directory?: string };
  }): Promise<{ data?: { id?: string } }> {
    const sessionId = randomUUID();
    const cwd = resolve(input.query.directory ?? process.cwd());

    this.sessions.set(sessionId, {
      id: sessionId,
      cwd,
    });

    return Promise.resolve({
      data: {
        id: sessionId,
      },
    });
  }

  private async promptSession(input: {
    path: { id: string };
    query: { directory?: string };
    body: { agent: string; parts: Array<{ type: 'text'; text: string }> };
  }): Promise<unknown> {
    const record = this.getSessionRecord(input.path.id);
    const cwd = resolve(input.query.directory ?? record.cwd);
    const promptText = input.body.parts
      .map((part) => part.text)
      .filter((part) => part.length > 0)
      .join('\n\n');

    try {
      if (!record.session || record.agent !== input.body.agent) {
        record.session?.dispose();
        record.session = await this.createAgentSession(cwd, input.body.agent);
        record.agent = input.body.agent;
        record.cwd = cwd;
      }

      record.error = undefined;
      await record.session.prompt(promptText);
      return { ok: true };
    } catch (error) {
      record.error = error;
      return { ok: false };
    }
  }

  private readMessages(input: { path: { id: string } }): Promise<{ data?: PiSessionMessage[] }> {
    const record = this.getSessionRecord(input.path.id);
    const messages: PiSessionMessage[] = [];

    if (record.session) {
      let index = 0;
      for (const message of record.session.messages) {
        const converted = toSessionMessage(message, record.id, index);
        index += 1;
        if (converted) {
          messages.push(converted);
        }
      }
    }

    if (record.error) {
      messages.push({
        info: {
          id: `${record.id}-error`,
          role: 'assistant',
          time: { completed: Date.now() },
          error: record.error instanceof Error ? record.error.message : String(record.error),
        },
        parts: [{ text: '' }],
      });
    }

    return Promise.resolve({ data: messages });
  }

  private async sendMessage(input: {
    path: { id: string };
    body: { content: string };
  }): Promise<unknown> {
    const record = this.getSessionRecord(input.path.id);

    if (!record.session) {
      throw new Error('Session has not been started yet. Call prompt() first.');
    }

    try {
      record.error = undefined;
      await record.session.prompt(input.body.content);
      return { ok: true };
    } catch (error) {
      record.error = error;
      return { ok: false };
    }
  }

  private deleteSession(input: { path: { id: string } }): Promise<unknown> {
    const record = this.sessions.get(input.path.id);
    if (record?.session) {
      record.session.dispose();
    }
    this.sessions.delete(input.path.id);
    return Promise.resolve({ ok: true });
  }
}

/**
 * Pi SDK adapter used by DRS runtime orchestration.
 */
export function createPiInProcessServer(options: {
  timeout: number;
  config: Record<string, unknown>;
}): Promise<PiInProcessServer> {
  const runtime = new PiSessionRuntime(options.config);

  return Promise.resolve({
    server: {
      url: 'pi://in-process',
      close: () => runtime.close(),
    },
    client: {
      session: runtime.sessionApi,
    },
  });
}
