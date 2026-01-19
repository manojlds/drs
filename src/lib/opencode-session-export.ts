import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import type { Session, SessionMessage } from '../opencode/client.js';

function formatAgentSessionFilename(agentName: string): string {
  const sanitized = agentName.replace(/[\\/]/g, '-');
  return `${sanitized}-session.json`;
}

export async function writeSessionDebugOutput(
  workingDir: string,
  agentName: string,
  session: Session,
  messages: SessionMessage[],
  debug?: boolean
): Promise<string | null> {
  if (!debug) {
    return null;
  }

  const outputDir = join(workingDir, '.drs');
  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, formatAgentSessionFilename(agentName));

  const payload = {
    session: {
      id: session.id,
      agent: session.agent,
      createdAt: session.createdAt.toISOString(),
    },
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp.toISOString(),
    })),
  };

  await writeFile(outputPath, JSON.stringify(payload, null, 2));
  return outputPath;
}
