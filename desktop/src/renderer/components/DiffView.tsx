import { useEffect, useMemo, useRef, useState } from 'react';
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
  selectedFile: string | null;
  scrollTarget: { file: string; line: number | null } | null;
  onIssueClick: (issue: ReviewIssue) => void;
  onLoadFilePatch: (path: string) => void;
}

type IssueAnnotation = { issue: ReviewIssue };

const STATUS_LABEL: Record<DiffFile['status'], string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
  untracked: '?',
};

const INITIAL_VISIBLE_FILES = 25;
const LOAD_MORE_FILES = 25;
const EMPTY_ANNOTATIONS: DiffLineAnnotation<IssueAnnotation>[] = [];

export function DiffView({
  files,
  issues,
  layout,
  selectedFile,
  scrollTarget,
  onIssueClick,
  onLoadFilePatch,
}: DiffViewProps) {
  const [visibleFileCount, setVisibleFileCount] = useState(INITIAL_VISIBLE_FILES);
  const index: IssueLineIndex = useMemo(() => buildIssueLineIndex(issues), [issues]);
  const annotationsByFile = useMemo(() => buildAnnotationsByFile(index), [index]);
  const visibleFiles = useMemo(() => {
    if (files.length <= visibleFileCount) return files;
    const visible = files.slice(0, visibleFileCount);
    const targetFile = scrollTarget?.file ?? selectedFile;
    if (targetFile && !visible.some((file) => file.path === targetFile)) {
      const target = files.find((file) => file.path === targetFile);
      if (target) return [...visible, target];
    }
    return visible;
  }, [files, scrollTarget, selectedFile, visibleFileCount]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    setVisibleFileCount(INITIAL_VISIBLE_FILES);
  }, [files]);

  useEffect(() => {
    for (const file of visibleFiles) {
      if (!file.patchLoaded && !file.loading && !file.error) onLoadFilePatch(file.path);
    }
  }, [onLoadFilePatch, visibleFiles]);

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
      {visibleFiles.map((file) => (
        <FileSection
          key={file.path}
          file={file}
          index={index}
          annotations={annotationsByFile.get(file.path) ?? EMPTY_ANNOTATIONS}
          layout={layout}
          theme={resolvedTheme}
          onIssueClick={onIssueClick}
          scrollTarget={scrollTarget}
        />
      ))}
      {visibleFiles.length < files.length && (
        <div className="diff-load-more">
          <button
            type="button"
            className="diff-load-more-button"
            onClick={() => setVisibleFileCount((count) => count + LOAD_MORE_FILES)}
          >
            Show {Math.min(LOAD_MORE_FILES, files.length - visibleFiles.length)} more files
          </button>
          <span className="muted">
            Rendering {visibleFiles.length} of {files.length} changed files
          </span>
        </div>
      )}
    </div>
  );
}

interface FileSectionProps {
  file: DiffFile;
  index: IssueLineIndex;
  annotations: DiffLineAnnotation<IssueAnnotation>[];
  layout: DiffLayout;
  theme: 'light' | 'dark';
  onIssueClick: (issue: ReviewIssue) => void;
  scrollTarget: { file: string; line: number | null } | null;
}

function FileSection({
  file,
  index,
  annotations,
  layout,
  theme,
  onIssueClick,
  scrollTarget,
}: FileSectionProps) {
  const generalIssues = index.general.get(file.path) ?? [];
  const selectedLines =
    scrollTarget?.file === file.path && scrollTarget.line
      ? { start: scrollTarget.line, end: scrollTarget.line, side: 'additions' as const }
      : null;

  return (
    <div className="diff-file" id={fileDomId(file.path)}>
      <div className="diff-file-header">
        <span className={`file-status status-${file.status}`}>{STATUS_LABEL[file.status]}</span>
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
      ) : file.error ? (
        <div className="diff-file-message">{file.error}</div>
      ) : !file.patchLoaded ? (
        <div className="diff-file-message">
          <span className="spinner" /> Loading file diff...
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
                    ? (index.byFileLine.get(`${file.path}:${line.newLine}`) ?? [])
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
                      <span className="gutter">{line.oldLine !== null ? line.oldLine : ''}</span>
                      <span className="gutter">{line.newLine !== null ? line.newLine : ''}</span>
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
  const container = fileEl.querySelector('diffs-container') as
    | (HTMLElement & {
        shadowRoot?: ShadowRoot | null;
      })
    | null;
  const root = container?.shadowRoot;
  if (!root) return null;
  return root.querySelector(
    `[data-line="${line}"][data-line-type="change-addition"], [data-line="${line}"][data-line-type="context"], [data-line="${line}"][data-line-type="context-expanded"]`
  );
}

function buildAnnotationsByFile(
  index: IssueLineIndex
): Map<string, DiffLineAnnotation<IssueAnnotation>[]> {
  const annotationsByFile = new Map<string, DiffLineAnnotation<IssueAnnotation>[]>();
  for (const [key, issues] of index.byFileLine.entries()) {
    const separator = key.lastIndexOf(':');
    if (separator === -1) continue;
    const path = key.slice(0, separator);
    const lineNumber = Number(key.slice(separator + 1));
    if (!Number.isFinite(lineNumber)) continue;
    const annotations = annotationsByFile.get(path) ?? [];
    for (const issue of issues) {
      annotations.push({ side: 'additions', lineNumber, metadata: { issue } });
    }
    annotationsByFile.set(path, annotations);
  }
  return annotationsByFile;
}

function InlineIssue({ issue, onClick }: { issue: ReviewIssue; onClick: () => void }) {
  return (
    <button type="button" className="line-issue" onClick={onClick}>
      <div className="li-top">
        <span className={`sev-badge ${SEVERITY_CLASS[issue.severity]}`}>
          {SEVERITY_EMOJI[issue.severity]} {issue.severity}
        </span>
        <span className="li-title">{issue.title}</span>
      </div>
      <div className="li-body">
        {CATEGORY_EMOJI[issue.category]} {issue.problem}
      </div>
    </button>
  );
}
