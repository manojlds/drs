import { FormEvent, useEffect, useRef, useState } from 'react';
import { Bot, Send, User } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { Card } from '@/renderer/components/ui/card';
import { Message, MessageAvatar, MessageContent } from './ai/message';
import { PromptInput, PromptInputActions, PromptInputTextarea } from './ai/prompt-input';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface FactoryChatPanelProps {
  workingDir: string;
  prdId: string | null;
}

export function FactoryChatPanel({ workingDir, prdId }: FactoryChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => [welcomeMessage]);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
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
      } else if (event.type === 'error') {
        currentAssistantMessageIdRef.current = null;
        setSending(false);
        setMessages((current) => [...current, { id: `error-${Date.now()}`, role: 'system', content: event.message }]);
      }
    });
  }, []);

  useEffect(() => {
    const previousConversationId = conversationIdRef.current;
    if (previousConversationId) void window.drs.closeReviewChat(previousConversationId);
    conversationIdRef.current = null;
    conversationScopeRef.current = null;
    currentAssistantMessageIdRef.current = null;
    setSending(false);
    setMessages([welcomeMessage]);
  }, [workingDir, prdId]);

  const getOrStartConversation = async (): Promise<string> => {
    const scope = `${workingDir}:${prdId ?? ''}`;
    if (conversationIdRef.current && conversationScopeRef.current === scope) return conversationIdRef.current;
    const result = await window.drs.startFactoryChat({ workingDir, prdId: prdId ?? undefined });
    conversationIdRef.current = result.conversationId;
    conversationScopeRef.current = scope;
    return result.conversationId;
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

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void ask(prompt);
  };

  return (
    <Card className="factory-chat-panel">
      <div className="factory-chat-header">
        <div>
          <div className="review-kicker">Planning Chat</div>
          <strong>Factory Planner</strong>
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
            <MessageContent>{message.content}</MessageContent>
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
