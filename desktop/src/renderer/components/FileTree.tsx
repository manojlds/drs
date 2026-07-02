import { useEffect, useMemo } from 'react';
import {
  FileTree as PierreFileTree,
  useFileTree,
} from '@pierre/trees/react';
import type { FileTreeRowDecoration, GitStatusEntry } from '@pierre/trees';
import { useTheme } from './theme-provider';
import type { DiffFile } from '../lib/diff';

interface FileTreeProps {
  files: DiffFile[];
  selectedFile: string | null;
  onSelectFile: (file: string) => void;
}

export function FileTree({ files, selectedFile, onSelectFile }: FileTreeProps) {
  const { resolvedTheme } = useTheme();
  const paths = useMemo(() => files.map((file) => file.path), [files]);
  const gitStatus = useMemo<GitStatusEntry[]>(
    () => files.map((file) => ({ path: file.path, status: file.status })),
    [files],
  );
  const counts = useMemo(() => {
    const map = new Map<string, string>();
    for (const file of files) {
      map.set(file.path, `+${file.additions} -${file.deletions}`);
    }
    return map;
  }, [files]);

  return (
    <aside className="file-tree-pane">
      <PierreFileTreeAdapter
        key={`${resolvedTheme}:${paths.join('\n')}`}
        paths={paths}
        gitStatus={gitStatus}
        counts={counts}
        theme={resolvedTheme}
        selectedFile={selectedFile}
        onSelectFile={onSelectFile}
      />
    </aside>
  );
}

function PierreFileTreeAdapter({
  paths,
  gitStatus,
  counts,
  theme,
  selectedFile,
  onSelectFile,
}: {
  paths: string[];
  gitStatus: GitStatusEntry[];
  counts: Map<string, string>;
  theme: 'light' | 'dark';
  selectedFile: string | null;
  onSelectFile: (file: string) => void;
}) {
  const { model } = useFileTree({
    paths,
    gitStatus,
    flattenEmptyDirectories: true,
    initialExpansion: 'open',
    initialSelectedPaths: selectedFile ? [selectedFile] : [],
    density: 'compact',
    search: true,
    stickyFolders: true,
    unsafeCSS: theme === 'dark' ? PIERRE_TREE_DARK_CSS : PIERRE_TREE_LIGHT_CSS,
    onSelectionChange: (selectedPaths) => {
      const selected = selectedPaths[0];
      if (selected && paths.includes(selected)) onSelectFile(selected);
    },
    renderRowDecoration: ({ item }): FileTreeRowDecoration | null => {
      const text = counts.get(item.path);
      return text ? { text, title: text } : null;
    },
  });

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [gitStatus, model]);

  useEffect(() => {
    if (!selectedFile) return;
    const item = model.getItem(selectedFile);
    if (!item) return;
    item.select();
    model.scrollToPath(selectedFile, { focus: true, offset: 'nearest' });
  }, [model, selectedFile]);

  return (
    <PierreFileTree
      className="pierre-file-tree"
      model={model}
      header={
        <div className="file-tree-header-content">
          <strong>Files</strong>
          <span>{paths.length}</span>
        </div>
      }
    />
  );
}

const PIERRE_TREE_DARK_CSS = `
:host {
  --trees-bg-override: #151521;
  --trees-bg-muted-override: #1e1e2e;
  --trees-fg-override: #cdd6f4;
  --trees-fg-muted-override: #6c7086;
  --trees-accent-override: #89b4fa;
  --trees-border-color-override: #313244;
  --trees-selected-bg-override: rgba(137, 180, 250, 0.14);
  --trees-selected-fg-override: #cdd6f4;
  --trees-status-added-override: #a6e3a1;
  --trees-status-deleted-override: #f38ba8;
  --trees-status-modified-override: #89b4fa;
  --trees-status-renamed-override: #f9e2af;
  --trees-status-untracked-override: #bac2de;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
}

[data-file-tree-search-container] {
  background: #151521;
  border-bottom: 1px solid #313244;
}

[data-file-tree-search-input] {
  background: #1e1e2e;
  border: 1px solid #313244;
  color: #cdd6f4;
  border-radius: 6px;
}

[data-file-tree-search-input]::placeholder {
  color: #6c7086;
}
`;

const PIERRE_TREE_LIGHT_CSS = `
:host {
  --trees-bg-override: #f7f8fc;
  --trees-bg-muted-override: #ffffff;
  --trees-fg-override: #151923;
  --trees-fg-muted-override: #7a8496;
  --trees-accent-override: #315fdc;
  --trees-border-color-override: #d7ddeb;
  --trees-selected-bg-override: rgba(49, 95, 220, 0.12);
  --trees-selected-fg-override: #151923;
  --trees-status-added-override: #18713b;
  --trees-status-deleted-override: #b4234a;
  --trees-status-modified-override: #315fdc;
  --trees-status-renamed-override: #a15c00;
  --trees-status-untracked-override: #667085;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
}

[data-file-tree-search-container] {
  background: #ffffff;
  border-bottom: 1px solid #d7ddeb;
}

[data-file-tree-search-input] {
  background: #ffffff;
  border: 1px solid #c7d0e0;
  color: #151923;
  border-radius: 6px;
  box-shadow: 0 1px 2px rgba(21, 25, 35, 0.04);
}

[data-file-tree-search-input]::placeholder {
  color: #7a8496;
}

[data-file-tree-search-input]:focus {
  border-color: #315fdc;
  box-shadow: 0 0 0 2px rgba(49, 95, 220, 0.12);
}
`;
