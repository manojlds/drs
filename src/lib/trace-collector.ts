import { randomUUID } from 'crypto';

export interface TraceUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface TraceToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: unknown;
  isError: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface TraceTurn {
  turnIndex: number;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  model?: string;
  provider?: string;
  responseModel?: string;
  responseId?: string;
  stopReason?: string;
  usage?: TraceUsage;
  assistantContent?: string;
  thinkingContent?: string;
  toolCalls: TraceToolCall[];
}

export interface AgentTrace {
  id: string;
  nodeId: string;
  agentId: string;
  sessionId: string;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  provider?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  turns: TraceTurn[];
  skillsLoaded: string[];
  totalUsage?: TraceUsage;
  toolCallCount: number;
  errorMessage?: string;
  workflowIteration?: number;
}

export interface WorkflowTrace {
  id: string;
  workflowName: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  inputs: Record<string, string>;
  agentTraces: AgentTrace[];
}

type PiEvent = {
  type: string;
  [key: string]: unknown;
};

interface ActiveToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
  startedAt: string;
}

interface ActiveTurn {
  turnIndex: number;
  startedAt: string;
  toolCalls: TraceToolCall[];
  activeToolCalls: Map<string, ActiveToolCall>;
}

interface ActiveSession {
  trace: AgentTrace;
  currentTurn: ActiveTurn | null;
  currentTurnIndex: number;
  unsubscribe: (() => void) | null;
}

export class TraceCollector {
  private traces: AgentTrace[] = [];
  private activeSessions = new Map<string, ActiveSession>();
  private promptText = '';
  private nodeId = '';
  private agentId = '';
  private workflowIteration: number | undefined;

  setContext(nodeId: string, agentId: string, prompt: string, iteration?: number): void {
    this.nodeId = nodeId;
    this.agentId = agentId;
    this.promptText = prompt;
    this.workflowIteration = iteration;
  }

  attachSession(
    session: {
      subscribe: (listener: (event: PiEvent) => void) => () => void;
      messages?: unknown[];
      systemPrompt?: string;
      model?: { provider?: string; modelId?: string };
    },
    sessionId: string
  ): void {
    const trace: AgentTrace = {
      id: randomUUID(),
      nodeId: this.nodeId,
      agentId: this.agentId,
      sessionId,
      prompt: this.promptText,
      systemPrompt: typeof session.systemPrompt === 'string' ? session.systemPrompt : undefined,
      model: session.model?.modelId,
      provider: session.model?.provider,
      startedAt: new Date().toISOString(),
      turns: [],
      skillsLoaded: [],
      toolCallCount: 0,
      workflowIteration: this.workflowIteration,
    };

    const active: ActiveSession = {
      trace,
      currentTurn: null,
      currentTurnIndex: -1,
      unsubscribe: null,
    };

    active.unsubscribe = session.subscribe((event: PiEvent) => {
      this.handleEvent(sessionId, event);
    });

    this.activeSessions.set(sessionId, active);
  }

  private handleEvent(sessionId: string, event: PiEvent): void {
    const active = this.activeSessions.get(sessionId);
    if (!active) return;

    switch (event.type) {
      case 'turn_start':
        this.startTurn(sessionId, active, event);
        break;
      case 'turn_end':
        this.endTurn(sessionId, active, event);
        break;
      case 'tool_execution_start':
        this.startToolCall(active, event);
        break;
      case 'tool_execution_end':
        this.endToolCall(active, event);
        break;
      case 'message_end':
        this.captureMessage(active, event);
        break;
      case 'agent_end':
        this.completeTrace(active, event);
        break;
      case 'compaction_start':
      case 'compaction_end':
      case 'auto_retry_start':
      case 'auto_retry_end':
        break;
    }
  }

  private startTurn(_sessionId: string, active: ActiveSession, event: PiEvent): void {
    const turnIndex = (event.turnIndex as number) ?? ++active.currentTurnIndex;
    active.currentTurnIndex = turnIndex;
    active.currentTurn = {
      turnIndex,
      startedAt: new Date().toISOString(),
      toolCalls: [],
      activeToolCalls: new Map(),
    };
  }

