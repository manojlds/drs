import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/renderer/components/ui/badge';
import { Button } from '@/renderer/components/ui/button';
import { Card } from '@/renderer/components/ui/card';
import { Input } from '@/renderer/components/ui/input';
import type { DrsTask, FactoryPrd, FactoryPrdDetail, FactoryPrdVersion } from '@/shared/ipc-types';
import { FactoryChatPanel } from './FactoryChatPanel';

interface TaskBoardProps {
  workingDir: string;
}

export function TaskBoard({ workingDir }: TaskBoardProps) {
  const [tasks, setTasks] = useState<DrsTask[]>([]);
  const [prds, setPrds] = useState<FactoryPrd[]>([]);
  const [versions, setVersions] = useState<FactoryPrdVersion[]>([]);
  const [selectedPrdId, setSelectedPrdId] = useState<string | null>(null);
  const [prdDetail, setPrdDetail] = useState<FactoryPrdDetail | null>(null);
  const [view, setView] = useState<'index' | 'workspace'>('index');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [markdownDraft, setMarkdownDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [showNewPrd, setShowNewPrd] = useState(false);
  const [autoStartPrdId, setAutoStartPrdId] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [taskList, prdList] = await Promise.all([
        window.drs.listTasks(workingDir),
        window.drs.listPrds(workingDir),
      ]);
      setTasks(taskList);
      setPrds(prdList);
      const nextSelected = selectedPrdId && prdList.some((prd) => prd.id === selectedPrdId) ? selectedPrdId : null;
      setSelectedPrdId(nextSelected);
      if (nextSelected) {
        const detail = await window.drs.getPrd(workingDir, nextSelected);
        const versionList = await window.drs.listPrdVersions(workingDir, nextSelected);
        setPrdDetail(detail);
        setVersions(versionList);
        setMarkdownDraft(detail.markdown);
      } else {
        setPrdDetail(null);
        setVersions([]);
        setMarkdownDraft('');
        setView('index');
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

  const handleSelectPrd = useCallback(
    async (id: string) => {
      setSelectedPrdId(id);
      setError(null);
      try {
        const detail = await window.drs.getPrd(workingDir, id);
        const versionList = await window.drs.listPrdVersions(workingDir, id);
        setPrdDetail(detail);
        setVersions(versionList);
        setMarkdownDraft(detail.markdown);
        setView('workspace');
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
      const versionList = await window.drs.listPrdVersions(workingDir, detail.prd.id);
      setPrds((current) => [detail.prd, ...current]);
      setSelectedPrdId(detail.prd.id);
      setPrdDetail(detail);
      setVersions(versionList);
      setMarkdownDraft(detail.markdown);
      setAutoStartPrdId(detail.prd.id);
      setTitle('');
      setPrompt('');
      setView('workspace');
      setShowNewPrd(false);
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
      const versionList = await window.drs.listPrdVersions(workingDir, selectedPrdId);
      setPrdDetail(detail);
      setVersions(versionList);
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

  const handleRevertVersion = useCallback(
    async (versionId: string) => {
      if (!selectedPrdId) return;
      setError(null);
      try {
        const detail = await window.drs.revertPrdVersion(workingDir, selectedPrdId, versionId);
        const versionList = await window.drs.listPrdVersions(workingDir, selectedPrdId);
        setPrdDetail(detail);
        setMarkdownDraft(detail.markdown);
        setVersions(versionList);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [selectedPrdId, workingDir]
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

  const handleBackToIndex = useCallback(() => {
    setView('index');
  }, []);

  const approvedStoryCount = prdDetail?.stories.filter((story) => story.reviewStatus === 'approved').length ?? 0;
  const canImportStories =
    !!prdDetail &&
    (prdDetail.prd.status === 'approved' || prdDetail.prd.status === 'active') &&
    approvedStoryCount > 0;

  if (view === 'workspace' && prdDetail) {
    return (
      <div className="task-board-shell factory-workspace-shell">
        <div className="task-board-header">
          <div>
            <div className="review-kicker">Factory</div>
            <h1>{prdDetail.prd.title}</h1>
            <p>{prdDetail.prd.prompt || 'Plan with the agent while the PRD evolves on the right.'}</p>
          </div>
          <div className="factory-prd-actions">
            <Button variant="outline" onClick={handleBackToIndex}>All PRDs</Button>
            <Button variant="outline" onClick={loadTasks} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</Button>
          </div>
        </div>

        {error && <div className="task-board-error">{error}</div>}

        <div className="factory-workspace-layout">
          <FactoryChatPanel
            workingDir={workingDir}
            prdId={selectedPrdId}
            prdTitle={prdDetail.prd.title}
            prdPrompt={prdDetail.prd.prompt}
            autoStart={autoStartPrdId === selectedPrdId}
            onAutoStarted={() => setAutoStartPrdId(null)}
          />

          <section className="factory-prd-detail factory-workspace-document">
            <div className="factory-prd-detail-header">
              <div>
                <div className="review-kicker">Current PRD</div>
                <h2>{prdDetail.prd.title}</h2>
                <Badge variant="outline">{prdDetail.prd.status.replace(/_/g, ' ')}</Badge>
              </div>
              <div className="factory-prd-actions">
                <Button variant="outline" onClick={handleSavePrd}>Save PRD</Button>
                <Button variant="outline" onClick={handleGenerateStories}>Generate Stories</Button>
                <Button variant="outline" onClick={() => void handlePrdStatus('in_review')}>Request Review</Button>
                <Button variant="outline" onClick={() => void handlePrdStatus('approved')}>Approve PRD</Button>
                <Button onClick={handleImportStories} disabled={!canImportStories}>Import Stories</Button>
              </div>
            </div>
            <textarea className="factory-prd-editor" value={markdownDraft} onChange={(event) => setMarkdownDraft(event.target.value)} />

            <div className="factory-workspace-secondary">
              <Card className="factory-story-preview">
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
              </Card>

              {versions.length > 0 && (
                <Card className="factory-history-panel">
                  <div className="task-column-header">
                    <strong>PRD Versions</strong>
                    <Badge variant="outline">{versions.length}</Badge>
                  </div>
                  {versions.slice(0, 4).map((version) => (
                    <div key={version.id} className="factory-history-item">
                      <div>
                        <strong>{version.source}</strong>
                        <p>{version.createdAt}</p>
                        <span>{version.id}</span>
                      </div>
                      <div className="factory-prd-actions">
                        <Button variant="outline" onClick={() => void handleRevertVersion(version.id)}>Revert</Button>
                      </div>
                    </div>
                  ))}
                </Card>
              )}
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="task-board-shell">
      <div className="task-board-header">
        <div>
          <div className="review-kicker">Factory</div>
          <h1>PRDs</h1>
          <p>Start from a planning document, then use chat to shape it into reviewable stories.</p>
        </div>
        <div className="factory-prd-actions">
          <Button variant="outline" onClick={loadTasks} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</Button>
          <Button onClick={() => setShowNewPrd(true)}>New PRD</Button>
        </div>
      </div>

      {error && <div className="task-board-error">{error}</div>}

      {showNewPrd && (
        <div className="factory-modal-backdrop" role="presentation">
          <Card className="factory-modal" role="dialog" aria-modal="true" aria-labelledby="factory-new-prd-title">
            <div className="factory-modal-header">
              <div>
                <div className="review-kicker">Factory</div>
                <h2 id="factory-new-prd-title">New PRD</h2>
                <p>Describe the feature or maintenance effort. Creating opens the PRD workspace.</p>
              </div>
              <Button variant="ghost" onClick={() => setShowNewPrd(false)}>Close</Button>
            </div>
            <label className="settings-field-row">
              <span>Title</span>
              <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="PRD title..." />
            </label>
            <label className="settings-field-row">
              <span>Prompt</span>
              <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Initial prompt or feature intent..." />
            </label>
            <div className="factory-prd-actions">
              <Button variant="outline" onClick={() => setShowNewPrd(false)}>Cancel</Button>
              <Button onClick={handleCreatePrd} disabled={adding || !title.trim()}>{adding ? 'Creating...' : 'Create PRD'}</Button>
            </div>
          </Card>
        </div>
      )}

      <Card className="factory-prd-table-card">
        <div className="task-column-header">
          <strong>Planning Documents</strong>
          <Badge variant="outline">{prds.length}</Badge>
        </div>
        {prds.length === 0 ? (
          <div className="task-column-empty">Create a PRD to start planning.</div>
        ) : (
          <div className="factory-prd-table">
            <div className="factory-prd-table-row factory-prd-table-head">
              <span>Name</span>
              <span>Prompt</span>
              <span>Status</span>
              <span>Stories</span>
              <span>Updated</span>
            </div>
            {prds.map((prd) => {
              const storyCount = tasks.filter((task) => task.prdId === prd.id).length;
              return (
                <button key={prd.id} type="button" className="factory-prd-table-row" onClick={() => void handleSelectPrd(prd.id)}>
                  <strong>{prd.title}</strong>
                  <span>{prd.prompt || 'No prompt captured.'}</span>
                  <Badge variant="outline">{prd.status.replace(/_/g, ' ')}</Badge>
                  <span>{storyCount}</span>
                  <span>{prd.updatedAt}</span>
                </button>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function sortTasks(a: DrsTask, b: DrsTask): number {
  return a.priority - b.priority || a.id.localeCompare(b.id);
}
