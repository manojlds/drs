import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DiffView } from './components/DiffView';
import { FileTree } from './components/FileTree';
import { IssuesPanel } from './components/IssuesPanel';
import { RunBanner, type RunBannerState } from './components/RunBanner';
import { ThemeToggle } from './components/ThemeToggle';
import { Badge } from '@/renderer/components/ui/badge';
import { Button } from '@/renderer/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/renderer/components/ui/card';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/renderer/components/ui/tabs';
import { SEVERITIES, severityToInput } from './lib/badges';
import { buildReviewMarkdown, copyToClipboard } from './lib/markdown';
import { parseUnifiedDiff, type DiffFile, issueLineKey } from './lib/diff';
import type {
  IssueSeverity,
  ReviewIssue,
  ReviewJsonOutput,
  WorkflowListEntry,
  WorkflowDetail,
  WorkflowInputConfig,
  WorkflowLogEvent,
  WorkflowRunResultJson,
} from './types';

const REVIEW_WORKFLOW = 'local-review';
const FIX_WORKFLOW = 'local-fix-review-issues';
const VISUAL_WORKFLOW = 'local-visual-explain';
const RECENT_PROJECTS_KEY = 'drs-desktop:recent-projects';
const RUN_HISTORY_KEY = 'drs-desktop:run-history';
const REVIEW_SNAPSHOTS_KEY = 'drs-desktop:review-snapshots';

type ReviewView = 'overview' | 'diff' | 'walkthrough' | 'output';
type ProjectMode = 'review' | 'workflow';

interface RunHistoryEntry {
  id: string;
  project: string;
  workflow: string;
  timestamp: string;
  status: 'success' | 'error';
  inputs: Record<string, string>;
  error?: string;
  result?: WorkflowRunResultJson;
}

interface ReviewSnapshot {
  project: string;
  target: 'staged' | 'unstaged';
  diffFingerprint: string;
  timestamp: string;
  workflow: string;
  review: ReviewJsonOutput;
}

