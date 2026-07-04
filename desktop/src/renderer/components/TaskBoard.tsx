import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/renderer/components/ui/badge';
import { Button } from '@/renderer/components/ui/button';
import { Card } from '@/renderer/components/ui/card';
import { Input } from '@/renderer/components/ui/input';
import type { DrsTask, TaskStatus } from '@/shared/ipc-types';

interface TaskBoardProps {
  workingDir: string;
}

type BoardColumn = {
  id: string;
  title: string;
  statuses: TaskStatus[];
};

const COLUMNS: BoardColumn[] = [
  { id: 'backlog', title: 'Backlog', statuses: ['draft', 'open'] },
  { id: 'dev', title: 'In Dev', statuses: ['in_progress'] },
  { id: 'checks', title: 'Checks', statuses: ['checks_failed'] },
  { id: 'review', title: 'Review', statuses: ['in_review', 'review_failed'] },
  { id: 'ready', title: 'Ready', statuses: ['ready_to_merge'] },
  { id: 'done', title: 'Done', statuses: ['merged', 'done'] },
  { id: 'failed', title: 'Stopped', statuses: ['failed', 'cancelled'] },
];

const MOVE_STATUSES: TaskStatus[] = [
  'draft',
  'open',
  'checks_failed',
  'in_review',
  'review_failed',
  'ready_to_merge',
  'done',
  'failed',
  'cancelled',
];

export function TaskBoard({ workingDir }: TaskBoardProps) {
  const [tasks, setTasks] = useState<DrsTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [adding, setAdding] = useState(false);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTasks(await window.drs.listTasks(workingDir));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [workingDir]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const byColumn = useMemo(() => {
    const grouped = new Map<string, DrsTask[]>();
    for (const column of COLUMNS) grouped.set(column.id, []);
    for (const task of tasks) {
      const column = COLUMNS.find((item) => item.statuses.includes(task.status));
      grouped.get(column?.id ?? 'backlog')?.push(task);
    }
    return grouped;
  }, [tasks]);

  const handleAddTask = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setAdding(true);
    setError(null);
    try {
      const task = await window.drs.addTask({ workingDir, title: trimmed, status: 'open' });
      setTasks((current) => [...current, task].sort(sortTasks));
      setTitle('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }, [title, workingDir]);

  const handleMoveTask = useCallback(
    async (task: DrsTask, status: TaskStatus) => {
      setError(null);
      try {
        const updated = await window.drs.updateTask({ workingDir, id: task.id, status });
        setTasks((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [workingDir]
  );

  return (
    <div className="task-board-shell">
      <div className="task-board-header">
        <div>
          <div className="review-kicker">Factory</div>
          <h1>Work Board</h1>
          <p>Track work from idea to checks, review, and ready-to-merge.</p>
        </div>
        <Button variant="outline" onClick={loadTasks} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </Button>
      </div>

      <Card className="task-create-card">
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void handleAddTask();
          }}
          placeholder="Add a task for an agent or workflow to pick up..."
        />
        <Button onClick={handleAddTask} disabled={adding || !title.trim()}>
          {adding ? 'Adding...' : 'Add Task'}
        </Button>
      </Card>

      {error && <div className="task-board-error">{error}</div>}

      <div className="task-board-grid">
        {COLUMNS.map((column) => {
          const columnTasks = byColumn.get(column.id) ?? [];
          return (
            <section key={column.id} className="task-column">
              <div className="task-column-header">
                <strong>{column.title}</strong>
                <Badge variant="outline">{columnTasks.length}</Badge>
              </div>
              <div className="task-column-cards">
                {columnTasks.length === 0 ? (
                  <div className="task-column-empty">No tasks</div>
                ) : (
                  columnTasks.map((task) => (
                    <TaskCard key={task.id} task={task} onMove={handleMoveTask} />
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function TaskCard({
  task,
  onMove,
}: {
  task: DrsTask;
  onMove: (task: DrsTask, status: TaskStatus) => void;
}) {
  return (
    <Card className="task-card">
      <div className="task-card-topline">
        <Badge variant="secondary">{task.id}</Badge>
        <span>P{task.priority}</span>
      </div>
      <strong>{task.title}</strong>
      {task.description && <p>{task.description}</p>}
      {task.acceptanceCriteria.length > 0 && (
        <div className="task-card-criteria">{task.acceptanceCriteria.length} acceptance criteria</div>
      )}
      <label className="task-status-select">
        <span>Move to</span>
        <select
          value={task.status}
          disabled={task.status === 'in_progress'}
          onChange={(event) => onMove(task, event.target.value as TaskStatus)}
        >
          {[...new Set([task.status, ...MOVE_STATUSES])].map((status) => (
            <option key={status} value={status}>
              {status.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </label>
    </Card>
  );
}

function sortTasks(a: DrsTask, b: DrsTask): number {
  return a.priority - b.priority || a.id.localeCompare(b.id);
}
