import { FormEvent, useEffect, useRef, useState } from 'react';
import { Bot, Send, Sparkles, User } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/renderer/components/ui/card';
import { Message, MessageAvatar, MessageContent } from './ai/message';
import { PromptInput, PromptInputActions, PromptInputTextarea } from './ai/prompt-input';
import type { ReviewIssue, ReviewJsonOutput } from '../types';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ReviewChatPanelProps {
  workingDir: string | null;
  review: ReviewJsonOutput | null;
  selectedIssue: ReviewIssue | null;
}

export function ReviewChatPanel({ workingDir, review, selectedIssue }: ReviewChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: 'welcome',
      role: 'assistant',
      content:
        'Ask about the latest DRS review output. I can explain findings, clarify severity, and suggest the smallest safe fix scope.',
    },
  ]);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const conversationIdRef = useRef<string | null>(null);
  const conversationWorkingDirRef = useRef<string | null>(null);
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
        setMessages((cur) => {
          if (cur.some((message) => message.id === assistantId)) {
            return cur.map((message) =>
              message.id === assistantId
                ? { ...message, content: `${message.content}${event.text}` }
                : message,
            );
          }
          return [...cur, { id: assistantId, role: 'assistant', content: event.text }];
        });
      } else if (event.type === 'turn_done') {
        currentAssistantMessageIdRef.current = null;
        setSending(false);
      } else if (event.type === 'error') {
        currentAssistantMessageIdRef.current = null;
        setSending(false);
        setMessages((cur) => [
          ...cur,
          {
            id: `error-${Date.now()}`,
            role: 'system',
            content: event.message,
          },
        ]);
      }
    });
  }, []);

  useEffect(() => {
    const previousConversationId = conversationIdRef.current;
    if (previousConversationId) {
      void window.drs.closeReviewChat(previousConversationId);
    }
    conversationIdRef.current = null;
    conversationWorkingDirRef.current = null;
    currentAssistantMessageIdRef.current = null;
    setSending(false);
    setMessages([
      {
        id: 'welcome',
        role: 'assistant',
        content:
          'Ask about the latest DRS review output. I can explain findings, clarify severity, and suggest the smallest safe fix scope.',
      },
    ]);
  }, [workingDir]);

  const getOrStartConversation = async (): Promise<string> => {
    if (!workingDir) {
      throw new Error('Open a project before starting review chat.');
    }
    if (
      conversationIdRef.current &&
      conversationWorkingDirRef.current &&
      conversationWorkingDirRef.current === workingDir
    ) {
      return conversationIdRef.current;
    }
    const result = await window.drs.startReviewChat({ workingDir });
    conversationIdRef.current = result.conversationId;
    conversationWorkingDirRef.current = workingDir;
    return result.conversationId;
  };

  const ask = async (text: string) => {
    if (!workingDir || sending || !text.trim()) return;
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text.trim(),
    };
    const assistantId = `assistant-${Date.now()}`;
    currentAssistantMessageIdRef.current = assistantId;
    setMessages((cur) => [...cur, userMessage, { id: assistantId, role: 'assistant', content: '' }]);
    setPrompt('');
    setSending(true);
    try {
      const conversationId = await getOrStartConversation();
      await window.drs.sendReviewChatMessage({ conversationId, prompt: text.trim() });
    } catch (error) {
      currentAssistantMessageIdRef.current = null;
      setMessages((cur) => {
        const withoutEmptyAssistant = cur.filter(
          (message) => message.id !== assistantId || message.content.trim(),
        );
        if (conversationIdRef.current) {
          return withoutEmptyAssistant;
        }
        return [
          ...withoutEmptyAssistant,
          {
            id: `error-${Date.now()}`,
            role: 'system',
            content: error instanceof Error ? error.message : String(error),
          },
        ];
      });
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void ask(prompt);
  };

  const selectedIssuePrompt = selectedIssue
    ? `Explain this finding and tell me whether it is likely valid: ${selectedIssue.title} in ${selectedIssue.file}${selectedIssue.line ? `:${selectedIssue.line}` : ''}.`
    : null;

  return (
    <Card className="review-chat-panel">
      <CardHeader className="review-chat-header">
        <div>
          <div className="review-kicker">Conversational Review</div>
          <CardTitle>Ask DRS</CardTitle>
        </div>
        <Sparkles className="review-chat-spark" size={18} />
      </CardHeader>
      <CardContent className="review-chat-body">
        <div className="review-chat-suggestions">
          <Button
            variant="outline"
            size="sm"
            disabled={!workingDir || sending || !review}
            onClick={() => void ask('Summarize the review output and call out the highest-impact findings.')}
          >
            Summarize
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!workingDir || sending || !selectedIssuePrompt}
            onClick={() => selectedIssuePrompt && void ask(selectedIssuePrompt)}
          >
            Explain selected
          </Button>
        </div>

        <div ref={scrollRef} className="review-chat-messages">
          {messages.map((message) => (
            <Message key={message.id} from={message.role}>
              <MessageAvatar>
                {message.role === 'user' ? <User size={13} /> : <Bot size={13} />}
              </MessageAvatar>
              <MessageContent>{message.content}</MessageContent>
            </Message>
          ))}
          {sending && (
            <Message from="assistant">
              <MessageAvatar>
                <Bot size={13} />
              </MessageAvatar>
              <MessageContent>
                <span className="spinner" /> Thinking against the latest artifacts...
              </MessageContent>
            </Message>
          )}
        </div>

        <PromptInput onSubmit={handleSubmit}>
          <PromptInputTextarea
            value={prompt}
            disabled={!workingDir || sending}
            placeholder={review ? 'Ask why a finding matters, what to fix, or what remains...' : 'Run or load a review, then ask DRS about it...'}
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
            <span>{review ? `${review.summary.issuesFound} findings loaded` : 'No review loaded'}</span>
            <Button size="icon" disabled={!workingDir || sending || !prompt.trim()} type="submit" title="Send message">
              <Send size={14} />
            </Button>
          </PromptInputActions>
        </PromptInput>
      </CardContent>
    </Card>
  );
}
