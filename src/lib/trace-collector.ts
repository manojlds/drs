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
  private currentTrace: AgentTrace | null = null;
  private currentTurn: ActiveTurn | null = null;
  private currentTurnIndex = -1;
  private unsubscribe: (() => void) | null = null;
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
    this.currentTrace = {
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

    this.currentTurn = null;
    this.currentTurnIndex = -1;

    this.unsubscribe = session.subscribe((event: PiEvent) => {
      this.handleEvent(event);
    });
  }

  private handleEvent(event: PiEvent): void {
    if (!this.currentTrace) return;

    switch (event.type) {
      case 'turn_start':
        this.startTurn(event);
        break;
      case 'turn_end':
        this.endTurn(event);
        break;
      case 'tool_execution_start':
        this.startToolCall(event);
        break;
      case 'tool_execution_end':
        this.endToolCall(event);
        break;
      case 'message_end':
        this.captureMessage(event);
        break;
      case 'agent_end':
        this.completeTrace(event);
        break;
      case 'compaction_start':
      case 'compaction_end':
      case 'auto_retry_start':
      case 'auto_retry_end':
        break;
    }
  }

  private startTurn(event: PiEvent): void {
    const turnIndex = (event.turnIndex as number) ?? ++this.currentTurnIndex;
    this.currentTurnIndex = turnIndex;
    this.currentTurn = {
      turnIndex,
      startedAt: new Date().toISOString(),
      toolCalls: [],
      activeToolCalls: new Map(),
    };
  }

  private endTurn(event: PiEvent): void {
    if (!this.currentTrace || !this.currentTurn) return;

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
      new Date(completedAt).getTime() - new Date(this.currentTurn.startedAt).getTime();

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
      turnIndex: this.currentTurn.turnIndex,
      startedAt: this.currentTurn.startedAt,
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
      toolCalls: [...this.currentTurn.toolCalls],
    };

    this.currentTrace.turns.push(turn);
    this.currentTrace.toolCallCount += turn.toolCalls.length;
    this.currentTurn = null;
  }

  private startToolCall(event: PiEvent): void {
    if (!this.currentTurn) return;
    const toolCallId = event.toolCallId as string;
    const toolName = event.toolName as string;
    const args = event.args;
    const startedAt = new Date().toISOString();

    this.currentTurn.activeToolCalls.set(toolCallId, {
      toolCallId,
      toolName,
      args,
      startedAt,
    });
  }

  private endToolCall(event: PiEvent): void {
    if (!this.currentTurn) return;
    const toolCallId = event.toolCallId as string;
    const active = this.currentTurn.activeToolCalls.get(toolCallId);
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

    this.currentTurn.toolCalls.push(toolCall);
    this.currentTurn.activeToolCalls.delete(toolCallId);

    if (
      active.toolName === 'skill' ||
      (active.toolName === 'read' && typeof active.args === 'object' && active.args !== null)
    ) {
      const skillName = this.extractSkillName(active.args, event.result);
      if (skillName && this.currentTrace && !this.currentTrace.skillsLoaded.includes(skillName)) {
        this.currentTrace.skillsLoaded.push(skillName);
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

  private captureMessage(event: PiEvent): void {
    if (!this.currentTrace) return;
    const message = event.message as { usage?: TraceUsage } | undefined;
    if (message?.usage && !this.currentTrace.totalUsage) {
      this.currentTrace.totalUsage = message.usage;
    }
  }

  private completeTrace(event: PiEvent): void {
    if (!this.currentTrace) return;

    const completedAt = new Date().toISOString();
    this.currentTrace.completedAt = completedAt;
    this.currentTrace.durationMs =
      new Date(completedAt).getTime() - new Date(this.currentTrace.startedAt).getTime();

    if (event.messages && Array.isArray(event.messages)) {
      const lastAssistant = [...event.messages]
        .reverse()
        .find((m: unknown) => (m as { role?: string }).role === 'assistant');
      if (lastAssistant) {
        const usage = (lastAssistant as { usage?: TraceUsage }).usage;
        if (usage) {
          this.currentTrace.totalUsage = usage;
        }
      }
    }

    this.currentTrace.errorMessage = event.willRetry ? 'Agent ended with retry pending' : undefined;
  }

  finalizeCurrentTrace(): AgentTrace | undefined {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    if (this.currentTrace) {
      if (!this.currentTrace.completedAt) {
        const now = new Date().toISOString();
        this.currentTrace.completedAt = now;
        this.currentTrace.durationMs =
          new Date(now).getTime() - new Date(this.currentTrace.startedAt).getTime();
      }
      this.traces.push(this.currentTrace);
      const trace = this.currentTrace;
      this.currentTrace = null;
      this.currentTurn = null;
      return trace;
    }
    return undefined;
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
    this.currentTrace = null;
    this.currentTurn = null;
    this.unsubscribe = null;
  }
}
