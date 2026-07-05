import { FormEvent, useEffect, useRef, useState } from 'react';
import { Bot, Send, User } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { Card } from '@/renderer/components/ui/card';
import { Message, MessageAvatar, MessageContent } from './ai/message';
import { PromptInput, PromptInputActions, PromptInputTextarea } from './ai/prompt-input';
import type { CodingAgentThinkingLevel, GlobalSettings } from '../../shared/ipc-types';

const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  permission?: {
    permissionId: string;
    options: Array<{ optionId: string; name: string; kind: string }>;
    risk?: 'low' | 'medium' | 'high';
    rawInput?: unknown;
    resolved?: string;
  };
}

interface FactoryChatPanelProps {
  workingDir: string;
  prdId: string | null;
  prdTitle?: string;
  prdPrompt?: string;
  autoStart?: boolean;
  onAutoStarted?: () => void;
}

export function FactoryChatPanel({ workingDir, prdId, prdTitle, prdPrompt, autoStart, onAutoStarted }: FactoryChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => [welcomeMessage]);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [globalSettings, setGlobalSettings] = useState<GlobalSettings | null>(null);
  const [selectedCodingAgentId, setSelectedCodingAgentId] = useState('');
  const [thinkingLevel, setThinkingLevel] = useState<CodingAgentThinkingLevel | ''>('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const conversationIdRef = useRef<string | null>(null);
  const conversationScopeRef = useRef<string | null>(null);
  const currentAssistantMessageIdRef = useRef<string | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, sending]);

  useEffect(() => {
    return window.drs.onReviewChatEvent((event) => {
      if (event.conversationId !== conversationIdRef.current) return;
      if (event.type === 'message_delta') {
        const assistantId = currentAssistantMessageIdRef.current ?? `assistant-${event.messageId}`;
        currentAssistantMessageIdRef.current = assistantId;
        setMessages((current) => {
          if (current.some((message) => message.id === assistantId)) {
            return current.map((message) =>
              message.id === assistantId ? { ...message, content: `${message.content}${event.text}` } : message
            );
          }
          return [...current, { id: assistantId, role: 'assistant', content: event.text }];
        });
      } else if (event.type === 'turn_done') {
        currentAssistantMessageIdRef.current = null;
        setSending(false);
      } else if (event.type === 'tool_call') {
        setMessages((current) => [
          ...current,
          {
            id: `tool-${event.toolCallId}`,
            role: 'system',
            content: `${event.title}${event.status ? ` (${event.status})` : ''}${event.content ? `\n${event.content}` : ''}`,
          },
        ]);
      } else if (event.type === 'tool_call_update') {
        setMessages((current) => [
          ...current,
          {
            id: `tool-update-${event.toolCallId}-${Date.now()}`,
            role: 'system',
            content: `Tool ${event.toolCallId}${event.status ? ` ${event.status}` : ''}${event.content ? `\n${event.content}` : ''}`,
          },
        ]);
      } else if (event.type === 'permission_request') {
        const content = [
          'Permission required',
          event.risk ? `Risk: ${event.risk}` : null,
          event.title ? `Tool: ${event.title}` : null,
          event.kind ? `Kind: ${event.kind}` : null,
          event.content || null,
          event.rawInput ? `Input: ${JSON.stringify(event.rawInput, null, 2)}` : null,
        ]
          .filter(Boolean)
          .join('\n');
        setMessages((current) => [
          ...current,
          {
            id: `permission-${event.permissionId}`,
            role: 'system',
            content,
            permission: { permissionId: event.permissionId, options: event.options, risk: event.risk, rawInput: event.rawInput },
          },
        ]);
      } else if (event.type === 'error') {
        currentAssistantMessageIdRef.current = null;
        setSending(false);
        setMessages((current) => [...current, { id: `error-${Date.now()}`, role: 'system', content: event.message }]);
      }
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadGlobalSettings = async () => {
      try {
        const settings = await window.drs.getGlobalSettings();
        if (cancelled) return;
        setGlobalSettings(settings);
        setSelectedCodingAgentId((current) => current || settings.defaultCodingAgentId || settings.codingAgents[0]?.id || '');
      } catch {
        if (!cancelled) setGlobalSettings({ codingAgents: [] });
      }
    };
    void loadGlobalSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const previousConversationId = conversationIdRef.current;
    if (previousConversationId) void window.drs.closeReviewChat(previousConversationId);
    conversationIdRef.current = null;
    conversationScopeRef.current = null;
    currentAssistantMessageIdRef.current = null;
    setSending(false);
    setMessages([welcomeMessage]);
  }, [workingDir, prdId, selectedCodingAgentId, thinkingLevel]);

  const getOrStartConversation = async (): Promise<string> => {
    const scope = `${workingDir}:${prdId ?? ''}:${selectedCodingAgentId}:${thinkingLevel}`;
    if (conversationIdRef.current && conversationScopeRef.current === scope) return conversationIdRef.current;
    const result = await window.drs.startFactoryChat({
      workingDir,
      prdId: prdId ?? undefined,
      codingAgentId: selectedCodingAgentId || undefined,
      thinkingLevel: thinkingLevel || undefined,
    });
    conversationIdRef.current = result.conversationId;
    conversationScopeRef.current = scope;
    return result.conversationId;
  };

  const respondPermission = async (permissionId: string, optionId?: string, cancelled = false) => {
    const conversationId = conversationIdRef.current;
    if (!conversationId) return;
    setMessages((current) =>
      current.map((message) =>
        message.permission?.permissionId === permissionId
          ? {
              ...message,
              permission: {
                ...message.permission,
                resolved: cancelled ? 'Rejected' : `Selected ${optionId}`,
              },
            }
          : message
      )
    );
    try {
      await window.drs.respondChatPermission({ conversationId, permissionId, optionId, cancelled });
    } catch (error) {
      setMessages((current) => [
        ...current,
        { id: `error-${Date.now()}`, role: 'system', content: error instanceof Error ? error.message : String(error) },
      ]);
    }
  };

  const ask = async (text: string) => {
    if (sending || !text.trim()) return;
    const assistantId = `assistant-${Date.now()}`;
    currentAssistantMessageIdRef.current = assistantId;
    setMessages((current) => [
      ...current,
      { id: `user-${Date.now()}`, role: 'user', content: text.trim() },
      { id: assistantId, role: 'assistant', content: '' },
    ]);
    setPrompt('');
    setSending(true);
    try {
      const conversationId = await getOrStartConversation();
      await window.drs.sendReviewChatMessage({ conversationId, prompt: text.trim() });
    } catch (error) {
      currentAssistantMessageIdRef.current = null;
      setMessages((current) => [
        ...current.filter((message) => message.id !== assistantId || message.content.trim()),
        { id: `error-${Date.now()}`, role: 'system', content: error instanceof Error ? error.message : String(error) },
      ]);
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    if (!autoStart || !prdId || sending) return;
    onAutoStarted?.();
    const autoPrompt = [
      `Let's work on this PRD: ${prdTitle || prdId}.`,
      prdPrompt ? `Original prompt:\n${prdPrompt}` : null,
      'Start by reading the PRD context, identifying the key open questions, and suggesting the next planning steps. Stay in planning mode.',
    ]
      .filter(Boolean)
      .join('\n\n');
    void ask(autoPrompt);
  }, [autoStart, onAutoStarted, prdId, prdPrompt, prdTitle, sending]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void ask(prompt);
  };

  const selectedAgent = (globalSettings?.codingAgents ?? []).find((agent) => agent.id === selectedCodingAgentId);
  const supportsThinking = selectedAgent?.kind === 'opencode';

  return (
    <Card className="factory-chat-panel">
      <div className="factory-chat-header">
        <div>
          <div className="review-kicker">Planning Chat</div>
          <strong>Factory Planner</strong>
          <span>{selectedCodingAgentId ? 'ACP-backed planning agent' : 'Falls back to built-in planner chat'}</span>
        </div>
        <div className="factory-chat-controls">
          <label className="factory-chat-agent-select">
            <span>Agent</span>
            <select
              value={selectedCodingAgentId}
              disabled={sending}
              onChange={(event) => {
                setSelectedCodingAgentId(event.target.value);
                setThinkingLevel('');
              }}
            >
              <option value="">Built-in planner</option>
              {(globalSettings?.codingAgents ?? []).map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name || agent.id}
                </option>
              ))}
            </select>
          </label>
          {supportsThinking && (
            <label className="factory-chat-agent-select">
              <span>Thinking</span>
              <select value={thinkingLevel} disabled={sending} onChange={(event) => setThinkingLevel(event.target.value as CodingAgentThinkingLevel | '')}>
                <option value="">Default{selectedAgent?.thinkingLevel ? ` (${selectedAgent.thinkingLevel})` : ''}</option>
                {THINKING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
              </select>
            </label>
          )}
        </div>
      </div>
      <div className="review-chat-suggestions">
        <Button variant="outline" size="sm" disabled={sending} onClick={() => void ask('Ask the key clarifying questions before this PRD is approved.')}>
          Clarify
        </Button>
        <Button variant="outline" size="sm" disabled={sending || !prdId} onClick={() => void ask('Review this PRD and point out missing scope, risks, and story gaps.')}>
          Review PRD
        </Button>
        <Button variant="outline" size="sm" disabled={sending || !prdId} onClick={() => void ask('Suggest an independently reviewable story breakdown with dependencies and acceptance criteria.')}>
          Slice Stories
        </Button>
      </div>
      <div ref={scrollRef} className="review-chat-messages factory-chat-messages">
        {messages.map((message) => (
          <Message key={message.id} from={message.role}>
            <MessageAvatar>{message.role === 'user' ? <User size={13} /> : <Bot size={13} />}</MessageAvatar>
            <MessageContent>
              {message.content}
              {message.permission && (
                <div className="factory-chat-permission-actions">
                  {message.permission.risk && <span className={`factory-chat-risk ${message.permission.risk}`}>{message.permission.risk} risk</span>}
                  {message.permission.resolved ? (
                    <span>{message.permission.resolved}</span>
                  ) : (
                    <>
                      {message.permission.options.map((option) => (
                        <Button
                          key={option.optionId}
                          variant={option.kind.startsWith('allow') ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => void respondPermission(message.permission!.permissionId, option.optionId)}
                        >
                          {option.name}
                        </Button>
                      ))}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void respondPermission(message.permission!.permissionId, undefined, true)}
                      >
                        Cancel
                      </Button>
                    </>
                  )}
                </div>
              )}
            </MessageContent>
          </Message>
        ))}
      </div>
      <PromptInput onSubmit={handleSubmit}>
        <PromptInputTextarea
          value={prompt}
          disabled={sending}
          placeholder="Plan, clarify, critique, or slice the selected PRD..."
          rows={3}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void ask(prompt);
            }
          }}
        />
        <PromptInputActions>
          <Button type="submit" size="sm" disabled={sending || !prompt.trim()}>
            <Send size={13} /> Send
          </Button>
        </PromptInputActions>
      </PromptInput>
    </Card>
  );
}

const welcomeMessage: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  content: 'Use me to clarify requirements, critique PRDs, and shape approved stories. I stay in planning mode and will not implement.',
};
