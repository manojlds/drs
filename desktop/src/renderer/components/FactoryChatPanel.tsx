import { AcpChatPanel } from './AcpChatPanel';

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
  const autoStartPrompt = prdId
    ? [
        skillPrompt,
        `PRD id: ${prdId}`,
        workflowStage ? `Factory workflow stage: ${workflowStage}` : null,
        `PRD title: ${prdTitle || prdId}`,
        prdDescription ? `PRD description:\n${prdDescription}` : null,
      ].filter(Boolean).join('\n\n')
    : null;

  return (
    <AcpChatPanel
      mode="factory"
      workingDir={workingDir}
      storagePrefix="drs.factoryChat"
      scopeParts={[prdId ?? '', workflowStage ?? '']}
      title="Factory Planner"
      kicker="Planning Chat"
      subtitle="ACP-backed planning agent"
      emptyMessage="Start by describing what is unclear, or create a PRD to let the planning agent interview you."
      placeholder="Plan, clarify, critique, or slice the selected PRD..."
      startPayload={{ prdId: prdId ?? undefined }}
      autoStart={autoStart}
      autoStartPrompt={autoStartPrompt}
      onAutoStarted={onAutoStarted}
      onTurnDone={onTurnDone}
    />
  );
}
