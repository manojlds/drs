import { FormEvent, useEffect, useRef, useState } from 'react';
import { Bot, Send, User } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { Card } from '@/renderer/components/ui/card';
import { Message, MessageAvatar, MessageContent } from './ai/message';
import { PromptInput, PromptInputActions, PromptInputTextarea } from './ai/prompt-input';
import type { CodingAgentThinkingLevel, ElicitationPropertySchema, GlobalSettings } from '../../shared/ipc-types';

const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'error';
  content: string;
  permission?: {
    permissionId: string;
    options: Array<{ optionId: string; name: string; kind: string }>;
    risk?: 'low' | 'medium' | 'high';
    rawInput?: unknown;
    resolved?: string;
  };
  elicitation?: {
    elicitationId: string;
    mode: 'form' | 'url';
    url?: string;
    schema?: {
      properties?: Record<string, ElicitationPropertySchema>;
      required?: string[] | null;
    };
    values: Record<string, string | number | boolean | string[]>;
    resolved?: string;
  };
}

interface FactoryChatPanelProps {
  workingDir: string;
  prdId: string | null;
  prdTitle?: string;
  prdDescription?: string;
  autoStart?: boolean;
  onAutoStarted?: () => void;
}

export function FactoryChatPanel({ workingDir, prdId, prdTitle, prdDescription, autoStart, onAutoStarted }: FactoryChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
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
      } else if (event.type === 'elicitation_request') {
        const values = Object.fromEntries(
          Object.entries(event.schema?.properties ?? {}).map(([key, property]) => [key, defaultElicitationValue(property)])
        ) as Record<string, string | number | boolean | string[]>;
        setMessages((current) => [
          ...current,
          {
            id: `elicitation-${event.elicitationId}`,
            role: 'system',
            content: event.message,
            elicitation: {
              elicitationId: event.elicitationId,
              mode: event.mode,
              url: event.url,
              schema: event.schema,
              values,
            },
          },
        ]);
      } else if (event.type === 'error') {
        currentAssistantMessageIdRef.current = null;
        setSending(false);
        setMessages((current) => [...current, { id: `error-${Date.now()}`, role: 'error', content: event.message }]);
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
    setMessages([]);
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
        { id: `error-${Date.now()}`, role: 'error', content: error instanceof Error ? error.message : String(error) },
      ]);
    }
  };

  const updateElicitationValue = (elicitationId: string, key: string, value: string | number | boolean | string[]) => {
    setMessages((current) =>
      current.map((message) =>
        message.elicitation?.elicitationId === elicitationId
          ? {
              ...message,
              elicitation: {
                ...message.elicitation,
                values: { ...message.elicitation.values, [key]: value },
              },
            }
          : message
      )
    );
  };

  const respondElicitation = async (elicitationId: string, action: 'accept' | 'decline' | 'cancel') => {
    const conversationId = conversationIdRef.current;
    const target = messages.find((message) => message.elicitation?.elicitationId === elicitationId)?.elicitation;
    if (!conversationId || !target) return;
    setMessages((current) =>
      current.map((message) =>
        message.elicitation?.elicitationId === elicitationId
          ? {
              ...message,
              elicitation: {
                ...message.elicitation,
                resolved: action === 'accept' ? 'Answered' : action === 'decline' ? 'Declined' : 'Cancelled',
              },
            }
          : message
      )
    );
    try {
      await window.drs.respondChatElicitation({
        conversationId,
        elicitationId,
        action,
        content: action === 'accept' ? target.values : undefined,
      });
    } catch (error) {
      setMessages((current) => [
        ...current,
        { id: `error-${Date.now()}`, role: 'error', content: error instanceof Error ? error.message : String(error) },
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
        { id: `error-${Date.now()}`, role: 'error', content: error instanceof Error ? error.message : String(error) },
      ]);
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    if (!autoStart || !prdId || sending || globalSettings === null) return;
    onAutoStarted?.();
    const autoPrompt = [
      'Load and execute the drs-factory-planning skill now.',
      `PRD id: ${prdId}`,
      `PRD title: ${prdTitle || prdId}`,
      prdDescription ? `PRD description:\n${prdDescription}` : null,
    ]
      .filter(Boolean)
      .join('\n\n');
    void ask(autoPrompt);
  }, [autoStart, globalSettings, onAutoStarted, prdDescription, prdId, prdTitle, sending]);

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
      </div>
      <div ref={scrollRef} className="review-chat-messages factory-chat-messages">
        {messages.length === 0 && !sending && (
          <div className="factory-chat-empty">
            Start by describing what is unclear, or create a PRD to let the planning agent interview you.
          </div>
        )}
        {messages.map((message) => (
          <Message key={message.id} from={message.role === 'error' ? 'system' : message.role} className={message.role === 'error' ? 'ai-message-error' : undefined}>
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
              {message.elicitation && (
                <div className="factory-chat-elicitation">
                  {message.elicitation.mode === 'url' && message.elicitation.url && (
                    <Button variant="outline" size="sm" onClick={() => void window.drs.openExternal(message.elicitation!.url!)}>
                      Open link
                    </Button>
                  )}
                  {Object.entries(message.elicitation.schema?.properties ?? {}).map(([key, property]) => (
                    <ElicitationField
                      key={key}
                      name={key}
                      property={property}
                      value={message.elicitation!.values[key]}
                      disabled={!!message.elicitation!.resolved}
                      onChange={(value) => updateElicitationValue(message.elicitation!.elicitationId, key, value)}
                    />
                  ))}
                  <div className="factory-chat-permission-actions">
                    {message.elicitation.resolved ? (
                      <span>{message.elicitation.resolved}</span>
                    ) : (
                      <>
                        <Button size="sm" onClick={() => void respondElicitation(message.elicitation!.elicitationId, 'accept')}>
                          Submit
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => void respondElicitation(message.elicitation!.elicitationId, 'decline')}>
                          Decline
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => void respondElicitation(message.elicitation!.elicitationId, 'cancel')}>
                          Cancel
                        </Button>
                      </>
                    )}
                  </div>
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
          <div className="factory-chat-input-controls">
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
                <option value="">Built-in</option>
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
          <Button type="submit" size="sm" disabled={sending || !prompt.trim()}>
            <Send size={13} /> Send
          </Button>
        </PromptInputActions>
      </PromptInput>
    </Card>
  );
}

function defaultElicitationValue(property: ElicitationPropertySchema): string | number | boolean | string[] {
  if (property.default !== undefined && property.default !== null) return property.default;
  if (property.type === 'boolean') return false;
  if (property.type === 'number' || property.type === 'integer') return 0;
  if (property.type === 'array') return [];
  return property.oneOf?.[0]?.const ?? property.enum?.[0] ?? '';
}

function ElicitationField({
  name,
  property,
  value,
  disabled,
  onChange,
}: {
  name: string;
  property: ElicitationPropertySchema;
  value: string | number | boolean | string[] | undefined;
  disabled: boolean;
  onChange: (value: string | number | boolean | string[]) => void;
}) {
  const label = property.title || name;
  const singleOptions = property.oneOf?.map((option) => ({ value: option.const, label: option.title })) ?? property.enum?.map((option) => ({ value: option, label: option })) ?? [];
  const multiOptions = property.items?.anyOf?.map((option) => ({ value: option.const, label: option.title })) ?? property.items?.enum?.map((option) => ({ value: option, label: option })) ?? [];

  return (
    <label className="factory-chat-elicitation-field">
      <span>{label}</span>
      {property.description && <small>{property.description}</small>}
      {property.type === 'boolean' ? (
        <input type="checkbox" disabled={disabled} checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
      ) : property.type === 'number' || property.type === 'integer' ? (
        <input type="number" disabled={disabled} value={Number(value ?? 0)} onChange={(event) => onChange(Number(event.target.value))} />
      ) : property.type === 'array' ? (
        <div className="factory-chat-elicitation-options">
          {multiOptions.map((option) => {
            const selected = Array.isArray(value) && value.includes(option.value);
            return (
              <label key={option.value}>
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={selected}
                  onChange={(event) => {
                    const current = Array.isArray(value) ? value : [];
                    onChange(event.target.checked ? [...current, option.value] : current.filter((item) => item !== option.value));
                  }}
                />
                <span>{option.label}</span>
              </label>
            );
          })}
        </div>
      ) : singleOptions.length > 0 ? (
        <select disabled={disabled} value={String(value ?? '')} onChange={(event) => onChange(event.target.value)}>
          {singleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      ) : (
        <textarea disabled={disabled} value={String(value ?? '')} onChange={(event) => onChange(event.target.value)} />
      )}
    </label>
  );
}
