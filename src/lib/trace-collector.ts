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

export class TraceCollector {
  private traces: AgentTrace[] = [];
  private activeTraces = new Map<string, AgentTrace>();
  private activeTurns = new Map<string, ActiveTurn>();
  private activeTurnIndices = new Map<string, number>();
  private activeSubscriptions = new Map<string, () => void>();
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

    this.activeTraces.set(sessionId, trace);
    this.activeTurns.delete(sessionId);
    this.activeTurnIndices.set(sessionId, -1);

    const unsubscribe = session.subscribe((event: PiEvent) => {
      this.handleEvent(sessionId, event);
    });
    this.activeSubscriptions.set(sessionId, unsubscribe);
  }

  private handleEvent(sessionId: string, event: PiEvent): void {
    const trace = this.activeTraces.get(sessionId);
    if (!trace) return;

    switch (event.type) {
      case 'turn_start':
        this.startTurn(sessionId, event);
        break;
      case 'turn_end':
        this.endTurn(sessionId, event);
        break;
      case 'tool_execution_start':
        this.startToolCall(sessionId, event);
        break;
      case 'tool_execution_end':
        this.endToolCall(sessionId, event);
        break;
      case 'message_end':
        this.captureMessage(sessionId, event);
        break;
      case 'agent_end':
        this.completeTrace(sessionId, event);
        break;
      case 'compaction_start':
      case 'compaction_end':
      case 'auto_retry_start':
      case 'auto_retry_end':
        break;
    }
  }

  private startTurn(sessionId: string, event: PiEvent): void {
    const currentIndex = this.activeTurnIndices.get(sessionId) ?? -1;
    const turnIndex = (event.turnIndex as number) ?? currentIndex + 1;
    this.activeTurnIndices.set(sessionId, turnIndex);
    this.activeTurns.set(sessionId, {
      turnIndex,
      startedAt: new Date().toISOString(),
      toolCalls: [],
      activeToolCalls: new Map(),
    });
  }

  private endTurn(sessionId: string, event: PiEvent): void {
    const trace = this.activeTraces.get(sessionId);
    const activeTurn = this.activeTurns.get(sessionId);
    if (!trace || !activeTurn) return;

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
    const durationMs = new Date(completedAt).getTime() - new Date(activeTurn.startedAt).getTime();

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
      turnIndex: activeTurn.turnIndex,
      startedAt: activeTurn.startedAt,
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
      toolCalls: [...activeTurn.toolCalls],
    };

    trace.turns.push(turn);
    trace.toolCallCount += turn.toolCalls.length;
    this.activeTurns.delete(sessionId);
  }

  private startToolCall(sessionId: string, event: PiEvent): void {
    const activeTurn = this.activeTurns.get(sessionId);
    if (!activeTurn) return;
    const toolCallId = event.toolCallId as string;
    const toolName = event.toolName as string;
    const args = event.args;
    const startedAt = new Date().toISOString();

    activeTurn.activeToolCalls.set(toolCallId, {
      toolCallId,
      toolName,
      args,
      startedAt,
    });
  }

  private endToolCall(sessionId: string, event: PiEvent): void {
    const activeTurn = this.activeTurns.get(sessionId);
    if (!activeTurn) return;
    const toolCallId = event.toolCallId as string;
    const active = activeTurn.activeToolCalls.get(toolCallId);
    if (!active) return;

    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt).getTime() - new Date(active.startedAt).getTime();

    const toolCall: TraceToolCall = {
      toolCallId: active.toolCallId,
      toolName: active.toolName,
      args: active.args,
      result: event.result,
      isError: event.isError === true,
      startedAt: active.startedAt,
      completedAt,
      durationMs,
    };

    activeTurn.toolCalls.push(toolCall);
    activeTurn.activeToolCalls.delete(toolCallId);

    const trace = this.activeTraces.get(sessionId);
    if (
      trace &&
      (active.toolName === 'skill' ||
        (active.toolName === 'read' && typeof active.args === 'object' && active.args !== null))
    ) {
      const skillName = this.extractSkillName(active.args, event.result);
      if (skillName && !trace.skillsLoaded.includes(skillName)) {
        trace.skillsLoaded.push(skillName);
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

  private captureMessage(sessionId: string, event: PiEvent): void {
    const trace = this.activeTraces.get(sessionId);
    if (!trace) return;
    const message = event.message as { usage?: TraceUsage } | undefined;
    if (message?.usage && !trace.totalUsage) {
      trace.totalUsage = message.usage;
    }
  }

  private completeTrace(sessionId: string, event: PiEvent): void {
    const trace = this.activeTraces.get(sessionId);
    if (!trace) return;

    const completedAt = new Date().toISOString();
    trace.completedAt = completedAt;
    trace.durationMs = new Date(completedAt).getTime() - new Date(trace.startedAt).getTime();

    if (event.messages && Array.isArray(event.messages)) {
      const lastAssistant = [...event.messages]
        .reverse()
        .find((m: unknown) => (m as { role?: string }).role === 'assistant');
      if (lastAssistant) {
        const usage = (lastAssistant as { usage?: TraceUsage }).usage;
        if (usage) {
          trace.totalUsage = usage;
        }
      }
    }

    trace.errorMessage = event.willRetry ? 'Agent ended with retry pending' : undefined;
  }

  finalizeSession(sessionId: string): AgentTrace | undefined {
    const unsubscribe = this.activeSubscriptions.get(sessionId);
    if (unsubscribe) {
      unsubscribe();
      this.activeSubscriptions.delete(sessionId);
    }

    const trace = this.activeTraces.get(sessionId);
    if (!trace) return undefined;

    if (!trace.completedAt) {
      const now = new Date().toISOString();
      trace.completedAt = now;
      trace.durationMs = new Date(now).getTime() - new Date(trace.startedAt).getTime();
    }
    this.traces.push(trace);
    this.activeTraces.delete(sessionId);
    this.activeTurns.delete(sessionId);
    this.activeTurnIndices.delete(sessionId);
    return trace;
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
    for (const unsubscribe of this.activeSubscriptions.values()) {
      unsubscribe();
    }
    this.traces = [];
    this.activeTraces.clear();
    this.activeTurns.clear();
    this.activeTurnIndices.clear();
    this.activeSubscriptions.clear();
  }
}
