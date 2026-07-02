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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, sending]);

  const ask = async (text: string) => {
    if (!workingDir || sending || !text.trim()) return;
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text.trim(),
    };
    setMessages((cur) => [...cur, userMessage]);
    setPrompt('');
    setSending(true);
    try {
      const result = await window.drs.askReviewChat({ workingDir, prompt: text.trim() });
      setMessages((cur) => [
        ...cur,
        {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: result.response || 'No response was returned.',
        },
      ]);
    } catch (error) {
      setMessages((cur) => [
        ...cur,
        {
          id: `error-${Date.now()}`,
          role: 'system',
          content: error instanceof Error ? error.message : String(error),
        },
      ]);
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
