import { useEffect, useMemo } from 'react';
import {
  FileTree as PierreFileTree,
  useFileTree,
} from '@pierre/trees/react';
import type { FileTreeRowDecoration, GitStatusEntry } from '@pierre/trees';
import type { DiffFile } from '../lib/diff';

interface FileTreeProps {
  files: DiffFile[];
  selectedFile: string | null;
  onSelectFile: (file: string) => void;
}

export function FileTree({ files, selectedFile, onSelectFile }: FileTreeProps) {
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
        key={paths.join('\n')}
        paths={paths}
        gitStatus={gitStatus}
        counts={counts}
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
  selectedFile,
  onSelectFile,
}: {
  paths: string[];
  gitStatus: GitStatusEntry[];
  counts: Map<string, string>;
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
    unsafeCSS: PIERRE_TREE_CSS,
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

const PIERRE_TREE_CSS = `
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
`;
