import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  ChevronRight,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/renderer/components/ui/badge';
import { Button } from '@/renderer/components/ui/button';
import { Card } from '@/renderer/components/ui/card';
import { Input } from '@/renderer/components/ui/input';
import type {
  DrsTask,
  FactoryPrd,
  FactoryPrdDetail,
  FactoryPrdVersion,
  FactoryWorkflowStatus,
} from '@/shared/ipc-types';
import { FactoryChatPanel } from './FactoryChatPanel';
import { PrdEditor } from './PrdEditor';

interface TaskBoardProps {
  workingDir: string;
}

export function TaskBoard({ workingDir }: TaskBoardProps) {
  const [tasks, setTasks] = useState<DrsTask[]>([]);
  const [prds, setPrds] = useState<FactoryPrd[]>([]);
  const [versions, setVersions] = useState<FactoryPrdVersion[]>([]);
  const [selectedPrdId, setSelectedPrdId] = useState<string | null>(null);
  const [prdDetail, setPrdDetail] = useState<FactoryPrdDetail | null>(null);
  const [workflowStatus, setWorkflowStatus] = useState<FactoryWorkflowStatus | null>(null);
  const [view, setView] = useState<'index' | 'workspace'>('index');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [markdownDraft, setMarkdownDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [showNewPrd, setShowNewPrd] = useState(false);
  const [autoStartPrdId, setAutoStartPrdId] = useState<string | null>(null);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [coordinatorOpen, setCoordinatorOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Bumped when the editor content is replaced out-of-band (e.g. version revert)
  // so the uncontrolled Milkdown editor re-seeds from the new markdown.
  const [editorEpoch, setEditorEpoch] = useState(0);

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
      const nextSelected =
        selectedPrdId && prdList.some((prd) => prd.id === selectedPrdId) ? selectedPrdId : null;
      setSelectedPrdId(nextSelected);
      if (nextSelected) {
        const [detail, versionList, status] = await Promise.all([
          window.drs.getPrd(workingDir, nextSelected),
          window.drs.listPrdVersions(workingDir, nextSelected),
          window.drs.getFactoryWorkflowStatus(workingDir, nextSelected),
        ]);
        setPrdDetail(detail);
        setVersions(versionList);
        setWorkflowStatus(status);
        setMarkdownDraft(detail.markdown);
      } else {
        setPrdDetail(null);
        setVersions([]);
        setWorkflowStatus(null);
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
        const [detail, versionList, status] = await Promise.all([
          window.drs.getPrd(workingDir, id),
          window.drs.listPrdVersions(workingDir, id),
          window.drs.getFactoryWorkflowStatus(workingDir, id),
        ]);
        setPrdDetail(detail);
        setVersions(versionList);
        setWorkflowStatus(status);
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
      const detail = await window.drs.createPrd({ workingDir, title: trimmed, description });
      const [versionList, status] = await Promise.all([
        window.drs.listPrdVersions(workingDir, detail.prd.id),
        window.drs.getFactoryWorkflowStatus(workingDir, detail.prd.id),
      ]);
      setPrds((current) => [detail.prd, ...current]);
      setSelectedPrdId(detail.prd.id);
      setPrdDetail(detail);
      setVersions(versionList);
      setWorkflowStatus(status);
      setMarkdownDraft(detail.markdown);
      setAutoStartPrdId(detail.prd.id);
      setTitle('');
      setDescription('');
      setView('workspace');
      setShowNewPrd(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }, [description, title, workingDir]);

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
      const status = await window.drs.getFactoryWorkflowStatus(workingDir, selectedPrdId);
      setPrdDetail(detail);
      setVersions(versionList);
      setWorkflowStatus(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [markdownDraft, selectedPrdId, workingDir]);

  const refreshSelectedPrd = useCallback(async () => {
    if (!selectedPrdId) return;
    try {
      const [detail, versionList, status] = await Promise.all([
        window.drs.getPrd(workingDir, selectedPrdId),
        window.drs.listPrdVersions(workingDir, selectedPrdId),
        window.drs.getFactoryWorkflowStatus(workingDir, selectedPrdId),
      ]);
      setPrdDetail(detail);
      setPrds((current) => current.map((prd) => (prd.id === detail.prd.id ? detail.prd : prd)));
      setVersions(versionList);
      setWorkflowStatus(status);
      setMarkdownDraft(detail.markdown);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [selectedPrdId, workingDir]);

  const handleDeletePrd = useCallback(async () => {
    if (!selectedPrdId) return;
    setError(null);
    try {
      await window.drs.deletePrd(workingDir, selectedPrdId);
      setPrds((current) => current.filter((prd) => prd.id !== selectedPrdId));
      setSelectedPrdId(null);
      setPrdDetail(null);
      setVersions([]);
      setWorkflowStatus(null);
      setMarkdownDraft('');
      setDeleteConfirmOpen(false);
      setAutoStartPrdId(null);
      setView('index');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [selectedPrdId, workingDir]);

  const handleImportStories = useCallback(async () => {
    if (!selectedPrdId) return;
    setError(null);
    try {
      const imported = await window.drs.importStories(workingDir, selectedPrdId);
      const status = await window.drs.getFactoryWorkflowStatus(workingDir, selectedPrdId);
      setTasks((current) => [...current, ...imported].sort(sortTasks));
      setWorkflowStatus(status);
      await refreshSelectedPrd();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [refreshSelectedPrd, selectedPrdId, workingDir]);

  const handleCoordinatorAction = useCallback(
    async (
      action:
        | 'request-prd-review'
        | 'approve-prd'
        | 'request-prd-changes'
        | 'request-stories-review'
        | 'approve-stories'
    ) => {
      if (!selectedPrdId) return;
      setError(null);
      try {
        let detail: FactoryPrdDetail;
        if (action === 'request-prd-review')
          detail = await window.drs.requestPrdReview(workingDir, selectedPrdId);
        else if (action === 'approve-prd')
          detail = await window.drs.approvePrd(workingDir, selectedPrdId);
        else if (action === 'request-prd-changes')
          detail = await window.drs.requestPrdChanges(workingDir, selectedPrdId);
        else if (action === 'request-stories-review')
          detail = await window.drs.requestStoriesReview(workingDir, selectedPrdId);
        else detail = await window.drs.approveStories(workingDir, selectedPrdId);
        const status = await window.drs.getFactoryWorkflowStatus(workingDir, selectedPrdId);
        setPrdDetail(detail);
        setWorkflowStatus(status);
        setPrds((current) => current.map((prd) => (prd.id === detail.prd.id ? detail.prd : prd)));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [selectedPrdId, workingDir]
  );

  const handleRevertVersion = useCallback(
    async (versionId: string) => {
      if (!selectedPrdId) return;
      setError(null);
      try {
        const detail = await window.drs.revertPrdVersion(workingDir, selectedPrdId, versionId);
        const versionList = await window.drs.listPrdVersions(workingDir, selectedPrdId);
        const status = await window.drs.getFactoryWorkflowStatus(workingDir, selectedPrdId);
        setPrdDetail(detail);
        setMarkdownDraft(detail.markdown);
        setEditorEpoch((epoch) => epoch + 1);
        setVersions(versionList);
        setWorkflowStatus(status);
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
        const detail = await window.drs.updateStoryStatus({
          workingDir,
          prdId: selectedPrdId,
          storyId,
          status,
        });
        setPrdDetail(detail);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [selectedPrdId, workingDir]
  );

  const handleBackToIndex = useCallback(() => {
    setDeleteConfirmOpen(false);
    setView('index');
  }, []);

  const approvedStoryCount =
    prdDetail?.stories.filter((story) => story.reviewStatus === 'approved').length ?? 0;
  const hasAction = (action: string) => workflowStatus?.allowedActions.includes(action) ?? false;
  const showApprovedWorkflow = prdDetail
    ? prdDetail.storySet.status !== 'not_started' ||
      ['approved', 'active', 'done'].includes(prdDetail.prd.status)
    : false;
  const canImportStories = !!prdDetail && hasAction('import-stories') && approvedStoryCount > 0;
  const workflowSteps = workflowStatus ? getFactoryWorkflowSteps(workflowStatus.stage) : [];
  const nextActionHint = workflowStatus ? getFactoryNextActionHint(workflowStatus) : '';
  const primaryAction: {
    label: string;
    onClick: () => void;
    variant?: 'default' | 'outline';
    disabled?: boolean;
  } | null = hasAction('approve-prd')
    ? { label: 'Approve PRD', onClick: () => void handleCoordinatorAction('approve-prd') }
    : hasAction('request-prd-review')
      ? {
          label: 'Request review',
          variant: 'outline',
          onClick: () => void handleCoordinatorAction('request-prd-review'),
        }
      : hasAction('approve-stories')
        ? { label: 'Approve stories', onClick: () => void handleCoordinatorAction('approve-stories') }
        : hasAction('request-stories-review')
          ? {
              label: 'Request story review',
              variant: 'outline',
              onClick: () => void handleCoordinatorAction('request-stories-review'),
            }
          : canImportStories
            ? { label: 'Import stories', onClick: () => void handleImportStories() }
            : null;

  if (view === 'workspace' && prdDetail) {
    return (
      <div className="task-board-shell factory-workspace-shell">
        <header className="factory-workspace-topbar">
          <div className="factory-workspace-breadcrumb">
            <button type="button" className="factory-crumb-link" onClick={handleBackToIndex}>
              All PRDs
            </button>
            <ChevronRight size={14} className="factory-crumb-sep" aria-hidden />
            <h1 title={prdDetail.prd.title}>{prdDetail.prd.title}</h1>
            <Badge variant="outline">{prdDetail.prd.status.replace(/_/g, ' ')}</Badge>
          </div>
          <div className="factory-workspace-topbar-actions">
            <Button variant="outline" size="sm" onClick={handleSavePrd}>
              Save
            </Button>
            {primaryAction && (
              <Button
                size="sm"
                variant={primaryAction.variant ?? 'default'}
                onClick={primaryAction.onClick}
                disabled={primaryAction.disabled}
              >
                {primaryAction.label}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={loadTasks} disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="factory-danger-action"
              onClick={() => setDeleteConfirmOpen(true)}
              title="Delete PRD"
              aria-label="Delete PRD"
            >
              <Trash2 size={14} />
            </Button>
          </div>
        </header>

        {workflowStatus && (
          <div className="factory-stepper-bar">
            <button
              type="button"
              className={`factory-stepper-strip${coordinatorOpen ? ' open' : ''}`}
              onClick={() => setCoordinatorOpen((current) => !current)}
              aria-expanded={coordinatorOpen}
              aria-label="Factory workflow coordinator"
            >
              {workflowSteps.map((step, index) => (
                <span key={step.key} className="factory-stepper-node-wrap">
                  {index > 0 && <span className="factory-stepper-rail" aria-hidden />}
                  <span className={`factory-stepper-node ${step.state}`}>
                    <span className="factory-stepper-marker">
                      {step.state === 'complete' ? <Check size={12} /> : step.index}
                    </span>
                    <span className="factory-stepper-label">{step.label}</span>
                  </span>
                </span>
              ))}
              <span className="factory-stepper-toggle">
                {coordinatorOpen ? 'Hide' : 'Coordinator'}
              </span>
            </button>

            {coordinatorOpen && (
              <>
                <div
                  className="factory-coordinator-scrim"
                  role="presentation"
                  onClick={() => setCoordinatorOpen(false)}
                />
                <Card className="factory-coordinator-popover">
                  <div className="factory-coordinator-top">
                    <div>
                      <div className="review-kicker">Coordinator</div>
                      <strong>{formatFactoryStage(workflowStatus.stage)}</strong>
                    </div>
                    <div className="factory-workflow-badges">
                      <Badge variant="outline">
                        PRD {workflowStatus.prdStatus.replace(/_/g, ' ')}
                      </Badge>
                      <Badge variant="outline">
                        Stories {workflowStatus.storySetStatus.replace(/_/g, ' ')}
                      </Badge>
                    </div>
                  </div>
                  <p className="factory-coordinator-hint">{nextActionHint}</p>
                  {workflowStatus.blockedReason && (
                    <div className="factory-workflow-blocked">{workflowStatus.blockedReason}</div>
                  )}
                  <div className="factory-coordinator-actions">
                    {hasAction('request-prd-review') && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleCoordinatorAction('request-prd-review')}
                      >
                        Request PRD review
                      </Button>
                    )}
                    {hasAction('approve-prd') && (
                      <Button size="sm" onClick={() => void handleCoordinatorAction('approve-prd')}>
                        Approve PRD
                      </Button>
                    )}
                    {hasAction('request-prd-changes') && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleCoordinatorAction('request-prd-changes')}
                      >
                        Request PRD changes
                      </Button>
                    )}
                    {hasAction('request-stories-review') && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleCoordinatorAction('request-stories-review')}
                      >
                        Request story review
                      </Button>
                    )}
                    {hasAction('approve-stories') && (
                      <Button
                        size="sm"
                        onClick={() => void handleCoordinatorAction('approve-stories')}
                      >
                        Approve stories
                      </Button>
                    )}
                    {showApprovedWorkflow && (
                      <Button size="sm" onClick={handleImportStories} disabled={!canImportStories}>
                        Import approved stories
                      </Button>
                    )}
                    {hasAction('draft-stories') && (
                      <span className="factory-coordinator-note">
                        Ask Factory chat to draft stories from the approved PRD.
                      </span>
                    )}
                  </div>
                </Card>
              </>
            )}
          </div>
        )}

        {error && <div className="task-board-error">{error}</div>}

        <div className={`factory-workspace-layout${chatCollapsed ? ' chat-collapsed' : ''}`}>
          <section className="factory-workspace-document">
            <PrdEditor
              className="factory-prd-milkdown"
              docKey={`${selectedPrdId ?? 'none'}:${editorEpoch}`}
              initialValue={prdDetail.markdown}
              onChange={setMarkdownDraft}
            />

            {showApprovedWorkflow && (
              <div className="factory-workspace-details">
                <button
                  type="button"
                  className="factory-details-toggle"
                  onClick={() => setDetailsOpen((current) => !current)}
                  aria-expanded={detailsOpen}
                >
                  <ChevronRight
                    size={14}
                    className={`factory-details-chevron${detailsOpen ? ' open' : ''}`}
                    aria-hidden
                  />
                  <span>Stories &amp; versions</span>
                  <Badge variant="outline">{prdDetail.stories.length}</Badge>
                </button>
                {detailsOpen && (
                  <div className="factory-workspace-secondary">
                <Card className="factory-story-preview">
                  <div className="task-column-header">
                    <div>
                      <strong>Story Draft</strong>
                      <p>{getStorySetSummary(prdDetail.storySet)}</p>
                    </div>
                    <Badge variant="outline">{prdDetail.stories.length}</Badge>
                  </div>
                  {prdDetail.stories.length === 0 ? (
                    <div className="factory-story-empty">
                      <strong>No stories drafted yet</strong>
                      <span>
                        After PRD approval, ask the Factory chat to draft stories with the story
                        skill.
                      </span>
                    </div>
                  ) : (
                    prdDetail.stories.map((story) => (
                      <Card key={story.id} className="task-card">
                        <div className="task-card-topline">
                          <Badge variant="secondary">{story.id}</Badge>
                          <span>P{story.priority}</span>
                        </div>
                        <strong>{story.title}</strong>
                        <p>{story.description}</p>
                        <Badge variant="outline">{story.reviewStatus}</Badge>
                        <div className="task-card-criteria">
                          {story.acceptanceCriteria.length} acceptance criteria
                        </div>
                        <div className="factory-story-actions">
                          <Button
                            variant="outline"
                            onClick={() => void handleStoryStatus(story.id, 'approved')}
                          >
                            Approve
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => void handleStoryStatus(story.id, 'rejected')}
                          >
                            Reject
                          </Button>
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
                    {versions.slice(0, 6).map((version) => (
                      <div key={version.id} className="factory-history-item">
                        <div>
                          <strong>{version.source}</strong>
                          <p>{version.createdAt}</p>
                          <span>{version.id}</span>
                        </div>
                        <div className="factory-prd-actions">
                          <Button
                            variant="outline"
                            onClick={() => void handleRevertVersion(version.id)}
                          >
                            Revert
                          </Button>
                        </div>
                      </div>
                    ))}
                  </Card>
                )}
                  </div>
                )}
              </div>
            )}
          </section>

          <aside className="factory-chat-sidebar">
            <Button
              variant="outline"
              size="sm"
              className="factory-chat-collapse"
              onClick={() => setChatCollapsed((current) => !current)}
              title={chatCollapsed ? 'Open planning chat' : 'Collapse planning chat'}
            >
              {chatCollapsed ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
              <span>{chatCollapsed ? 'Chat' : 'Collapse'}</span>
            </Button>
            <button
              className="factory-chat-collapsed-card"
              type="button"
              onClick={() => setChatCollapsed(false)}
            >
              <MessageSquare size={18} />
              <span>Planning chat</span>
            </button>
            <FactoryChatPanel
              workingDir={workingDir}
              prdId={selectedPrdId}
              prdTitle={prdDetail.prd.title}
              prdDescription={prdDetail.prd.description}
              workflowStage={workflowStatus?.stage}
              autoStart={autoStartPrdId === selectedPrdId}
              onAutoStarted={() => setAutoStartPrdId(null)}
              onTurnDone={refreshSelectedPrd}
            />
          </aside>
        </div>

        {deleteConfirmOpen && (
          <div className="factory-modal-backdrop" role="presentation">
            <Card
              className="factory-modal factory-confirm-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="factory-delete-prd-title"
            >
              <div className="factory-modal-header">
                <div>
                  <div className="review-kicker">Delete PRD</div>
                  <h2 id="factory-delete-prd-title">Delete {prdDetail.prd.title}?</h2>
                  <p>
                    This removes the PRD markdown, generated stories, and PRD versions. Imported
                    backlog tasks are not deleted.
                  </p>
                </div>
              </div>
              <div className="factory-prd-actions">
                <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>
                  Cancel
                </Button>
                <Button className="factory-danger-button" onClick={() => void handleDeletePrd()}>
                  <Trash2 size={14} /> Delete PRD
                </Button>
              </div>
            </Card>
          </div>
        )}
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
          <Button variant="outline" onClick={loadTasks} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </Button>
          <Button onClick={() => setShowNewPrd(true)}>New PRD</Button>
        </div>
      </div>

      {error && <div className="task-board-error">{error}</div>}

      {showNewPrd && (
        <div className="factory-modal-backdrop" role="presentation">
          <Card
            className="factory-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="factory-new-prd-title"
          >
            <div className="factory-modal-header">
              <div>
                <div className="review-kicker">Factory</div>
                <h2 id="factory-new-prd-title">New PRD</h2>
                <p>Describe the feature or maintenance effort. Creating opens the PRD workspace.</p>
              </div>
              <Button variant="ghost" onClick={() => setShowNewPrd(false)}>
                Close
              </Button>
            </div>
            <label className="settings-field-row">
              <span>Title</span>
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="PRD title..."
              />
            </label>
            <label className="settings-field-row">
              <span>Description</span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Describe the feature or maintenance effort..."
              />
            </label>
            <div className="factory-prd-actions">
              <Button variant="outline" onClick={() => setShowNewPrd(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreatePrd} disabled={adding || !title.trim()}>
                {adding ? 'Creating...' : 'Create PRD'}
              </Button>
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
              <span>Description</span>
              <span>Status</span>
              <span>Stories</span>
              <span>Updated</span>
            </div>
            {prds.map((prd) => {
              const storyCount = tasks.filter((task) => task.prdId === prd.id).length;
              return (
                <button
                  key={prd.id}
                  type="button"
                  className="factory-prd-table-row"
                  onClick={() => void handleSelectPrd(prd.id)}
                >
                  <strong>{prd.title}</strong>
                  <span>{prd.description || 'No description captured.'}</span>
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

type FactoryWorkflowStage = FactoryWorkflowStatus['stage'];

interface FactoryWorkflowStep {
  key: 'prd' | 'prd-review' | 'stories' | 'story-review' | 'import';
  index: number;
  label: string;
  state: 'complete' | 'current' | 'pending';
}

const FACTORY_WORKFLOW_ORDER: FactoryWorkflowStage[] = [
  'prd_draft',
  'prd_review_requested',
  'prd_approved',
  'stories_draft',
  'stories_review_requested',
  'stories_approved',
  'stories_imported',
];

function getFactoryWorkflowSteps(stage: FactoryWorkflowStage): FactoryWorkflowStep[] {
  const currentIndex = FACTORY_WORKFLOW_ORDER.indexOf(stage);
  const steps: Array<Omit<FactoryWorkflowStep, 'state'>> = [
    { key: 'prd', index: 1, label: 'Draft PRD' },
    { key: 'prd-review', index: 2, label: 'Approve PRD' },
    { key: 'stories', index: 3, label: 'Draft Stories' },
    { key: 'story-review', index: 4, label: 'Approve Stories' },
    { key: 'import', index: 5, label: 'Import' },
  ];
  const activeStepByStage: Record<FactoryWorkflowStage, FactoryWorkflowStep['key']> = {
    prd_draft: 'prd',
    prd_review_requested: 'prd-review',
    prd_approved: 'stories',
    stories_draft: 'stories',
    stories_review_requested: 'story-review',
    stories_approved: 'import',
    stories_imported: 'import',
  };
  const activeKey = activeStepByStage[stage];
  const activeIndex = steps.findIndex((step) => step.key === activeKey);

  return steps.map((step, index) => ({
    ...step,
    state:
      stage === 'stories_imported' ||
      index < activeIndex ||
      (stage === 'prd_approved' && step.key === 'prd-review') ||
      currentIndex > FACTORY_WORKFLOW_ORDER.indexOf('stories_approved')
        ? 'complete'
        : index === activeIndex
          ? 'current'
          : 'pending',
  }));
}

function formatFactoryStage(stage: FactoryWorkflowStage): string {
  const labels: Record<FactoryWorkflowStage, string> = {
    prd_draft: 'PRD Draft',
    prd_review_requested: 'PRD Review Requested',
    prd_approved: 'PRD Approved',
    stories_draft: 'Stories Drafted',
    stories_review_requested: 'Story Review Requested',
    stories_approved: 'Stories Approved',
    stories_imported: 'Stories Imported',
  };
  return labels[stage];
}

function getFactoryNextActionHint(status: FactoryWorkflowStatus): string {
  if (status.blockedReason) return status.blockedReason;
  if (status.allowedActions.includes('request-prd-review'))
    return 'Refine the PRD with chat, save it, then request review when scope is stable.';
  if (status.allowedActions.includes('approve-prd'))
    return 'Review the PRD document. Approve it to unlock story drafting, or request changes.';
  if (status.allowedActions.includes('draft-stories'))
    return 'PRD is approved. Use Factory chat and the story skill to draft structured stories.';
  if (status.allowedActions.includes('request-stories-review'))
    return 'Story draft exists. Request story review when the story set is ready for approval.';
  if (status.allowedActions.includes('approve-stories'))
    return 'Review the drafted stories. Approve them before importing to the backlog.';
  if (status.allowedActions.includes('import-stories'))
    return 'Stories are approved. Import them to create backlog tasks.';
  if (status.stage === 'stories_imported')
    return 'Stories were imported. Continue execution from the backlog board.';
  return 'No coordinator action is currently available.';
}

function getStorySetSummary(storySet: FactoryPrdDetail['storySet']): string {
  if (storySet.status === 'not_started') return 'No story set yet';
  return `${storySet.status.replace(/_/g, ' ')} from ${storySet.source.replace(/_/g, ' ')}`;
}
