import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationService, type ConversationRuntime } from './conversation.js';
import type { SessionMessage } from '../runtime/client.js';

const tempDirs: string[] = [];

async function createTempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'drs-conversation-'));
  tempDirs.push(dir);
  await mkdir(join(dir, '.drs'), { recursive: true });
  return dir;
}

function createRuntime(messages: SessionMessage[] = []): ConversationRuntime {
  return {
    createSession: vi.fn(async () => ({
      id: 'session-123',
      agent: 'task/review-assistant',
      createdAt: new Date(),
    })),
    sendMessage: vi.fn(async () => {}),
    streamMessages: vi.fn(async function* () {
      for (const message of messages) {
        yield message;
      }
    }),
    closeSession: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
}

describe('ConversationService', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('starts a conversation backed by review and workflow artifacts', async () => {
    const workingDir = await createTempProject();
    await writeFile(
      join(workingDir, '.drs/review-output.json'),
      JSON.stringify({ summary: { issuesFound: 1 }, issues: [{ title: 'Bug' }] })
    );
    await writeFile(
      join(workingDir, '.drs/.desktop-run.json'),
      JSON.stringify({ workflow: 'local-review' })
    );

    const runtime = createRuntime([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'There is one issue.',
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
    const service = new ConversationService({
      config: {} as any,
      workingDir,
      runtimeFactory: vi.fn(async () => runtime),
    });

    const conversation = await service.startConversation();
    const result = await service.sendMessage({
      conversationId: conversation.id,
      message: 'What did the review find?',
    });

    expect(runtime.createSession).toHaveBeenCalledWith({
      agent: 'task/review-assistant',
      message: expect.stringContaining('review-output.json'),
    });
    expect(result.response).toBe('There is one issue.');
    expect(result.conversation.piSessionId).toBe('session-123');

    const saved = JSON.parse(
      await readFile(join(workingDir, '.drs/conversations/latest.json'), 'utf-8')
    ) as { messages: Array<{ role: string; content: string }> };
    expect(saved.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('continues an existing Pi session for follow-up messages', async () => {
    const workingDir = await createTempProject();
    const runtime = createRuntime([]);
    const service = new ConversationService({
      config: {} as any,
      workingDir,
      runtimeFactory: vi.fn(async () => runtime),
    });

    const conversation = await service.startConversation();
    await service.sendMessage({
      conversationId: conversation.id,
      message: 'Summarize the review.',
    });
    await service.sendMessage({
      conversationId: conversation.id,
      message: 'Now explain the first issue.',
    });

    expect(runtime.createSession).toHaveBeenCalledTimes(1);
    expect(runtime.sendMessage).toHaveBeenCalledWith('session-123', 'Now explain the first issue.');
  });

  it('closes the underlying runtime session', async () => {
    const workingDir = await createTempProject();
    const runtime = createRuntime([]);
    const service = new ConversationService({
      config: {} as any,
      workingDir,
      runtimeFactory: vi.fn(async () => runtime),
    });

    const conversation = await service.startConversation();
    await service.sendMessage({ conversationId: conversation.id, message: 'Hello' });
    const closed = await service.closeConversation(conversation.id);

    expect(closed.state).toBe('closed');
    expect(runtime.closeSession).toHaveBeenCalledWith('session-123');
    expect(runtime.shutdown).toHaveBeenCalled();
  });
});