export function App() {
  const [showProjectsHome, setShowProjectsHome] = useState(true);
  const [workingDir, setWorkingDir] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowListEntry[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(false);
  const [workflowsError, setWorkflowsError] = useState<string | null>(null);
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
  const [selectedWorkflowDetail, setSelectedWorkflowDetail] = useState<WorkflowDetail | null>(null);
  const [workflowInputs, setWorkflowInputs] = useState<Record<string, string>>({});
  const [recentProjects, setRecentProjects] = useState<string[]>(() => readStringArray(RECENT_PROJECTS_KEY));
  const [runHistory, setRunHistory] = useState<RunHistoryEntry[]>(() => readRunHistory());
  const [lastRunResult, setLastRunResult] = useState<WorkflowRunResultJson | null>(null);
  const [staged, setStaged] = useState(false);
  const [diffLayout, setDiffLayout] = useState<'unified' | 'split'>('split');
  const [diffSourceLabel, setDiffSourceLabel] = useState('Local unstaged diff');
  const [reviewView, setReviewView] = useState<ReviewView>('overview');
  const [projectMode, setProjectMode] = useState<ProjectMode>('review');

  const [diffPatch, setDiffPatch] = useState('');
  const [diffFingerprint, setDiffFingerprint] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const [review, setReview] = useState<ReviewJsonOutput | null>(null);
  const [staleReview, setStaleReview] = useState<ReviewJsonOutput | null>(null);
  const [runState, setRunState] = useState<RunBannerState | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const [severityFilter, setSeverityFilter] = useState<Set<IssueSeverity>>(
    () => new Set(SEVERITIES),
  );
  const [selectedIssueKey, setSelectedIssueKey] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<{ file: string; line: number | null } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  const logCleanupRef = useRef<(() => void) | null>(null);

  const diffFiles: DiffFile[] = useMemo(() => parseUnifiedDiff(diffPatch), [diffPatch]);
  const selectedWorkflowEntry = useMemo(
    () => workflows.find((workflow) => workflow.name === selectedWorkflow) ?? null,
    [selectedWorkflow, workflows],
  );
  const selectedWorkflowIsReview = isReviewWorkflow(selectedWorkflowDetail ?? selectedWorkflowEntry);
  const visibleRunHistory = useMemo(
    () =>
      runHistory.filter(
        (run) => run.project === workingDir && (!selectedWorkflow || run.workflow === selectedWorkflow),
      ),
    [runHistory, selectedWorkflow, workingDir],
  );
  const reviewStats = useMemo(() => summarizeReview(diffFiles, review), [diffFiles, review]);
  const visualResult = useMemo(
    () => runHistory.find((run) => run.project === workingDir && run.workflow.includes('visual'))?.result ?? null,
    [runHistory, workingDir],
  );

  // Subscribe to live workflow log events from the main process.
  useEffect(() => {
        const cleanup = window.drs.onWorkflowLog((event: WorkflowLogEvent) => {
      setRunState((cur) => {
        if (!cur || cur.runId !== event.runId) return cur;
        const logs = [...cur.logs, event.text];
        return { ...cur, logs: logs.slice(-200) };
      });
    });
    logCleanupRef.current = cleanup;
    return () => {
      cleanup();
      logCleanupRef.current = null;
    };
    }, []);

  const loadWorkflows = useCallback(async (dir: string) => {
    setWorkflowsLoading(true);
    setWorkflowsError(null);
    try {
      const list = await window.drs.listWorkflows(dir);
      setWorkflows(list);
      setSelectedWorkflow((cur) => {
        if (cur && list.some((workflow) => workflow.name === cur)) return cur;
        return defaultWorkflowSelection(list);
      });
    } catch (error) {
      setWorkflows([]);
      const message = `Could not list workflows: ${error instanceof Error ? error.message : String(error)}`;
      setWorkflowsError(message);
      setGlobalError(message);
    } finally {
      setWorkflowsLoading(false);
    }
  }, []);

  const loadDiff = useCallback(async (dir: string, useStaged: boolean) => {
    setDiffLoading(true);
    setDiffError(null);
    try {
      const result = await window.drs.getDiff(dir, { staged: useStaged });
      const fingerprint = hashString(result.patch);
      setDiffPatch(result.patch);
      setDiffFingerprint(fingerprint);
      setDiffSourceLabel(useStaged ? 'Local staged diff' : 'Local unstaged diff');
      return { patch: result.patch, fingerprint };
    } catch (error) {
      setDiffPatch('');
      setDiffFingerprint('');
      setDiffError(error instanceof Error ? error.message : String(error));
      return { patch: '', fingerprint: '' };
    } finally {
      setDiffLoading(false);
    }
  }, []);

  const loadReview = useCallback(async (dir: string, useStaged: boolean, fingerprint: string) => {
    const snapshot = readReviewSnapshot(dir, useStaged ? 'staged' : 'unstaged', fingerprint);
    if (snapshot) {
      setReview(snapshot.review);
      setStaleReview(null);
      return;
    }

    try {
      const artifact = await window.drs.getReviewArtifact(dir);
      setReview(null);
      setStaleReview(artifact);
    } catch {
      // A missing artifact is not a hard error; review simply shows as none.
      setReview(null);
      setStaleReview(null);
    }
  }, []);

  const rememberProject = useCallback((dir: string) => {
    setRecentProjects((cur) => {
      const next = [dir, ...cur.filter((item) => item !== dir)].slice(0, 8);
      localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // Boot: default to the DRS repo itself (the parent of desktop/) in dev.
  useEffect(() => {
    void (async () => {
      const cwd = await window.drs.getCwd();
      // In dev the Electron process is launched from desktop/, so the repo
      // root is one level up. Prefer it if it looks like the DRS repo.
      const guess = cwd.replace(/\/desktop\/?$/, '');
      const initial = guess && guess !== cwd ? guess : cwd;
      setWorkingDir(initial);
      rememberProject(initial);
      const [{ fingerprint }] = await Promise.all([loadDiff(initial, false), loadWorkflows(initial)]);
      await loadReview(initial, false, fingerprint);
    })();
  }, [loadDiff, loadReview, loadWorkflows, rememberProject]);

  useEffect(() => {
    if (!workingDir || !selectedWorkflow) {
      setSelectedWorkflowDetail(null);
      setWorkflowInputs({});
      return;
    }
    let cancelled = false;
    void window.drs.showWorkflow(selectedWorkflow, workingDir).then((detail) => {
      if (cancelled) return;
      setSelectedWorkflowDetail(detail);
      setWorkflowInputs(defaultWorkflowInputs(detail));
    });
    return () => {
      cancelled = true;
    };
  }, [selectedWorkflow, workingDir]);

  const handlePickDirectory = useCallback(async () => {
    const dir = await window.drs.selectDirectory();
    if (!dir) return;
    setShowProjectsHome(false);
    setWorkingDir(dir);
    rememberProject(dir);
    setReview(null);
    setStaleReview(null);
    setSelectedIssueKey(null);
    setScrollTarget(null);
    const [{ fingerprint }] = await Promise.all([loadDiff(dir, staged), loadWorkflows(dir)]);
    await loadReview(dir, staged, fingerprint);
  }, [loadDiff, loadReview, loadWorkflows, rememberProject, staged]);

  const handleSelectRecentProject = useCallback(
    async (dir: string) => {
      setShowProjectsHome(false);
      setWorkingDir(dir);
      rememberProject(dir);
      setReview(null);
      setStaleReview(null);
      setSelectedIssueKey(null);
      setScrollTarget(null);
      const [{ fingerprint }] = await Promise.all([loadDiff(dir, staged), loadWorkflows(dir)]);
      await loadReview(dir, staged, fingerprint);
    },
    [loadDiff, loadReview, loadWorkflows, rememberProject, staged],
  );

  const handleToggleStaged = useCallback(() => {
    setStaged((cur) => {
      const next = !cur;
      if (workingDir) {
        void (async () => {
          const { fingerprint } = await loadDiff(workingDir, next);
          await loadReview(workingDir, next, fingerprint);
        })();
      }
      return next;
    });
  }, [loadDiff, loadReview, workingDir]);

  const handleRefresh = useCallback(() => {
    if (workingDir) {
      void (async () => {
        const { fingerprint } = await loadDiff(workingDir, staged);
        await loadReview(workingDir, staged, fingerprint);
      })();
    }
  }, [loadDiff, loadReview, staged, workingDir]);

  const handleToggleLayout = useCallback(() => {
    setDiffLayout((cur) => (cur === 'split' ? 'unified' : 'split'));
  }, []);

  const startWorkflow = useCallback(
    async (name: string, inputs: Record<string, string>) => {
      if (!workingDir) return;
      setGlobalError(null);
      const runId = `${name}-${Date.now()}`;
      const targetAtStart: 'staged' | 'unstaged' = staged ? 'staged' : 'unstaged';
      const fingerprintAtStart = diffFingerprint;
      setRunState({ active: true, name, runId, logs: [], error: null });
      try {
        const response = await window.drs.runWorkflow({ name, inputs, workingDir, runId });
        setLastRunResult(response.result);
        if (name.includes('visual')) setReviewView('walkthrough');
        else if (isReviewWorkflowName(name)) setReviewView('diff');
        const remotePatch = patchFromWorkflowResult(response.result);
        let reviewFingerprint = fingerprintAtStart;
        let reviewTarget: 'staged' | 'unstaged' = targetAtStart;
        if (remotePatch) {
          setDiffPatch(remotePatch.patch);
          reviewFingerprint = hashString(remotePatch.patch);
          setDiffFingerprint(reviewFingerprint);
          setDiffSourceLabel(remotePatch.label);
          reviewTarget = 'unstaged';
        } else {
          // After any local workflow that may change the tree, reload the diff.
          const refreshed = await loadDiff(workingDir, staged);
          if (name.includes('fix-review-issues')) reviewFingerprint = refreshed.fingerprint;
        }
        if (response.reviewOutput) {
          setReview(response.reviewOutput);
          setStaleReview(null);
          writeReviewSnapshot({
            project: workingDir,
            target: reviewTarget,
            diffFingerprint: reviewFingerprint,
            timestamp: response.reviewOutput.timestamp ?? response.result.timestamp ?? new Date().toISOString(),
            workflow: name,
            review: response.reviewOutput,
          });
        }
        setRunState((cur) => (cur && cur.runId === runId ? { ...cur, active: false } : cur));
        appendRunHistory({
          id: runId,
          project: workingDir,
          workflow: name,
          timestamp: response.result.timestamp ?? new Date().toISOString(),
          status: 'success',
          inputs,
          result: response.result,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setRunState((cur) =>
          cur && cur.runId === runId ? { ...cur, active: false, error: message } : cur,
        );
        setGlobalError(message);
        appendRunHistory({
          id: runId,
          project: workingDir,
          workflow: name,
          timestamp: new Date().toISOString(),
          status: 'error',
          inputs,
          error: message,
        });
      }
    },
    [diffFingerprint, loadDiff, staged, workingDir],
  );

  const appendRunHistory = useCallback((entry: RunHistoryEntry) => {
    setRunHistory((cur) => {
      const next = [entry, ...cur].slice(0, 100);
      localStorage.setItem(RUN_HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const handleRunSelectedWorkflow = useCallback(() => {
    if (!selectedWorkflow) return;
    void startWorkflow(selectedWorkflow, workflowInputs);
  }, [selectedWorkflow, startWorkflow, workflowInputs]);

  const handleRunReview = useCallback(() => {
    void startWorkflow(REVIEW_WORKFLOW, { staged: String(staged) });
  }, [startWorkflow, staged]);

  const handleFixIssues = useCallback(() => {
    if (!review) return;
    const minSeverity = actionableMinSeverity(review);
    void startWorkflow(FIX_WORKFLOW, { staged: String(staged), fixSeverity: minSeverity });
  }, [review, startWorkflow, staged]);

  const handleRunVisualWalkthrough = useCallback(() => {
    void startWorkflow(VISUAL_WORKFLOW, { staged: String(staged) });
  }, [staged, startWorkflow]);

  const handleCancelWorkflow = useCallback(() => {
    if (runState?.runId) void window.drs.cancelWorkflow(runState.runId);
  }, [runState]);

  const handleDismissRun = useCallback(() => setRunState(null), []);

  const handleCopyMarkdown = useCallback(async () => {
    if (!review) return;
    try {
      await copyToClipboard(buildReviewMarkdown(review));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore clipboard errors
    }
  }, [review]);

  const handleToggleSeverity = useCallback((severity: IssueSeverity) => {
    setSeverityFilter((cur) => {
      const next = new Set(cur);
      if (next.has(severity)) next.delete(severity);
      else next.add(severity);
      return next;
    });
  }, []);

    const handleSelectIssue = useCallback((issue: ReviewIssue) => {
    const key = issue.line ? issueLineKey(issue.file, issue.line) : `${issue.file}:${issue.title}`;
    setSelectedIssueKey(key);
    setScrollTarget({ file: issue.file, line: issue.line ?? null });
    setSelectedFile(issue.file);
  }, []);

  const handleSelectFile = useCallback((file: string) => {
    setSelectedFile(file);
    setScrollTarget({ file, line: null });
  }, []);

  if (showProjectsHome) {
    return (
      <ProjectHome
        recentProjects={recentProjects}
        defaultProject={workingDir}
        onOpenProject={handlePickDirectory}
        onSelectProject={handleSelectRecentProject}
        onContinue={workingDir ? () => setShowProjectsHome(false) : undefined}
      />
    );
  }

  return (
    <div className="app">
      <main className="main">
        <ReviewHeader
          workingDir={workingDir}
          target={diffSourceLabel}
          workflow={selectedWorkflow}
          mode={projectMode}
          onModeChange={setProjectMode}
          running={!!runState?.active}
          stats={reviewStats}
          onBackToProjects={() => setShowProjectsHome(true)}
        />
        {globalError && <div className="error-banner">{globalError}</div>}
        {diffError && !globalError && (
          <div className="error-banner">Diff error: {diffError}</div>
        )}
        {workflowsError && !globalError && <div className="error-banner">{workflowsError}</div>}
        {projectMode === 'workflow' ? (
          <WorkflowWorkspace
            workflows={workflows}
            workflowsLoading={workflowsLoading}
            selectedWorkflow={selectedWorkflow}
            detail={selectedWorkflowDetail}
            inputs={workflowInputs}
            result={lastRunResult}
            runHistory={visibleRunHistory}
            running={!!runState?.active}
            workingDir={workingDir}
            onSelectWorkflow={setSelectedWorkflow}
            onInputChange={(key, value) => setWorkflowInputs((cur) => ({ ...cur, [key]: value }))}
            onRun={handleRunSelectedWorkflow}
          />
        ) : (
          <>
            <ReviewViewTabs view={reviewView} onChange={setReviewView} />
            <ReviewContextBar
              staged={staged}
              layout={diffLayout}
              diffLoading={diffLoading}
              running={!!runState?.active}
              workingDir={workingDir}
              target={diffSourceLabel}
              workflow={selectedWorkflowDetail ?? workflows.find((workflow) => workflow.name === selectedWorkflow) ?? null}
              onToggleStaged={handleToggleStaged}
              onToggleLayout={handleToggleLayout}
              onRefresh={handleRefresh}
            />
            {reviewView === 'overview' ? (
          <ReviewOverview
            stats={reviewStats}
            review={review}
            staleReview={staleReview}
            target={diffSourceLabel}
            workflow={selectedWorkflowDetail ?? workflows.find((workflow) => workflow.name === selectedWorkflow) ?? null}
            running={!!runState?.active}
            hasProject={!!workingDir}
            hasVisualWalkthrough={!!visualResult}
            onRunReview={handleRunReview}
            onRunVisualWalkthrough={handleRunVisualWalkthrough}
            onFixIssues={handleFixIssues}
            onOpenDiff={() => setReviewView('diff')}
          />
        ) : reviewView === 'walkthrough' ? (
          <VisualWalkthroughPanel
            result={visualResult}
            running={!!runState?.active}
            onGenerate={handleRunVisualWalkthrough}
          />
        ) : reviewView === 'diff' && selectedWorkflowIsReview ? (
          <div className="content">
            <FileTree
              files={diffFiles}
              selectedFile={selectedFile}
              onSelectFile={handleSelectFile}
            />
            <DiffView
              files={diffFiles}
              issues={review?.issues ?? []}
              layout={diffLayout}
              scrollTarget={scrollTarget}
              onIssueClick={handleSelectIssue}
            />
            <IssuesPanel
              review={review}
              selectedIssueKey={selectedIssueKey}
              severityFilter={severityFilter}
              onToggleSeverity={handleToggleSeverity}
              onSelectIssue={handleSelectIssue}
              onCopyMarkdown={handleCopyMarkdown}
            />
          </div>
        ) : (
          <GenericWorkflowResult result={lastRunResult} />
        )}
          </>
        )}
        <RunBanner
          state={runState}
          onCancel={handleCancelWorkflow}
          onDismiss={handleDismissRun}
        />
      </main>
    </div>
  );
}

function ReviewHeader({
  workingDir,
  target,
  workflow,
  mode,
  onModeChange,
  running,
  stats,
  onBackToProjects,
}: {
  workingDir: string | null;
  target: string;
  workflow: string | null;
  mode: ProjectMode;
  onModeChange: (mode: ProjectMode) => void;
  running: boolean;
  stats: ReviewStats;
  onBackToProjects: () => void;
}) {
  return (
    <div className="review-header">
      <div>
        <div className="review-kicker">DRS Review Cockpit</div>
        <div className="review-title">{target}</div>
        <div className="review-subtitle">{workingDir ?? 'No project selected'}</div>
      </div>
      <div className="review-header-meta">
        <Button variant="ghost" size="sm" onClick={onBackToProjects}>
          &lt;- Back to projects
        </Button>
        <Tabs value={mode} onValueChange={(value) => onModeChange(value as ProjectMode)}>
          <TabsList title="Switch project workspace mode">
            <TabsTrigger value="review">Review</TabsTrigger>
            <TabsTrigger value="workflow">Workflows</TabsTrigger>
          </TabsList>
        </Tabs>
        <ThemeToggle />
        <Badge variant="outline">{workflow ?? 'No workflow selected'}</Badge>
        <Badge variant="outline">{stats.filesChanged} files</Badge>
        <Badge variant={running ? 'secondary' : 'outline'}>{running ? 'Running' : 'Ready'}</Badge>
      </div>
    </div>
  );
}

function ProjectHome({
  recentProjects,
  defaultProject,
  onOpenProject,
  onSelectProject,
  onContinue,
}: {
  recentProjects: string[];
  defaultProject: string | null;
  onOpenProject: () => void;
  onSelectProject: (project: string) => void;
  onContinue?: () => void;
}) {
  const projects = recentProjects.length > 0 ? recentProjects : defaultProject ? [defaultProject] : [];
  return (
    <div className="projects-home">
      <Card className="projects-hero">
        <CardHeader className="p-0">
          <div className="projects-hero-top">
            <div className="review-kicker">DRS Desktop</div>
            <ThemeToggle />
          </div>
          <CardTitle className="projects-title">Choose a project to review</CardTitle>
          <CardDescription className="projects-description">
            Open a repository, inspect the current change, run DRS workflows, and use the
            review cockpit to understand, fix, verify, and explain agentic code changes.
          </CardDescription>
        </CardHeader>
        <CardContent className="projects-actions p-0">
          <Button onClick={onOpenProject}>Open Project...</Button>
          {onContinue && (
            <Button variant="outline" onClick={onContinue}>
              Continue Current Project
            </Button>
          )}
        </CardContent>
      </Card>

      <section className="projects-section">
        <div className="projects-section-title">
          <h2>Recent Projects</h2>
          <Badge variant="outline">{projects.length} available</Badge>
        </div>
        {projects.length === 0 ? (
          <Card className="projects-empty">
            No projects yet. Open a repository to start a DRS review session.
          </Card>
        ) : (
          <div className="project-grid">
            {projects.map((project) => (
              <Card key={project} asChild className="project-card">
                <button onClick={() => onSelectProject(project)}>
                  <Badge variant="secondary">Project</Badge>
                  <strong>{projectName(project)}</strong>
                  <code>{project}</code>
                </button>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function WorkflowWorkspace({
  workflows,
  workflowsLoading,
  selectedWorkflow,
  detail,
  inputs,
  result,
  runHistory,
  running,
  workingDir,
  onSelectWorkflow,
  onInputChange,
  onRun,
}: {
  workflows: WorkflowListEntry[];
  workflowsLoading: boolean;
  selectedWorkflow: string | null;
  detail: WorkflowDetail | null;
  inputs: Record<string, string>;
  result: WorkflowRunResultJson | null;
  runHistory: RunHistoryEntry[];
  running: boolean;
  workingDir: string | null;
  onSelectWorkflow: (workflow: string) => void;
  onInputChange: (key: string, value: string) => void;
  onRun: () => void;
}) {
  const projectWorkflows = workflows.filter((workflow) => workflow.source === 'project');
  const packagedWorkflows = workflows.filter((workflow) => workflow.source === 'packaged');
  return (
    <div className="workflow-workspace">
      <section className="workflow-browser">
        <div className="workflow-browser-head">
          <div>
            <div className="review-kicker">Workflow Mode</div>
            <h1>Run and inspect DRS workflows</h1>
          </div>
          <span>{workflows.length} workflows</span>
        </div>
        <WorkflowSection
          title="Project Workflows"
          description="Workflows defined by this repository. These override or extend packaged DRS behavior."
          workflows={projectWorkflows}
          loading={workflowsLoading}
          selectedWorkflow={selectedWorkflow}
          empty="No project workflows found in this repository."
          onSelectWorkflow={onSelectWorkflow}
        />
        <WorkflowSection
          title="Packaged Workflows"
          description="Built-in DRS workflows available to every project."
          workflows={packagedWorkflows}
          loading={workflowsLoading}
          selectedWorkflow={selectedWorkflow}
          empty="No packaged workflows available."
          onSelectWorkflow={onSelectWorkflow}
        />
      </section>

      <aside className="workflow-inspector">
        <Card className="workflow-inspector-card">
          <CardHeader className="p-0 pb-3">
            <div className="review-kicker">Selected Workflow</div>
            <CardTitle>{detail?.name ?? selectedWorkflow ?? 'No workflow selected'}</CardTitle>
            {detail?.description && <CardDescription>{detail.description}</CardDescription>}
          </CardHeader>
          <CardContent className="p-0">
            {selectedWorkflow && !detail && workflowsLoading ? (
              <div className="workflow-detail-skeleton">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : null}
            {detail && (
              <div className="workflow-node-summary">
                {detail.nodes.length} nodes{detail.output ? ` · output: ${detail.output}` : ''}
              </div>
            )}
            {detail && Object.entries(detail.inputs).map(([key, input]) => (
              <WorkflowInputField
                key={key}
                name={key}
                input={normalizeWorkflowInput(input)}
                value={inputs[key] ?? ''}
                onChange={(value) => onInputChange(key, value)}
              />
            ))}
            <Button
              className="w-full"
              disabled={!workingDir || running || !detail || hasMissingWorkflowInputs(detail, inputs)}
              onClick={onRun}
            >
              {running ? 'Running...' : 'Run Workflow'}
            </Button>
          </CardContent>
        </Card>

        <Card className="workflow-inspector-card">
          <div className="review-kicker">Latest Output</div>
          {result ? <pre>{JSON.stringify(result.output ?? result, null, 2)}</pre> : <p>No workflow output yet.</p>}
        </Card>

        <Card className="workflow-inspector-card">
          <div className="review-kicker">Runs</div>
          {runHistory.length === 0 ? <p>No runs yet for this workflow.</p> : runHistory.slice(0, 8).map((run) => (
            <div key={run.id} className={`workflow-run-row ${run.status}`}>
              <strong>{run.workflow}</strong>
              <span>{new Date(run.timestamp).toLocaleString()}</span>
            </div>
          ))}
        </Card>
      </aside>
    </div>
  );
}

function WorkflowSection({
  title,
  description,
  workflows,
  loading,
  selectedWorkflow,
  empty,
  onSelectWorkflow,
}: {
  title: string;
  description: string;
  workflows: WorkflowListEntry[];
  loading: boolean;
  selectedWorkflow: string | null;
  empty: string;
  onSelectWorkflow: (workflow: string) => void;
}) {
  return (
    <section className="workflow-section-block">
      <div className="workflow-section-title">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <Badge variant="outline">{loading ? 'Loading' : workflows.length}</Badge>
      </div>
      {loading ? (
        <div className="workflow-card-grid">
          {Array.from({ length: 4 }).map((_, index) => (
            <Card key={index} className="workflow-card-skeleton">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
            </Card>
          ))}
        </div>
      ) : workflows.length === 0 ? (
        <div className="workflow-section-empty">{empty}</div>
      ) : (
        <div className="workflow-card-grid">
          {workflows.map((workflow) => (
            <Card key={workflow.name} asChild className={`workflow-card ${selectedWorkflow === workflow.name ? 'active' : ''}`}>
              <button onClick={() => onSelectWorkflow(workflow.name)}>
                <Badge variant="secondary">{workflowIntentLabel(workflow)}</Badge>
                <strong>{workflow.name}</strong>
                {workflow.description && <p>{workflow.description}</p>}
              </button>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

function WorkflowInputField({
  name,
  input,
  value,
  onChange,
}: {
  name: string;
  input: WorkflowInputConfig;
  value: string;
  onChange: (value: string) => void;
}) {
  const type = input.type ?? 'string';
  const id = `workspace-wf-input-${name}`;
  if (type === 'boolean') {
    return (
      <div className="input-row">
        <label htmlFor={id}>
          <input id={id} type="checkbox" checked={value === 'true'} onChange={(event) => onChange(event.target.checked ? 'true' : 'false')} />
          {name}
        </label>
      </div>
    );
  }
  if (type === 'enum' && input.values) {
    return (
      <div className="input-row">
        <label htmlFor={id}>{name}</label>
        <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
          {input.values.map((item) => <option key={String(item)} value={String(item)}>{String(item)}</option>)}
        </select>
      </div>
    );
  }
  return (
    <div className="input-row">
      <label htmlFor={id}>{name}</label>
      <input id={id} type={type === 'number' ? 'number' : 'text'} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function ReviewViewTabs({ view, onChange }: { view: ReviewView; onChange: (view: ReviewView) => void }) {
  const tabs: Array<{ id: ReviewView; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'diff', label: 'Diff Review' },
    { id: 'walkthrough', label: 'Visual Walkthrough' },
    { id: 'output', label: 'Workflow Output' },
  ];
  return (
    <Tabs value={view} onValueChange={(value) => onChange(value as ReviewView)} className="review-tabs-shell">
      <TabsList className="review-tabs">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id}>{tab.label}</TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

type ReviewWorkflowSummary = {
  name: string;
  description?: string;
  source?: string;
  metadata?: {
    kind?: string;
    tags?: string[];
    review?: {
      source?: string;
      diff?: boolean;
      issues?: boolean;
    };
  };
};

function ReviewContextBar({
  staged,
  layout,
  diffLoading,
  running,
  workingDir,
  target,
  workflow,
  onToggleStaged,
  onToggleLayout,
  onRefresh,
}: {
  staged: boolean;
  layout: 'unified' | 'split';
  diffLoading: boolean;
  running: boolean;
  workingDir: string | null;
  target: string;
  workflow: ReviewWorkflowSummary | null;
  onToggleStaged: () => void;
  onToggleLayout: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="review-context-bar">
      <div className="review-context-copy">
        <span className="review-kicker">Review Target</span>
        <strong>{target}</strong>
        <span>{reviewWorkflowKind(workflow)} via {workflow?.name ?? 'no workflow selected'}</span>
      </div>
      <div className="review-context-controls">
        <div className="seg" title="Choose which local diff to review">
          <button className={!staged ? 'active' : ''} onClick={() => !staged || onToggleStaged()}>
            Unstaged
          </button>
          <button className={staged ? 'active' : ''} onClick={() => staged || onToggleStaged()}>
            Staged
          </button>
        </div>
        <Button variant="outline" onClick={onToggleLayout} disabled={running} title="Toggle unified/split diff layout">
          {layout === 'split' ? 'Split diff' : 'Unified diff'}
        </Button>
        <Button variant="outline" onClick={onRefresh} disabled={!workingDir || diffLoading || running} title="Reload the current diff">
          {diffLoading ? <span className="spinner" /> : 'Refresh diff'}
        </Button>
      </div>
    </div>
  );
}

interface ReviewStats {
  filesChanged: number;
  additions: number;
  deletions: number;
  issues: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

function ReviewOverview({
  stats,
  review,
  staleReview,
  target,
  workflow,
  running,
  hasProject,
  hasVisualWalkthrough,
  onRunReview,
  onRunVisualWalkthrough,
  onFixIssues,
  onOpenDiff,
}: {
  stats: ReviewStats;
  review: ReviewJsonOutput | null;
  staleReview: ReviewJsonOutput | null;
  target: string;
  workflow: ReviewWorkflowSummary | null;
  running: boolean;
  hasProject: boolean;
  hasVisualWalkthrough: boolean;
  onRunReview: () => void;
  onRunVisualWalkthrough: () => void;
  onFixIssues: () => void;
  onOpenDiff: () => void;
}) {
  const actionable = stats.critical + stats.high;
  const workflowName = workflow?.name ?? 'No review workflow selected';
  const workflowSource = workflow?.metadata?.review?.source ?? workflow?.source ?? 'local';
  const reviewKind = reviewWorkflowKind(workflow);
  return (
    <div className="overview-shell">
      <Card className="overview-hero">
        <CardHeader className="p-0">
          <div className="review-kicker">Review Session</div>
          <CardTitle>{review ? 'Review findings are ready' : 'Start by reviewing this change'}</CardTitle>
          <CardDescription>
            {staleReview && !review
              ? 'A previous review artifact exists, but it does not match the current diff. Run a new review to attach findings to this change.'
              : `This is a ${reviewKind.toLowerCase()} for ${target}, powered by ${workflowName}. DRS keeps workflows underneath, while this cockpit is optimized for understanding, triaging, fixing, and verifying agentic code changes.`}
          </CardDescription>
        </CardHeader>
        <div className="review-session-facts">
          <div>
            <span>Workflow</span>
            <strong>{workflowName}</strong>
          </div>
          <div>
            <span>Review source</span>
            <strong>{workflowSource}</strong>
          </div>
          <div>
            <span>Diff target</span>
            <strong>{target}</strong>
          </div>
        </div>
        <div className="overview-actions">
          <Button disabled={!hasProject || running} onClick={onRunReview}>
            Run Review
          </Button>
          <Button variant="outline" disabled={!hasProject || running} onClick={onRunVisualWalkthrough}>
            {hasVisualWalkthrough ? 'Regenerate Walkthrough' : 'Generate Walkthrough'}
          </Button>
          <Button variant="outline" disabled={!hasProject || running || actionable === 0} onClick={onFixIssues}>
            Fix High+{actionable ? ` (${actionable})` : ''}
          </Button>
        </div>
      </Card>
      <section className="overview-grid">
        <OverviewCard label="Changed Files" value={stats.filesChanged} detail={`+${stats.additions} / -${stats.deletions}`} />
        <OverviewCard label="Findings" value={stats.issues} detail="from latest DRS review" />
        <OverviewCard label="Critical / High" value={actionable} detail={`${stats.critical} critical, ${stats.high} high`} />
        <OverviewCard label="Medium / Low" value={stats.medium + stats.low} detail={`${stats.medium} medium, ${stats.low} low`} />
      </section>
      <Card className="review-next-step">
        <CardTitle>Suggested next step</CardTitle>
        {staleReview && !review ? (
          <p>The saved review is stale for this diff. Run Review to create a current snapshot.</p>
        ) : review ? (
          <p>{actionable > 0 ? 'Fix high-impact findings, then re-run the review.' : 'Open the diff or generate a visual walkthrough for reviewer context.'}</p>
        ) : (
          <p>Run a DRS review to get inline findings and a triage queue for this change.</p>
        )}
        <Button variant="outline" onClick={onOpenDiff}>Open Diff Review</Button>
      </Card>
    </div>
  );
}

function OverviewCard({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <Card className="overview-card">
      <div>{label}</div>
      <strong>{value}</strong>
      <span>{detail}</span>
    </Card>
  );
}

function VisualWalkthroughPanel({
  result,
  running,
  onGenerate,
}: {
  result: WorkflowRunResultJson | null;
  running: boolean;
  onGenerate: () => void;
}) {
  const html = visualHtmlFromResult(result);
  return (
    <div className="visual-panel">
      <Card className="visual-empty">
        <div className="review-kicker">Visual Walkthrough</div>
        <CardTitle>{result ? 'Walkthrough artifact generated' : 'No visual walkthrough yet'}</CardTitle>
        <CardDescription>
          Generate an HTML explainer that walks reviewers through the change at a higher level
          than the raw diff. Artifact rendering will be wired here next.
        </CardDescription>
        <Button disabled={running} onClick={onGenerate}>
          {result ? 'Regenerate Visual Walkthrough' : 'Generate Visual Walkthrough'}
        </Button>
      </Card>
      {html ? (
        <iframe
          className="visual-artifact-frame"
          title="DRS visual walkthrough artifact"
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          srcDoc={html}
        />
      ) : result ? (
        <pre>{JSON.stringify(result.output ?? result.artifacts, null, 2)}</pre>
      ) : null}
    </div>
  );
}

function GenericWorkflowResult({ result }: { result: WorkflowRunResultJson | null }) {
  return (
    <div className="generic-result">
      <h2>Workflow Output</h2>
      {result ? (
        <pre>{JSON.stringify(result, null, 2)}</pre>
      ) : (
        <div className="muted">Select and run a workflow to inspect its result.</div>
      )}
    </div>
  );
}

/** Determine the lowest actionable severity present, for the fix workflow input. */
function actionableMinSeverity(review: ReviewJsonOutput): string {
  if (review.summary.bySeverity.CRITICAL > 0) return severityToInput('CRITICAL');
  if (review.summary.bySeverity.HIGH > 0) return severityToInput('HIGH');
  // Defensive: the Fix button is only enabled when actionable counts exist,
  // but keep a sane default if invoked another way.
  return 'high';
}

function patchFromWorkflowResult(
  result: WorkflowRunResultJson,
): { patch: string; label: string } | null {
  const change = result.artifacts.change;
  if (!change?.filesWithDiffs?.length) return null;
  const patch = change.filesWithDiffs
    .map(({ filename, patch: filePatch }) => normalizeFilePatch(filename, filePatch))
    .join('\n');
  if (!patch.trim()) return null;
  return { patch, label: change.name || result.workflow };
}

function visualHtmlFromResult(result: WorkflowRunResultJson | null): string | null {
  if (!result) return null;
  if (typeof result.output === 'string' && result.output.trimStart().startsWith('<!DOCTYPE html>')) {
    return result.output;
  }
  const visualOutput = result.artifacts.visualExplainer;
  if (typeof visualOutput === 'string' && visualOutput.trimStart().startsWith('<!DOCTYPE html>')) {
    return visualOutput;
  }
  return null;
}

function normalizeFilePatch(filename: string, patch: string): string {
  if (patch.startsWith('diff --git ')) return patch.trimEnd();
  const header = [`diff --git a/${filename} b/${filename}`, `--- a/${filename}`, `+++ b/${filename}`];
  return `${header.join('\n')}\n${patch.trimEnd()}`;
}

function isReviewWorkflow(workflow: { metadata?: { kind?: string; tags?: string[] } } | null): boolean {
  return workflow?.metadata?.kind === 'review' || workflow?.metadata?.tags?.includes('review') || false;
}

function defaultWorkflowSelection(workflows: WorkflowListEntry[]): string | null {
  return (
    workflows.find((workflow) => workflow.name === REVIEW_WORKFLOW)?.name ??
    workflows.find((workflow) => workflow.metadata?.review?.source === 'local' && workflow.name.includes('review'))?.name ??
    workflows.find((workflow) => isReviewWorkflow(workflow))?.name ??
    workflows[0]?.name ??
    null
  );
}

function isReviewWorkflowName(name: string): boolean {
  return name.includes('review') || name.includes('fix-review-issues');
}

function summarizeReview(files: DiffFile[], review: ReviewJsonOutput | null): ReviewStats {
  return {
    filesChanged: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    issues: review?.summary.issuesFound ?? 0,
    critical: review?.summary.bySeverity.CRITICAL ?? 0,
    high: review?.summary.bySeverity.HIGH ?? 0,
    medium: review?.summary.bySeverity.MEDIUM ?? 0,
    low: review?.summary.bySeverity.LOW ?? 0,
  };
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function projectName(project: string): string {
  return project.split('/').filter(Boolean).pop() ?? project;
}

function workflowIntentLabel(workflow: WorkflowListEntry): string {
  if (workflow.name.includes('visual')) return 'visual';
  if (workflow.name.includes('fix-review')) return 'fix';
  if (workflow.name.includes('review')) return 'review';
  if (workflow.name.includes('changelog')) return 'changelog';
  if (workflow.name.includes('agents')) return 'guidance';
  return workflow.source;
}

function reviewWorkflowKind(workflow: ReviewWorkflowSummary | null): string {
  const source = workflow?.metadata?.review?.source ?? workflow?.source;
  if (source === 'github') return 'GitHub pull request review';
  if (source === 'gitlab') return 'GitLab merge request review';
  if (source === 'local') return 'Local diff review';
  if (workflow?.metadata?.kind === 'review') return 'Review';
  return 'Local diff review';
}

function normalizeWorkflowInput(input: WorkflowInputConfig): WorkflowInputConfig {
  if (typeof input === 'string') return { type: 'string', default: input };
  return input;
}

function hasMissingWorkflowInputs(detail: WorkflowDetail, inputs: Record<string, string>): boolean {
  return Object.entries(detail.inputs).some(([key, input]) => {
    if (typeof input === 'string' || !input.required) return false;
    return !inputs[key]?.trim();
  });
}

function defaultWorkflowInputs(detail: WorkflowDetail): Record<string, string> {
  const defaults: Record<string, string> = {};
  for (const [key, input] of Object.entries(detail.inputs)) {
    if (typeof input === 'string') defaults[key] = input;
    else if (input.type === 'boolean') defaults[key] = input.default === true ? 'true' : 'false';
    else if (input.default !== undefined && input.default !== null) defaults[key] = String(input.default);
    else defaults[key] = '';
  }
  return defaults;
}

function reviewSnapshotKey(project: string, target: 'staged' | 'unstaged', diffFingerprint: string): string {
  return `${project}::${target}::${diffFingerprint}`;
}

function readReviewSnapshots(): Record<string, ReviewSnapshot> {
  try {
    const parsed = JSON.parse(localStorage.getItem(REVIEW_SNAPSHOTS_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readReviewSnapshot(
  project: string,
  target: 'staged' | 'unstaged',
  diffFingerprint: string,
): ReviewSnapshot | null {
  if (!diffFingerprint) return null;
  return readReviewSnapshots()[reviewSnapshotKey(project, target, diffFingerprint)] ?? null;
}

function writeReviewSnapshot(snapshot: ReviewSnapshot): void {
  const snapshots = readReviewSnapshots();
  snapshots[reviewSnapshotKey(snapshot.project, snapshot.target, snapshot.diffFingerprint)] = snapshot;
  const recent = Object.fromEntries(
    Object.entries(snapshots)
      .sort(([, a], [, b]) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 50),
  );
  localStorage.setItem(REVIEW_SNAPSHOTS_KEY, JSON.stringify(recent));
}

function readStringArray(key: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function readRunHistory(): RunHistoryEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RUN_HISTORY_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
