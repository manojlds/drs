import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { Bot, RotateCcw, Send, User } from 'lucide-react';
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
    schema?: { properties?: Record<string, ElicitationPropertySchema>; required?: string[] | null };
    values: Record<string, string | number | boolean | string[]>;
    resolved?: string;
  };
}

export interface AcpChatSuggestion {
  label: string;
  prompt: string;
  disabled?: boolean;
}

interface AcpChatPanelProps {
  mode: 'review' | 'factory';
  workingDir: string | null;
  storagePrefix: string;
  scopeParts: Array<string | null | undefined>;
  title: string;
  kicker: string;
  subtitle: string;
  emptyMessage: string;
  placeholder: string;
  disabledReason?: string | null;
  panelClassName?: string;
  headerClassName?: string;
  messagesClassName?: string;
  suggestions?: AcpChatSuggestion[];
  startPayload?: Record<string, unknown>;
  autoStartPrompt?: string | null;
  autoStart?: boolean;
  onAutoStarted?: () => void;
  onTurnDone?: () => void;
  footerStatus?: ReactNode;
}

export function AcpChatPanel({
  mode,
  workingDir,
  storagePrefix,
  scopeParts,
  title,
  kicker,
  subtitle,
  emptyMessage,
  placeholder,
  disabledReason,
  panelClassName = 'factory-chat-panel',
  headerClassName = 'factory-chat-header',
  messagesClassName = 'review-chat-messages factory-chat-messages',
  suggestions = [],
  startPayload = {},
  autoStartPrompt,
  autoStart,
  onAutoStarted,
  onTurnDone,
  footerStatus,
}: AcpChatPanelProps) {
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
  const skipNextMessagePersistRef = useRef(false);

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
        onTurnDone?.();
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
        ].filter(Boolean).join('\n');
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
            elicitation: { elicitationId: event.elicitationId, mode: event.mode, url: event.url, schema: event.schema, values },
          },
        ]);
      } else if (event.type === 'error') {
        currentAssistantMessageIdRef.current = null;
        setSending(false);
        setMessages((current) => [...current, { id: `error-${Date.now()}`, role: 'error', content: event.message }]);
      }
    });
  }, [onTurnDone]);

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

  const scope = [mode, workingDir ?? '', ...scopeParts, selectedCodingAgentId, thinkingLevel].join(':');

  useEffect(() => {
    conversationScopeRef.current = scope;
    conversationIdRef.current = readStoredConversationId(storagePrefix, scope);
    currentAssistantMessageIdRef.current = null;
    skipNextMessagePersistRef.current = true;
    setSending(false);
    setMessages(readStoredMessages(storagePrefix, scope));
  }, [scope, storagePrefix]);

  useEffect(() => {
    if (skipNextMessagePersistRef.current) {
      skipNextMessagePersistRef.current = false;
      return;
    }
    writeStoredMessages(storagePrefix, scope, messages);
  }, [messages, scope, storagePrefix]);

  const selectedAgent = (globalSettings?.codingAgents ?? []).find((agent) => agent.id === selectedCodingAgentId);
  const supportsThinking = selectedAgent?.kind === 'opencode';
  const noAgentConfigured = globalSettings !== null && (globalSettings.codingAgents ?? []).length === 0;
  const inputDisabled = sending || !workingDir || noAgentConfigured || !!disabledReason;

  const getOrStartConversation = async (): Promise<string> => {
    if (!workingDir) throw new Error('Open a project before starting chat.');
    if (!selectedCodingAgentId) throw new Error('Configure a global ACP coding agent in Settings before using chat.');
    if (conversationIdRef.current && conversationScopeRef.current === scope) return conversationIdRef.current;
    const request = {
      workingDir,
      ...startPayload,
      codingAgentId: selectedCodingAgentId,
      thinkingLevel: thinkingLevel || undefined,
      resumeSessionId: readStoredAgentSessionId(storagePrefix, scope) || undefined,
    };
    const result = mode === 'factory'
      ? await window.drs.startFactoryChat(request)
      : await window.drs.startReviewChat(request);
    conversationIdRef.current = result.conversationId;
    conversationScopeRef.current = scope;
    writeStoredConversationId(storagePrefix, scope, result.conversationId);
    if (result.agentSessionId) writeStoredAgentSessionId(storagePrefix, scope, result.agentSessionId);
    return result.conversationId;
  };

  const resetConversation = async () => {
    const previous = conversationIdRef.current;
    conversationIdRef.current = null;
    currentAssistantMessageIdRef.current = null;
    skipNextMessagePersistRef.current = true;
    clearStoredConversationId(storagePrefix, scope);
    clearStoredAgentSessionId(storagePrefix, scope);
    clearStoredMessages(storagePrefix, scope);
    setMessages([]);
    setSending(false);
    if (previous) {
      try {
        await window.drs.closeReviewChat(previous);
      } catch {
        // Best-effort teardown of the previous backend session.
      }
    }
  };

  const respondPermission = async (permissionId: string, optionId?: string, cancelled = false) => {
    const conversationId = conversationIdRef.current;
    if (!conversationId) return;
    setMessages((current) =>
      current.map((message) =>
        message.permission?.permissionId === permissionId
          ? { ...message, permission: { ...message.permission, resolved: cancelled ? 'Rejected' : `Selected ${optionId}` } }
          : message
      )
    );
    try {
      await window.drs.respondChatPermission({ conversationId, permissionId, optionId, cancelled });
    } catch (error) {
      setMessages((current) => [...current, { id: `error-${Date.now()}`, role: 'error', content: error instanceof Error ? error.message : String(error) }]);
    }
  };

  const updateElicitationValue = (elicitationId: string, key: string, value: string | number | boolean | string[]) => {
    setMessages((current) =>
      current.map((message) =>
        message.elicitation?.elicitationId === elicitationId
          ? { ...message, elicitation: { ...message.elicitation, values: { ...message.elicitation.values, [key]: value } } }
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
          ? { ...message, elicitation: { ...message.elicitation, resolved: action === 'accept' ? 'Answered' : action === 'decline' ? 'Declined' : 'Cancelled' } }
          : message
      )
    );
    try {
      await window.drs.respondChatElicitation({ conversationId, elicitationId, action, content: action === 'accept' ? target.values : undefined });
    } catch (error) {
      setMessages((current) => [...current, { id: `error-${Date.now()}`, role: 'error', content: error instanceof Error ? error.message : String(error) }]);
    }
  };

  const ask = async (text: string) => {
    if (inputDisabled || !text.trim()) return;
    const assistantId = `assistant-${Date.now()}`;
    currentAssistantMessageIdRef.current = assistantId;
    setMessages((current) => [...current, { id: `user-${Date.now()}`, role: 'user', content: text.trim() }, { id: assistantId, role: 'assistant', content: '' }]);
    setPrompt('');
    setSending(true);
    try {
      let conversationId = await getOrStartConversation();
      try {
        await window.drs.sendReviewChatMessage({ conversationId, prompt: text.trim() });
      } catch (error) {
        if (!(error instanceof Error) || !/session not found/i.test(error.message)) throw error;
        clearStoredConversationId(storagePrefix, scope);
        conversationIdRef.current = null;
        conversationId = await getOrStartConversation();
        await window.drs.sendReviewChatMessage({ conversationId, prompt: text.trim() });
      }
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
    if (!autoStart || !autoStartPrompt || sending || globalSettings === null) return;
    onAutoStarted?.();
    void ask(autoStartPrompt);
  }, [autoStart, autoStartPrompt, globalSettings, onAutoStarted, sending]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void ask(prompt);
  };

  const status = disabledReason || (noAgentConfigured ? 'Configure an ACP coding agent in Settings.' : footerStatus);

  return (
    <Card className={panelClassName}>
      <div className={headerClassName}>
        <div>
          <div className="review-kicker">{kicker}</div>
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="factory-chat-reset"
          onClick={() => void resetConversation()}
          disabled={sending || !workingDir}
          title="Discard this session and start a fresh chat"
        >
          <RotateCcw size={13} /> New chat
        </Button>
      </div>
      {suggestions.length > 0 && (
        <div className="review-chat-suggestions">
          {suggestions.map((suggestion) => (
            <Button key={suggestion.label} variant="outline" size="sm" disabled={inputDisabled || suggestion.disabled} onClick={() => void ask(suggestion.prompt)}>
              {suggestion.label}
            </Button>
          ))}
        </div>
      )}
      <div ref={scrollRef} className={messagesClassName}>
        {messages.length === 0 && !sending && <div className="factory-chat-empty">{emptyMessage}</div>}
        {messages.map((message) => (
          <Message key={message.id} from={message.role === 'error' ? 'system' : message.role} className={message.role === 'error' ? 'ai-message-error' : undefined}>
            <MessageAvatar>{message.role === 'user' ? <User size={13} /> : <Bot size={13} />}</MessageAvatar>
            <MessageContent>
              {message.content}
              {message.permission && (
                <div className="factory-chat-permission-actions">
                  {message.permission.risk && <span className={`factory-chat-risk ${message.permission.risk}`}>{message.permission.risk} risk</span>}
                  {message.permission.resolved ? <span>{message.permission.resolved}</span> : (
                    <>
                      {message.permission.options.map((option) => (
                        <Button key={option.optionId} variant={option.kind.startsWith('allow') ? 'default' : 'outline'} size="sm" onClick={() => void respondPermission(message.permission!.permissionId, option.optionId)}>
                          {option.name}
                        </Button>
                      ))}
                      <Button variant="outline" size="sm" onClick={() => void respondPermission(message.permission!.permissionId, undefined, true)}>Cancel</Button>
                    </>
                  )}
                </div>
              )}
              {message.elicitation && (
                <div className="factory-chat-elicitation">
                  {message.elicitation.mode === 'url' && message.elicitation.url && <Button variant="outline" size="sm" onClick={() => void window.drs.openExternal(message.elicitation!.url!)}>Open link</Button>}
                  {Object.entries(message.elicitation.schema?.properties ?? {}).map(([key, property]) => (
                    <ElicitationField key={key} name={key} property={property} value={message.elicitation!.values[key]} disabled={!!message.elicitation!.resolved} onChange={(value) => updateElicitationValue(message.elicitation!.elicitationId, key, value)} />
                  ))}
                  <div className="factory-chat-permission-actions">
                    {message.elicitation.resolved ? <span>{message.elicitation.resolved}</span> : (
                      <>
                        <Button size="sm" onClick={() => void respondElicitation(message.elicitation!.elicitationId, 'accept')}>Submit</Button>
                        <Button variant="outline" size="sm" onClick={() => void respondElicitation(message.elicitation!.elicitationId, 'decline')}>Decline</Button>
                        <Button variant="outline" size="sm" onClick={() => void respondElicitation(message.elicitation!.elicitationId, 'cancel')}>Cancel</Button>
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
          disabled={inputDisabled}
          placeholder={placeholder}
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
              <select value={selectedCodingAgentId} disabled={sending} onChange={(event) => { setSelectedCodingAgentId(event.target.value); setThinkingLevel(''); }}>
                {(globalSettings?.codingAgents ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name || agent.id}</option>)}
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
          <span>{status}</span>
          <Button type="submit" size="sm" disabled={inputDisabled || !prompt.trim()}>
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

function storageKey(prefix: string, scope: string, name: 'conversationId' | 'agentSessionId' | 'messages'): string {
  return `${prefix}.${name}.${scope}`;
}

function readStoredConversationId(prefix: string, scope: string): string | null {
  return window.localStorage.getItem(storageKey(prefix, scope, 'conversationId')) || null;
}

function writeStoredConversationId(prefix: string, scope: string, conversationId: string): void {
  window.localStorage.setItem(storageKey(prefix, scope, 'conversationId'), conversationId);
}

function clearStoredConversationId(prefix: string, scope: string): void {
  window.localStorage.removeItem(storageKey(prefix, scope, 'conversationId'));
}

function clearStoredAgentSessionId(prefix: string, scope: string): void {
  window.localStorage.removeItem(storageKey(prefix, scope, 'agentSessionId'));
}

function clearStoredMessages(prefix: string, scope: string): void {
  window.localStorage.removeItem(storageKey(prefix, scope, 'messages'));
}

function readStoredAgentSessionId(prefix: string, scope: string): string | null {
  return window.localStorage.getItem(storageKey(prefix, scope, 'agentSessionId')) || null;
}

function writeStoredAgentSessionId(prefix: string, scope: string, agentSessionId: string): void {
  window.localStorage.setItem(storageKey(prefix, scope, 'agentSessionId'), agentSessionId);
}

function readStoredMessages(prefix: string, scope: string): ChatMessage[] {
  const source = window.localStorage.getItem(storageKey(prefix, scope, 'messages'));
  if (!source) return [];
  try {
    const parsed = JSON.parse(source) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isChatMessage);
  } catch {
    return [];
  }
}

function writeStoredMessages(prefix: string, scope: string, messages: ChatMessage[]): void {
  window.localStorage.setItem(storageKey(prefix, scope, 'messages'), JSON.stringify(messages.slice(-80)));
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { id?: unknown; role?: unknown; content?: unknown };
  return typeof candidate.id === 'string' && typeof candidate.content === 'string' && (candidate.role === 'user' || candidate.role === 'assistant' || candidate.role === 'system' || candidate.role === 'error');
}

function ElicitationField({ name, property, value, disabled, onChange }: { name: string; property: ElicitationPropertySchema; value: string | number | boolean | string[] | undefined; disabled: boolean; onChange: (value: string | number | boolean | string[]) => void }) {
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
                <input type="checkbox" disabled={disabled} checked={selected} onChange={(event) => {
                  const current = Array.isArray(value) ? value : [];
                  onChange(event.target.checked ? [...current, option.value] : current.filter((item) => item !== option.value));
                }} />
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
