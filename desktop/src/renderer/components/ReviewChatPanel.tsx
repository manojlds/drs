import { AcpChatPanel, type AcpChatSuggestion } from './AcpChatPanel';
import type { ReviewIssue, ReviewJsonOutput } from '../types';

interface ReviewChatPanelProps {
  workingDir: string | null;
  review: ReviewJsonOutput | null;
  selectedIssue: ReviewIssue | null;
}

export function ReviewChatPanel({ workingDir, review, selectedIssue }: ReviewChatPanelProps) {
  const selectedIssuePrompt = selectedIssue
    ? `Explain this finding and tell me whether it is likely valid: ${selectedIssue.title} in ${selectedIssue.file}${selectedIssue.line ? `:${selectedIssue.line}` : ''}.`
    : '';
  const suggestions: AcpChatSuggestion[] = [
    {
      label: 'Summarize',
      prompt: 'Summarize the review output and call out the highest-impact findings.',
      disabled: !review,
    },
    {
      label: 'Explain selected',
      prompt: selectedIssuePrompt,
      disabled: !selectedIssuePrompt,
    },
  ];

  return (
    <AcpChatPanel
      mode="review"
      workingDir={workingDir}
      storagePrefix="drs.reviewChat"
      scopeParts={[review?.timestamp ?? '', selectedIssue ? `${selectedIssue.file}:${selectedIssue.line ?? ''}:${selectedIssue.title}` : '']}
      title="Ask DRS"
      kicker="Conversational Review"
      subtitle="ACP-backed review agent"
      emptyMessage="Ask about the latest DRS review output. I can explain findings, clarify severity, and suggest the smallest safe fix scope."
      placeholder={review ? 'Ask why a finding matters, what to fix, or what remains...' : 'Run or load a review, then ask DRS about it...'}
      panelClassName="review-chat-panel"
      headerClassName="review-chat-header"
      messagesClassName="review-chat-messages"
      suggestions={suggestions}
      disabledReason={!workingDir ? 'Open a project before starting review chat.' : null}
      footerStatus={review ? `${review.summary.issuesFound} findings loaded` : 'No review loaded'}
    />
  );
}
