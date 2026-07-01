import type { ReviewJsonOutput } from '../types';
import type { DiffLayout } from '../lib/diff';

interface ToolbarProps {
  workingDir: string | null;
  staged: boolean;
  layout: DiffLayout;
  running: boolean;
  review: ReviewJsonOutput | null;
  diffLoading: boolean;
  onToggleStaged: () => void;
  onToggleLayout: () => void;
  onRefresh: () => void;
  onRunReview: () => void;
  onRunVisualWalkthrough: () => void;
  onFixIssues: () => void;
  onCopyMarkdown: () => void;
  copied: boolean;
}

export function Toolbar(props: ToolbarProps) {
  const { workingDir, staged, running, review, diffLoading, copied } = props;
  const hasReview = !!review && review.issues.length > 0;
  const actionableCount = review
    ? review.summary.bySeverity.CRITICAL + review.summary.bySeverity.HIGH
    : 0;

  return (
    <div className="toolbar">
      <div className="seg" title="Diff source">
        <button
          className={!staged ? 'active' : ''}
          onClick={() => !staged || props.onToggleStaged()}
        >
          Unstaged
        </button>
        <button
          className={staged ? 'active' : ''}
          onClick={() => staged || props.onToggleStaged()}
        >
          Staged
        </button>
      </div>

      <button
        className="btn"
        onClick={props.onToggleLayout}
        disabled={running}
        title="Toggle unified/split diff layout"
      >
        {props.layout === 'split' ? 'Split' : 'Unified'}
      </button>

      <button
        className="btn"
        onClick={props.onRefresh}
        disabled={!workingDir || diffLoading || running}
        title="Reload the diff"
      >
        {diffLoading ? <span className="spinner" /> : '↻'} Refresh
      </button>

      <button
        className="btn btn-primary"
        onClick={props.onRunReview}
        disabled={!workingDir || running}
        title="Run the local-review workflow with DRS agents"
      >
        {running ? <span className="spinner" /> : '🔍'} Run Review
      </button>

      <button
        className="btn"
        onClick={props.onRunVisualWalkthrough}
        disabled={!workingDir || running}
        title="Generate a visual walkthrough artifact for the current review target"
      >
        Visual Walkthrough
      </button>

      <button
        className="btn"
        onClick={props.onFixIssues}
        disabled={!workingDir || running || actionableCount === 0}
        title={
          actionableCount > 0
            ? `Run local-fix-review-issues for CRITICAL/HIGH findings (${actionableCount})`
            : 'Fix is enabled once CRITICAL/HIGH findings exist'
        }
      >
        🛠️ Fix ≥ High{actionableCount > 0 ? ` (${actionableCount})` : ''}
      </button>

      <span className="spacer" />

      {running && (
        <span className="muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <span className="status-dot running" /> working…
        </span>
      )}

      <button
        className="btn"
        onClick={props.onCopyMarkdown}
        disabled={!hasReview}
        title="Copy the review as Markdown"
      >
        {copied ? '✓ Copied' : '⧉ Copy MD'}
      </button>
    </div>
  );
}
