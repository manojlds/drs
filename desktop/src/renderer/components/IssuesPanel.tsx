import { CATEGORY_EMOJI, SEVERITIES, SEVERITY_CLASS, SEVERITY_EMOJI } from '../lib/badges';
import { issueLineKey } from '../lib/diff';
import type { IssueSeverity, ReviewIssue, ReviewJsonOutput } from '../types';

interface IssuesPanelProps {
  review: ReviewJsonOutput | null;
  selectedIssueKey: string | null;
  severityFilter: Set<IssueSeverity>;
  onToggleSeverity: (severity: IssueSeverity) => void;
  onSelectIssue: (issue: ReviewIssue) => void;
  onCopyMarkdown: () => void;
}

export function IssuesPanel({
  review,
  selectedIssueKey,
  severityFilter,
  onToggleSeverity,
  onSelectIssue,
  onCopyMarkdown,
}: IssuesPanelProps) {
  return (
    <aside className="issues-pane">
      <div className="issues-pane-header">
        <strong>Issues</strong>
        {review && (
          <span className="muted" style={{ fontSize: 11 }}>
            {review.summary.issuesFound} found · {review.summary.filesReviewed} files
          </span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          <button
            className="btn"
            onClick={onCopyMarkdown}
            disabled={!review || review.issues.length === 0}
            style={{ padding: '4px 9px', fontSize: 11 }}
          >
            ⧉ MD
          </button>
        </span>
      </div>

      <div className="issues-pane-scroll">
        {!review && (
          <div className="muted" style={{ padding: '16px 4px', fontSize: 12 }}>
            No review loaded yet. Click <strong>Run Review</strong> in the toolbar to analyze the
            current diff with DRS agents.
          </div>
        )}

        {review && (
          <>
            <div className="sev-chips">
              {SEVERITIES.map((sev) => {
                const count = review.summary.bySeverity[sev];
                const active = severityFilter.has(sev);
                return (
                  <span
                    key={sev}
                    className={`sev-chip${active ? ' active' : ''}`}
                    onClick={() => onToggleSeverity(sev)}
                    style={{ opacity: count === 0 && !active ? 0.5 : 1 }}
                  >
                    {SEVERITY_EMOJI[sev]} {sev.slice(0, 1)} {count}
                  </span>
                );
              })}
            </div>

            <IssueList
              issues={review.issues}
              severityFilter={severityFilter}
              selectedIssueKey={selectedIssueKey}
              onSelectIssue={onSelectIssue}
            />
          </>
        )}
      </div>
    </aside>
  );
}

function IssueList({
  issues,
  severityFilter,
  selectedIssueKey,
  onSelectIssue,
}: {
  issues: ReviewIssue[];
  severityFilter: Set<IssueSeverity>;
  selectedIssueKey: string | null;
  onSelectIssue: (issue: ReviewIssue) => void;
}) {
  const filtered = issues.filter((i) => severityFilter.has(i.severity));
  if (filtered.length === 0) {
    return (
      <div className="muted" style={{ padding: '12px 4px', fontSize: 12 }}>
        No issues match the current severity filter.
      </div>
    );
  }

  return (
    <>
      {filtered.map((issue) => {
        const key = issue.line ? issueLineKey(issue.file, issue.line) : `${issue.file}:${issue.title}`;
        return (
          <IssueCard
            key={key}
            issue={issue}
            selected={selectedIssueKey === key}
            onClick={() => onSelectIssue(issue)}
          />
        );
      })}
    </>
  );
}

function IssueCard({
  issue,
  selected,
  onClick,
}: {
  issue: ReviewIssue;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <div className={`issue-card${selected ? ' selected' : ''}`} onClick={onClick}>
      <div className="issue-top">
        <span className={`sev-badge ${SEVERITY_CLASS[issue.severity]}`}>
          {SEVERITY_EMOJI[issue.severity]} {issue.severity}
        </span>
        <span className="issue-meta">
          {CATEGORY_EMOJI[issue.category]} {issue.category}
        </span>
      </div>
      <div className="issue-title">{issue.title}</div>
      <div className="issue-loc">
        {issue.file}
        {issue.line ? `:${issue.line}` : ''}
      </div>
      <div className="issue-problem">{issue.problem}</div>
      <div className="issue-meta">
        <span>agent: {issue.agent}</span>
      </div>
    </div>
  );
}
