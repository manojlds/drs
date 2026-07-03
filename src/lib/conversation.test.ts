import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationService, type ConversationRuntime } from './conversation.js';
import type { SessionMessage } from '../runtime/client.js';
import type { ReviewArtifactPayload } from './review-artifact.js';
import type { WorkflowArtifactEnvelope } from './workflow-artifacts.js';

const tempDirs: string[] = [];

async function createTempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'drs-conversation-'));
  tempDirs.push(dir);
  await mkdir(join(dir, '.drs'), { recursive: true });
  return dir;
}

function createRuntime(messages: SessionMessage[] | SessionMessage[][] = []): ConversationRuntime {
  let streamIndex = 0;
  return {
    createSession: vi.fn(async () => ({
      id: 'session-123',
      agent: 'task/review-assistant',
      createdAt: new Date(),
    })),
    sendMessage: vi.fn(async () => {}),
    streamMessages: vi.fn(async function* () {
      const streamMessages = Array.isArray(messages[0])
        ? ((messages as SessionMessage[][])[streamIndex] ?? [])
        : (messages as SessionMessage[]);
      streamIndex += 1;
      for (const message of streamMessages) {
        yield message;
      }
    }),
    closeSession: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
}

function createReviewArtifact(reviewedAt: string): WorkflowArtifactEnvelope<ReviewArtifactPayload> {
  return {
    schemaVersion: 1,
    kind: 'review',
    id: 'art_1',
    createdAt: reviewedAt,
    updatedAt: reviewedAt,
    scope: { platform: 'local', projectId: 'project', subject: 'default' },
    payload: {
      schemaVersion: 1,
      reviewId: 'rev_1',
      reviewedAt,
      summary: {
        filesReviewed: 1,
        issuesFound: 1,
        bySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
        byCategory: { SECURITY: 0, QUALITY: 1, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
      },
      findings: [
        {
          id: 'F001',
          fingerprint: 'fp',
          state: 'open',
          disposition: 'confirmed',
          source: 'agent',
          createdAt: reviewedAt,
          updatedAt: reviewedAt,
          issue: {
            category: 'QUALITY',
            severity: 'HIGH',
            title: 'Canonical bug',
            file: 'src/app.ts',
            line: 12,
            problem: 'Problem',
            solution: 'Solution',
            agent: 'quality',
          },
        },
      ],
    },
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

  it('prefers canonical review artifacts over legacy review output', async () => {
    const workingDir = await createTempProject();
    const artifactDir = join(workingDir, '.drs/artifacts/local/project/default/review');
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      join(artifactDir, 'latest.json'),
      JSON.stringify(createReviewArtifact('2026-01-01T00:00:00.000Z'))
    );
    await writeFile(
      join(workingDir, '.drs/review-output.json'),
      JSON.stringify({ summary: { issuesFound: 1 }, issues: [{ title: 'Legacy bug' }] })
    );

    const runtime = createRuntime([]);
    const service = new ConversationService({
      config: {} as any,
      workingDir,
      runtimeFactory: vi.fn(async () => runtime),
    });

    const conversation = await service.startConversation();
    await service.sendMessage({
      conversationId: conversation.id,
      message: 'What did the review find?',
    });

    expect(runtime.createSession).toHaveBeenCalledWith({
      agent: 'task/review-assistant',
      message: expect.stringContaining('Canonical bug'),
    });
    expect(runtime.createSession).toHaveBeenCalledWith({
      agent: 'task/review-assistant',
      message: expect.stringContaining('.drs/artifacts/local/project/default/review/latest.json'),
    });
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

  it('streams new messages without replaying prior runtime messages', async () => {
    const workingDir = await createTempProject();
    const runtime = createRuntime([
      [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'First answer.',
          timestamp: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
      [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'First answer.',
          timestamp: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          id: 'assistant-2',
          role: 'assistant',
          content: 'Second answer.',
          timestamp: new Date('2026-01-01T00:00:01.000Z'),
        },
      ],
    ]);
    const service = new ConversationService({
      config: {} as any,
      workingDir,
      runtimeFactory: vi.fn(async () => runtime),
    });

    const conversation = await service.startConversation();
    const firstEvents = [];
    for await (const event of service.streamMessage({
      conversationId: conversation.id,
      message: 'First?',
    })) {
      firstEvents.push(event);
    }
    const secondEvents = [];
    for await (const event of service.streamMessage({
      conversationId: conversation.id,
      message: 'Second?',
    })) {
      secondEvents.push(event);
    }

    expect(firstEvents.map((event) => event.type)).toEqual([
      'user_message',
      'message',
      'response_delta',
      'turn_done',
    ]);
    expect(
      secondEvents.filter((event) => event.type === 'response_delta').map((event) => event.text)
    ).toEqual(['Second answer.']);
    expect(
      service.getConversation(conversation.id).messages.map((message) => message.content)
    ).toEqual(['First?', 'First answer.', 'Second?', 'Second answer.']);
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
