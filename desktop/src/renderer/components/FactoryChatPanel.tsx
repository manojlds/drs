import { AcpChatPanel, type AcpChatSuggestion } from './AcpChatPanel';

interface FactoryChatPanelProps {
  workingDir: string;
  prdId: string | null;
  prdTitle?: string;
  prdDescription?: string;
  workflowStage?: string;
  autoStart?: boolean;
  onAutoStarted?: () => void;
  onTurnDone?: () => void;
}

export function FactoryChatPanel({ workingDir, prdId, prdTitle, prdDescription, workflowStage, autoStart, onAutoStarted, onTurnDone }: FactoryChatPanelProps) {
  const skillPrompt = workflowStage?.startsWith('stories')
    ? 'Use the Factory stories skill now.'
    : 'Use the Factory planning skill now.';
  const isStoriesStage = workflowStage?.startsWith('stories') ?? false;
  const autoStartPrompt = prdId
    ? [
        skillPrompt,
        `PRD id: ${prdId}`,
        workflowStage ? `Factory workflow stage: ${workflowStage}` : null,
        `PRD title: ${prdTitle || prdId}`,
        prdDescription ? `PRD description:\n${prdDescription}` : null,
      ].filter(Boolean).join('\n\n')
    : null;

  const suggestions: AcpChatSuggestion[] = !prdId
    ? []
    : isStoriesStage
      ? [
          { label: 'Draft stories from PRD', prompt: autoStartPrompt ?? 'Draft stories from the approved PRD.' },
          {
            label: 'Refine story slices',
            prompt:
              'Review the current story set and propose tighter, independently shippable slices with clear acceptance criteria.',
          },
        ]
      : [
          { label: 'Start planning session', prompt: autoStartPrompt ?? 'Begin planning this PRD.' },
          {
            label: 'Interview me',
            prompt:
              'Interview me with focused questions to remove ambiguity from this PRD, one topic at a time.',
          },
          {
            label: 'Critique & tighten scope',
            prompt:
              'Critique this PRD: flag vague requirements, missing constraints, and scope risks, then propose concrete edits.',
          },
        ];

  return (
    <AcpChatPanel
      mode="factory"
      workingDir={workingDir}
      storagePrefix="drs.factoryChat"
      scopeParts={[prdId ?? '', workflowStage ?? '']}
      title="Factory Planner"
      kicker="Planning Chat"
      subtitle="ACP-backed planning agent"
      emptyMessage={
        prdId
          ? 'Pick a starter below, or type a message to begin planning this PRD.'
          : 'Create a PRD to let the planning agent interview you, or describe what is unclear.'
      }
      placeholder="Plan, clarify, critique, or slice the selected PRD..."
      suggestions={suggestions}
      startPayload={{ prdId: prdId ?? undefined }}
      autoStart={autoStart}
      autoStartPrompt={autoStartPrompt}
      onAutoStarted={onAutoStarted}
      onTurnDone={onTurnDone}
    />
  );
}