  private endTurn(_sessionId: string, active: ActiveSession, event: PiEvent): void {
    if (!active.currentTurn) return;

    const message = event.message as
      | {
          role?: string;
          content?: Array<{ type: string; text?: string; thinking?: string }>;
          usage?: TraceUsage;
          model?: string;
          provider?: string;
          responseModel?: string;
          responseId?: string;
          stopReason?: string;
        }
      | undefined;

    const completedAt = new Date().toISOString();
    const durationMs =
      new Date(completedAt).getTime() - new Date(active.currentTurn.startedAt).getTime();

    let assistantContent = '';
    let thinkingContent = '';

    if (message?.content && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text' && part.text) {
          assistantContent += part.text;
        } else if (part.type === 'thinking' && part.thinking) {
          thinkingContent += part.thinking;
        }
      }
    }

    const turn: TraceTurn = {
      turnIndex: active.currentTurn.turnIndex,
      startedAt: active.currentTurn.startedAt,
      completedAt,
      durationMs,
      model: message?.model,
      provider: message?.provider,
      responseModel: message?.responseModel,
      responseId: message?.responseId,
      stopReason: message?.stopReason,
      usage: message?.usage,
      assistantContent: assistantContent || undefined,
      thinkingContent: thinkingContent || undefined,
      toolCalls: [...active.currentTurn.toolCalls],
    };

    active.trace.turns.push(turn);
    active.trace.toolCallCount += turn.toolCalls.length;
    active.currentTurn = null;
  }

  private startToolCall(active: ActiveSession, event: PiEvent): void {
    if (!active.currentTurn) return;
    const toolCallId = event.toolCallId as string;
    const toolName = event.toolName as string;
    const args = event.args;
    const startedAt = new Date().toISOString();

    active.currentTurn.activeToolCalls.set(toolCallId, {
      toolCallId,
      toolName,
      args,
      startedAt,
    });
  }

  private endToolCall(active: ActiveSession, event: PiEvent): void {
    if (!active.currentTurn) return;
    const toolCallId = event.toolCallId as string;
    const activeTool = active.currentTurn.activeToolCalls.get(toolCallId);
    if (!activeTool) return;

    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt).getTime() - new Date(activeTool.startedAt).getTime();

    const toolCall: TraceToolCall = {
      toolCallId: activeTool.toolCallId,
      toolName: activeTool.toolName,
      args: activeTool.args,
      result: event.result,
      isError: event.isError === true,
      startedAt: activeTool.startedAt,
      completedAt,
      durationMs,
    };

    active.currentTurn.toolCalls.push(toolCall);
    active.currentTurn.activeToolCalls.delete(toolCallId);

    if (
      activeTool.toolName === 'skill' ||
      (activeTool.toolName === 'read' &&
        typeof activeTool.args === 'object' &&
        activeTool.args !== null)
    ) {
      const skillName = this.extractSkillName(activeTool.args, event.result);
      if (skillName && !active.trace.skillsLoaded.includes(skillName)) {
        active.trace.skillsLoaded.push(skillName);
      }
    }
  }

  private extractSkillName(args: unknown, result: unknown): string | undefined {
    if (typeof args === 'object' && args !== null) {
      const argObj = args as { skill?: string; name?: string };
      if (argObj.skill) return argObj.skill;
      if (argObj.name) return argObj.name;
    }
    if (typeof result === 'string') {
      const match = result.match(/\/skills\/([^/]+)\/SKILL\.md/i);
      if (match) return match[1];
    }
    return undefined;
  }

  private captureMessage(active: ActiveSession, event: PiEvent): void {
    const message = event.message as { usage?: TraceUsage } | undefined;
    if (message?.usage && !active.trace.totalUsage) {
      active.trace.totalUsage = message.usage;
    }
  }

  private completeTrace(active: ActiveSession, event: PiEvent): void {
    const completedAt = new Date().toISOString();
    active.trace.completedAt = completedAt;
    active.trace.durationMs =
      new Date(completedAt).getTime() - new Date(active.trace.startedAt).getTime();

    if (event.messages && Array.isArray(event.messages)) {
      const lastAssistant = [...event.messages]
        .reverse()
        .find((m: unknown) => (m as { role?: string }).role === 'assistant');
      if (lastAssistant) {
        const usage = (lastAssistant as { usage?: TraceUsage }).usage;
        if (usage) {
          active.trace.totalUsage = usage;
        }
      }
    }

    active.trace.errorMessage = event.willRetry ? 'Agent ended with retry pending' : undefined;
  }

  finalizeSession(sessionId: string): AgentTrace | undefined {
    const active = this.activeSessions.get(sessionId);
    if (!active) return undefined;

    if (active.unsubscribe) {
      active.unsubscribe();
      active.unsubscribe = null;
    }
    if (!active.trace.completedAt) {
      const now = new Date().toISOString();
      active.trace.completedAt = now;
      active.trace.durationMs =
        new Date(now).getTime() - new Date(active.trace.startedAt).getTime();
    }
    this.traces.push(active.trace);
    this.activeSessions.delete(sessionId);

    return active.trace;
  }

  finalizeCurrentTrace(): AgentTrace | undefined {
    const sessionIds = Array.from(this.activeSessions.keys());
    let lastTrace: AgentTrace | undefined;
    for (const sessionId of sessionIds) {
      const trace = this.finalizeSession(sessionId);
      if (trace) {
        lastTrace = trace;
      }
    }
    return lastTrace;
  }

  getTraces(): AgentTrace[] {
    return [...this.traces];
  }

  buildWorkflowTrace(
    workflowName: string,
    inputs: Record<string, string>,
    startedAt: string
  ): WorkflowTrace {
    return {
      id: randomUUID(),
      workflowName,
      startedAt,
      completedAt: new Date().toISOString(),
      inputs,
      agentTraces: [...this.traces],
    };
  }

  clear(): void {
    this.traces = [];
    for (const active of this.activeSessions.values()) {
      if (active.unsubscribe) {
        active.unsubscribe();
      }
    }
    this.activeSessions.clear();
  }
}
