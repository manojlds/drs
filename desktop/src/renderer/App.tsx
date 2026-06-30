import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DiffView } from './components/DiffView';
import { IssuesPanel } from './components/IssuesPanel';
import { Sidebar } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import type { RunBannerState } from './components/RunBanner';
import { SEVERITIES, severityToInput } from './lib/badges';
import { buildReviewMarkdown, copyToClipboard } from './lib/markdown';
import { parseUnifiedDiff, type DiffFile, issueLineKey } from './lib/diff';
import type {
  IssueSeverity,
  ReviewIssue,
  ReviewJsonOutput,
  WorkflowListEntry,
  WorkflowLogEvent,
} from './types';

const REVIEW_WORKFLOW = 'local-review';
const FIX_WORKFLOW = 'local-fix-review-issues';

export function App() {
  const [workingDir, setWorkingDir] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowListEntry[]>([]);
  const [staged, setStaged] = useState(false);

  const [diffPatch, setDiffPatch] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const [review, setReview] = useState<ReviewJsonOutput | null>(null);
  const [runState, setRunState] = useState<RunBannerState | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const [severityFilter, setSeverityFilter] = useState<Set<IssueSeverity>>(
    () => new Set(SEVERITIES),
  );
  const [selectedIssueKey, setSelectedIssueKey] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<{ file: string; line: number | null } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  const logCleanupRef = useRef<(() => void) | null>(null);

  const diffFiles: DiffFile[] = useMemo(() => parseUnifiedDiff(diffPatch), [diffPatch]);

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
    try {
      const list = await window.drs.listWorkflows(dir);
      setWorkflows(list);
    } catch (error) {
      setWorkflows([]);
      setGlobalError(
        `Could not list workflows: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, []);

  const loadDiff = useCallback(async (dir: string, useStaged: boolean) => {
    setDiffLoading(true);
    setDiffError(null);
    try {
      const result = await window.drs.getDiff(dir, { staged: useStaged });
      setDiffPatch(result.patch);
    } catch (error) {
      setDiffPatch('');
      setDiffError(error instanceof Error ? error.message : String(error));
    } finally {
      setDiffLoading(false);
    }
  }, []);

  const loadReview = useCallback(async (dir: string) => {
    try {
      const artifact = await window.drs.getReviewArtifact(dir);
      setReview(artifact);
    } catch {
      // A missing artifact is not a hard error; review simply shows as none.
      setReview(null);
    }
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
      await Promise.all([loadWorkflows(initial), loadDiff(initial, false), loadReview(initial)]);
    })();
  }, [loadDiff, loadReview, loadWorkflows]);

  const handlePickDirectory = useCallback(async () => {
    const dir = await window.drs.selectDirectory();
    if (!dir) return;
    setWorkingDir(dir);
    setReview(null);
    setSelectedIssueKey(null);
    setScrollTarget(null);
    await Promise.all([loadWorkflows(dir), loadDiff(dir, staged), loadReview(dir)]);
  }, [loadDiff, loadReview, loadWorkflows, staged]);

  const handleToggleStaged = useCallback(() => {
    setStaged((cur) => {
      const next = !cur;
      if (workingDir) void loadDiff(workingDir, next);
      return next;
    });
  }, [loadDiff, workingDir]);

  const handleRefresh = useCallback(() => {
    if (workingDir) void loadDiff(workingDir, staged);
  }, [loadDiff, staged, workingDir]);

  const startWorkflow = useCallback(
    async (name: string, inputs: Record<string, string>) => {
      if (!workingDir) return;
      setGlobalError(null);
      const runId = `${name}-${Date.now()}`;
      setRunState({ active: true, name, runId, logs: [], error: null });
      try {
        const response = await window.drs.runWorkflow({ name, inputs, workingDir, runId });
        if (response.reviewOutput) setReview(response.reviewOutput);
        // After any workflow that may change the tree, reload the diff.
        await loadDiff(workingDir, staged);
        setRunState((cur) => (cur && cur.runId === runId ? { ...cur, active: false } : cur));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setRunState((cur) =>
          cur && cur.runId === runId ? { ...cur, active: false, error: message } : cur,
        );
        setGlobalError(message);
      }
    },
    [loadDiff, staged, workingDir],
  );

  const handleRunReview = useCallback(() => {
    void startWorkflow(REVIEW_WORKFLOW, { staged: String(staged) });
  }, [startWorkflow, staged]);

  const handleFixIssues = useCallback(() => {
    if (!review) return;
    const minSeverity = actionableMinSeverity(review);
    void startWorkflow(FIX_WORKFLOW, { staged: String(staged), fixSeverity: minSeverity });
  }, [review, startWorkflow, staged]);

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
  }, []);

  return (
    <div className="app">
      <Sidebar
        workingDir={workingDir}
        workflows={workflows}
        runState={runState}
        onPickDirectory={handlePickDirectory}
        onRunWorkflow={startWorkflow}
        onCancelWorkflow={handleCancelWorkflow}
        onDismissRun={handleDismissRun}
      />
      <main className="main">
        <Toolbar
          workingDir={workingDir}
          staged={staged}
          running={!!runState?.active}
          review={review}
          diffLoading={diffLoading}
          onToggleStaged={handleToggleStaged}
          onRefresh={handleRefresh}
          onRunReview={handleRunReview}
          onFixIssues={handleFixIssues}
          onCopyMarkdown={handleCopyMarkdown}
          copied={copied}
        />
        {globalError && <div className="error-banner">{globalError}</div>}
        {diffError && !globalError && (
          <div className="error-banner">Diff error: {diffError}</div>
        )}
        <div className="content">
          <DiffView
            files={diffFiles}
            issues={review?.issues ?? []}
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
      </main>
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


