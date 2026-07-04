import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/renderer/components/ui/badge';
import { Button } from '@/renderer/components/ui/button';
import { Card } from '@/renderer/components/ui/card';
import { Input } from '@/renderer/components/ui/input';
import type { DrsTask, FactoryPrd, FactoryPrdDetail, FactoryProposal, TaskStatus } from '@/shared/ipc-types';
import { FactoryChatPanel } from './FactoryChatPanel';

interface TaskBoardProps {
  workingDir: string;
}

type BoardColumn = {
  id: string;
  title: string;
  statuses: TaskStatus[];
};

const COLUMNS: BoardColumn[] = [
  { id: 'draft', title: 'Draft', statuses: ['draft'] },
  { id: 'backlog', title: 'Backlog', statuses: ['backlog', 'open'] },
  { id: 'todo', title: 'Todo', statuses: ['todo'] },
  { id: 'dev', title: 'In Dev', statuses: ['in_progress'] },
  { id: 'checks', title: 'Checks', statuses: ['checks_failed'] },
  { id: 'review', title: 'Review', statuses: ['in_review', 'review_failed'] },
  { id: 'ready', title: 'Ready', statuses: ['ready_to_merge'] },
  { id: 'done', title: 'Done', statuses: ['merged', 'done'] },
  { id: 'failed', title: 'Stopped', statuses: ['failed', 'cancelled'] },
];

const MOVE_STATUSES: TaskStatus[] = [
  'draft',
  'backlog',
  'todo',
  'open',
  'checks_failed',
  'in_review',
  'review_failed',
  'ready_to_merge',
  'done',
  'failed',
  'cancelled',
];

