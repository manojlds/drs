import { useEffect, useRef } from 'react';
import { FileDiff, type DiffLineAnnotation } from '@pierre/diffs/react';
import { useTheme } from './theme-provider';
import {
  buildIssueLineIndex,
  fileDomId,
  lineDomId,
  type DiffLayout,
  type DiffFile,
  type IssueLineIndex,
} from '../lib/diff';
import { CATEGORY_EMOJI, SEVERITY_CLASS, SEVERITY_EMOJI } from '../lib/badges';
import type { ReviewIssue } from '../types';

interface DiffViewProps {
  files: DiffFile[];
  issues: ReviewIssue[];
  layout: DiffLayout;
  scrollTarget: { file: string; line: number | null } | null;
  onIssueClick: (issue: ReviewIssue) => void;
}

type IssueAnnotation = { issue: ReviewIssue };

const STATUS_LABEL: Record<DiffFile['status'], string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
  untracked: '?',
};

export function DiffView({ files, issues, layout, scrollTarget, onIssueClick }: DiffViewProps) {
  const index: IssueLineIndex = buildIssueLineIndex(issues);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();

  // Scroll the targeted line into view when the selection changes.
  useEffect(() => {
    if (!scrollTarget) return;
    const fileEl = document.getElementById(fileDomId(scrollTarget.file));
    if (!fileEl) return;
    if (scrollTarget.line) {
      const lineEl = document.getElementById(lineDomId(scrollTarget.file, scrollTarget.line, null));
      if (lineEl) {
        lineEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      const pierreLine = findPierreLine(fileEl, scrollTarget.line);
      if (pierreLine) {
        pierreLine.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
    }
    fileEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [scrollTarget]);

  if (files.length === 0) {
    return (
      <div className="diff-pane">
        <div className="diff-empty">
          <div style={{ fontSize: 28 }}>∅</div>
          <div>No changes in the {STATUS_LABEL.modified ? 'selected' : ''} diff.</div>
          <div className="muted">
            Make a change or switch between Unstaged / Staged, then Refresh.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="diff-pane" ref={scrollRef}>
      {files.map((file) => (
        <FileSection
          key={file.path}
          file={file}
          index={index}
          layout={layout}
          theme={resolvedTheme}
          onIssueClick={onIssueClick}
          scrollTarget={scrollTarget}
        />
      ))}
    </div>
  );
}

interface FileSectionProps {
  file: DiffFile;
  index: IssueLineIndex;
  layout: DiffLayout;
  theme: 'light' | 'dark';
  onIssueClick: (issue: ReviewIssue) => void;
  scrollTarget: { file: string; line: number | null } | null;
}

function FileSection({ file, index, layout, theme, onIssueClick, scrollTarget }: FileSectionProps) {
  const generalIssues = index.general.get(file.path) ?? [];
  const annotations = buildAnnotations(file, index);
  const selectedLines =
    scrollTarget?.file === file.path && scrollTarget.line
      ? { start: scrollTarget.line, end: scrollTarget.line, side: 'additions' as const }
      : null;

  return (
    <div className="diff-file" id={fileDomId(file.path)}>
      <div className="diff-file-header">
        <span className={`file-status status-${file.status}`}>
          {STATUS_LABEL[file.status]}
        </span>
        <span className="file-path">{file.path}</span>
        <span className="file-counts">
          <span className="add-count">+{file.additions}</span>
          <span className="del-count">−{file.deletions}</span>
        </span>
      </div>

      {file.metadata ? (
        <div className="pierre-diff-wrap">
          <FileDiff<IssueAnnotation>
            fileDiff={file.metadata}
            disableWorkerPool
            lineAnnotations={annotations}
            selectedLines={selectedLines}
            options={{
              diffStyle: layout,
              disableFileHeader: true,
              hunkSeparators: 'line-info-basic',
              lineDiffType: 'word',
              overflow: 'scroll',
              theme: theme === 'dark' ? 'github-dark' : 'github-light',
              themeType: theme,
            }}
            renderAnnotation={(annotation) => (
              <InlineIssue
                issue={annotation.metadata.issue}
                onClick={() => onIssueClick(annotation.metadata.issue)}
              />
            )}
          />
          {generalIssues.map((issue) => (
            <InlineIssue
              key={`${file.path}:general:${issue.title}`}
              issue={issue}
              onClick={() => onIssueClick(issue)}
            />
          ))}
        </div>
      ) : file.binary ? (
        <div style={{ padding: '12px', color: 'var(--text-muted)', fontSize: 12 }}>
          Binary file — no text diff.
        </div>
      ) : (
        <div className="diff-table">
          {file.hunks.map((hunk, hi) => (
            <div key={hi}>
              <div className="hunk-meta">
                @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
              </div>
              {hunk.lines.map((line, li) => {
                const issueList =
                  line.newLine !== null
                    ? index.byFileLine.get(`${file.path}:${line.newLine}`) ?? []
                    : [];
                const isTarget =
                  scrollTarget?.file === file.path &&
                  scrollTarget?.line !== null &&
                  scrollTarget?.line === line.newLine;
                return (
                  <div key={li}>
                    <div
                      id={lineDomId(file.path, line.newLine, line.oldLine)}
                      className={`line ${line.type}${isTarget ? ' target' : ''}`}
                    >
                      <span className="gutter">
                        {line.oldLine !== null ? line.oldLine : ''}
                      </span>
                      <span className="gutter">
                        {line.newLine !== null ? line.newLine : ''}
                      </span>
                      <span className="line-content">{line.text}</span>
                    </div>
                    {issueList.map((issue) => (
                      <InlineIssue
                        key={`${file.path}:${line.newLine}:${issue.title}`}
                        issue={issue}
                        onClick={() => onIssueClick(issue)}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
          {generalIssues.map((issue) => (
            <InlineIssue
              key={`${file.path}:general:${issue.title}`}
              issue={issue}
              onClick={() => onIssueClick(issue)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function findPierreLine(fileEl: HTMLElement, line: number): HTMLElement | null {
  const container = fileEl.querySelector('diffs-container') as HTMLElement & {
    shadowRoot?: ShadowRoot | null;
  } | null;
  const root = container?.shadowRoot;
  if (!root) return null;
  return root.querySelector(
    `[data-line="${line}"][data-line-type="change-addition"], [data-line="${line}"][data-line-type="context"], [data-line="${line}"][data-line-type="context-expanded"]`,
  );
}

function buildAnnotations(
  file: DiffFile,
  index: IssueLineIndex,
): DiffLineAnnotation<IssueAnnotation>[] {
  if (!file.metadata) return [];
  const annotations: DiffLineAnnotation<IssueAnnotation>[] = [];
  for (const [key, issues] of index.byFileLine.entries()) {
    const separator = key.lastIndexOf(':');
    if (separator === -1) continue;
    const path = key.slice(0, separator);
    if (path !== file.path) continue;
    const lineNumber = Number(key.slice(separator + 1));
    if (!Number.isFinite(lineNumber)) continue;
    for (const issue of issues) {
      annotations.push({ side: 'additions', lineNumber, metadata: { issue } });
    }
  }
  return annotations;
}

function InlineIssue({
  issue,
  onClick,
}: {
  issue: ReviewIssue;
  onClick: () => void;
}) {
  return (
    <div className="line-issue" onClick={onClick}>
      <div className="li-top">
        <span className={`sev-badge ${SEVERITY_CLASS[issue.severity]}`}>
          {SEVERITY_EMOJI[issue.severity]} {issue.severity}
        </span>
        <span className="li-title">{issue.title}</span>
      </div>
      <div className="li-body">
        {CATEGORY_EMOJI[issue.category]} {issue.problem}
      </div>
    </div>
  );
}