export function TaskBoard({ workingDir }: TaskBoardProps) {
  const [tasks, setTasks] = useState<DrsTask[]>([]);
  const [prds, setPrds] = useState<FactoryPrd[]>([]);
  const [proposals, setProposals] = useState<FactoryProposal[]>([]);
  const [selectedPrdId, setSelectedPrdId] = useState<string | null>(null);
  const [prdDetail, setPrdDetail] = useState<FactoryPrdDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [markdownDraft, setMarkdownDraft] = useState('');
  const [adding, setAdding] = useState(false);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [taskList, prdList, proposalList] = await Promise.all([
        window.drs.listTasks(workingDir),
        window.drs.listPrds(workingDir),
        window.drs.listProposals(workingDir),
      ]);
      setTasks(taskList);
      setPrds(prdList);
      setProposals(proposalList);
      const nextSelected = selectedPrdId ?? prdList[0]?.id ?? null;
      setSelectedPrdId(nextSelected);
      if (nextSelected) {
        const detail = await window.drs.getPrd(workingDir, nextSelected);
        setPrdDetail(detail);
        setMarkdownDraft(detail.markdown);
      } else {
        setPrdDetail(null);
        setMarkdownDraft('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedPrdId, workingDir]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const byColumn = useMemo(() => {
    const grouped = new Map<string, DrsTask[]>();
    for (const column of COLUMNS) grouped.set(column.id, []);
    for (const task of tasks.filter((item) => !selectedPrdId || item.prdId === selectedPrdId)) {
      const column = COLUMNS.find((item) => item.statuses.includes(task.status));
      grouped.get(column?.id ?? 'backlog')?.push(task);
    }
    return grouped;
  }, [selectedPrdId, tasks]);

  const handleSelectPrd = useCallback(
    async (id: string) => {
      setSelectedPrdId(id);
      setError(null);
      try {
        const detail = await window.drs.getPrd(workingDir, id);
        setPrdDetail(detail);
        setMarkdownDraft(detail.markdown);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [workingDir]
  );

  const handleCreatePrd = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setAdding(true);
    setError(null);
    try {
      const detail = await window.drs.createPrd({ workingDir, title: trimmed, prompt });
      setPrds((current) => [detail.prd, ...current]);
      setSelectedPrdId(detail.prd.id);
      setPrdDetail(detail);
      setMarkdownDraft(detail.markdown);
      setTitle('');
      setPrompt('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }, [prompt, title, workingDir]);

  const handleSavePrd = useCallback(async () => {
    if (!selectedPrdId) return;
    setError(null);
    try {
      const detail = await window.drs.updatePrd({
        workingDir,
        id: selectedPrdId,
        markdown: markdownDraft,
      });
      setPrdDetail(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [markdownDraft, selectedPrdId, workingDir]);

  const handlePrdStatus = useCallback(
    async (status: FactoryPrd['status']) => {
      if (!selectedPrdId) return;
      setError(null);
      try {
        const detail = await window.drs.updatePrdStatus({ workingDir, id: selectedPrdId, status });
        setPrdDetail(detail);
        setPrds((current) => current.map((prd) => (prd.id === detail.prd.id ? detail.prd : prd)));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [selectedPrdId, workingDir]
  );

  const handleGenerateStories = useCallback(async () => {
    if (!selectedPrdId) return;
    setError(null);
    try {
      const saved = await window.drs.updatePrd({ workingDir, id: selectedPrdId, markdown: markdownDraft });
      const detail = await window.drs.generateStories(workingDir, saved.prd.id);
      setPrdDetail(detail);
      setMarkdownDraft(detail.markdown);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [markdownDraft, selectedPrdId, workingDir]);

  const handleImportStories = useCallback(async () => {
    if (!selectedPrdId) return;
    setError(null);
    try {
      const imported = await window.drs.importStories(workingDir, selectedPrdId);
      setTasks((current) => [...current, ...imported].sort(sortTasks));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [selectedPrdId, workingDir]);

  const handleApplyProposal = useCallback(
    async (proposalId: string) => {
      setError(null);
      try {
        const result = await window.drs.applyProposal(workingDir, proposalId);
        setPrdDetail({ prd: result.prd, markdown: result.markdown, stories: result.stories });
        setMarkdownDraft(result.markdown);
        setProposals((current) => current.map((proposal) => (proposal.id === result.proposal.id ? result.proposal : proposal)));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [workingDir]
  );

  const handleDiscardProposal = useCallback(
    async (proposalId: string) => {
      setError(null);
      try {
        const discarded = await window.drs.discardProposal(workingDir, proposalId);
        setProposals((current) => current.map((proposal) => (proposal.id === discarded.id ? discarded : proposal)));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [workingDir]
  );

  const handleStoryStatus = useCallback(
    async (storyId: string, status: 'draft' | 'approved' | 'rejected') => {
      if (!selectedPrdId) return;
      setError(null);
      try {
        const detail = await window.drs.updateStoryStatus({ workingDir, prdId: selectedPrdId, storyId, status });
        setPrdDetail(detail);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [selectedPrdId, workingDir]
  );

  const handleAddTask = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setAdding(true);
    setError(null);
    try {
      const task = await window.drs.addTask({ workingDir, title: trimmed, status: 'open' });
      setTasks((current) => [...current, task].sort(sortTasks));
      setTitle('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }, [title, workingDir]);

  const handleMoveTask = useCallback(
    async (task: DrsTask, status: TaskStatus) => {
      setError(null);
      try {
        const updated = await window.drs.updateTask({ workingDir, id: task.id, status });
        setTasks((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [workingDir]
  );

  const approvedStoryCount = prdDetail?.stories.filter((story) => story.reviewStatus === 'approved').length ?? 0;
  const canImportStories =
    !!prdDetail &&
    (prdDetail.prd.status === 'approved' || prdDetail.prd.status === 'active') &&
    approvedStoryCount > 0;
  const draftProposals = proposals.filter(
    (proposal) => proposal.status === 'draft' && (!selectedPrdId || proposal.prdId === selectedPrdId)
  );

  return (
    <div className="task-board-shell">
      <div className="task-board-header">
        <div>
          <div className="review-kicker">Factory</div>
          <h1>Planning Board</h1>
          <p>Create PRDs, generate reviewable stories, then import them into a scoped kanban.</p>
        </div>
        <Button variant="outline" onClick={loadTasks} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </Button>
      </div>

      <Card className="task-create-card task-create-card-stacked">
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="New PRD title..."
        />
        <Input
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Planning prompt or feature intent..."
        />
        <Button onClick={handleCreatePrd} disabled={adding || !title.trim()}>
          {adding ? 'Creating...' : 'Create PRD'}
        </Button>
      </Card>

      {error && <div className="task-board-error">{error}</div>}

      {draftProposals.length > 0 && (
        <Card className="factory-proposals-panel">
          <div className="task-column-header">
            <strong>Planning Proposals</strong>
            <Badge variant="outline">{draftProposals.length}</Badge>
          </div>
          {draftProposals.map((proposal) => (
            <div key={proposal.id} className="factory-proposal-item">
              <div>
                <strong>{proposal.title}</strong>
                {proposal.summary && <p>{proposal.summary}</p>}
                <span>{proposal.id}</span>
              </div>
              <div className="factory-prd-actions">
                <Button variant="outline" onClick={() => void handleApplyProposal(proposal.id)}>Apply</Button>
                <Button variant="outline" onClick={() => void handleDiscardProposal(proposal.id)}>Discard</Button>
              </div>
            </div>
          ))}
        </Card>
      )}

      <div className="factory-planning-layout">
        <aside className="factory-prd-list">
          <div className="task-column-header">
            <strong>PRDs</strong>
            <Badge variant="outline">{prds.length}</Badge>
          </div>
          {prds.length === 0 ? (
            <div className="task-column-empty">Create a PRD to start planning.</div>
          ) : (
            prds.map((prd) => (
              <button
                key={prd.id}
                type="button"
                className={`factory-prd-item ${selectedPrdId === prd.id ? 'active' : ''}`}
                onClick={() => void handleSelectPrd(prd.id)}
              >
                <strong>{prd.title}</strong>
                <span>{prd.id}</span>
              </button>
            ))
          )}
        </aside>

        <section className="factory-prd-detail">
          {prdDetail ? (
            <>
              <div className="factory-prd-detail-header">
                <div>
                  <div className="review-kicker">PRD</div>
                  <h2>{prdDetail.prd.title}</h2>
                  <Badge variant="outline">{prdDetail.prd.status.replace(/_/g, ' ')}</Badge>
                </div>
                <div className="factory-prd-actions">
                  <Button variant="outline" onClick={handleSavePrd}>Save PRD</Button>
                  <Button variant="outline" onClick={handleGenerateStories}>Generate Stories</Button>
                  <Button variant="outline" onClick={() => void handlePrdStatus('in_review')}>Request Review</Button>
                  <Button variant="outline" onClick={() => void handlePrdStatus('approved')}>Approve PRD</Button>
                  <Button onClick={handleImportStories} disabled={!canImportStories}>
                    Import Stories
                  </Button>
                </div>
              </div>
              <textarea
                className="factory-prd-editor"
                value={markdownDraft}
                onChange={(event) => setMarkdownDraft(event.target.value)}
              />
              <div className="factory-story-preview">
                <div className="task-column-header">
                  <strong>Generated Stories</strong>
                  <Badge variant="outline">{prdDetail.stories.length}</Badge>
                </div>
                {prdDetail.stories.length === 0 ? (
                  <div className="task-column-empty">Generate stories after reviewing the PRD.</div>
                ) : (
                  prdDetail.stories.map((story) => (
                    <Card key={story.id} className="task-card">
                      <div className="task-card-topline"><Badge variant="secondary">{story.id}</Badge><span>P{story.priority}</span></div>
                      <strong>{story.title}</strong>
                      <p>{story.description}</p>
                      <Badge variant="outline">{story.reviewStatus}</Badge>
                      <div className="task-card-criteria">{story.acceptanceCriteria.length} acceptance criteria</div>
                      <div className="factory-story-actions">
                        <Button variant="outline" onClick={() => void handleStoryStatus(story.id, 'approved')}>Approve</Button>
                        <Button variant="outline" onClick={() => void handleStoryStatus(story.id, 'rejected')}>Reject</Button>
                      </div>
                    </Card>
                  ))
                )}
              </div>
            </>
          ) : (
            <div className="task-column-empty">No PRD selected.</div>
          )}
        </section>
      </div>

      <FactoryChatPanel workingDir={workingDir} prdId={selectedPrdId} />

      <div className="task-board-grid">
        {COLUMNS.map((column) => {
          const columnTasks = byColumn.get(column.id) ?? [];
          return (
            <section key={column.id} className="task-column">
              <div className="task-column-header">
                <strong>{column.title}</strong>
                <Badge variant="outline">{columnTasks.length}</Badge>
              </div>
              <div className="task-column-cards">
                {columnTasks.length === 0 ? (
                  <div className="task-column-empty">No tasks</div>
                ) : (
                  columnTasks.map((task) => (
                    <TaskCard key={task.id} task={task} onMove={handleMoveTask} />
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function TaskCard({
  task,
  onMove,
}: {
  task: DrsTask;
  onMove: (task: DrsTask, status: TaskStatus) => void;
}) {
  return (
    <Card className="task-card">
      <div className="task-card-topline">
        <Badge variant="secondary">{task.id}</Badge>
        <span>P{task.priority}</span>
      </div>
      <strong>{task.title}</strong>
      {task.description && <p>{task.description}</p>}
      {task.acceptanceCriteria.length > 0 && (
        <div className="task-card-criteria">{task.acceptanceCriteria.length} acceptance criteria</div>
      )}
      <label className="task-status-select">
        <span>Move to</span>
        <select
          value={task.status}
          disabled={task.status === 'in_progress'}
          onChange={(event) => onMove(task, event.target.value as TaskStatus)}
        >
          {[...new Set([task.status, ...MOVE_STATUSES])].map((status) => (
            <option key={status} value={status}>
              {status.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </label>
    </Card>
  );
}

function sortTasks(a: DrsTask, b: DrsTask): number {
  return a.priority - b.priority || a.id.localeCompare(b.id);
}
