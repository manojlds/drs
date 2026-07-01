import { useEffect, useState } from 'react';
import { Button } from '@/renderer/components/ui/button';

export interface RunBannerState {
  active: boolean;
  name: string;
  runId: string | null;
  logs: string[];
  error: string | null;
}

interface RunBannerProps {
  state: RunBannerState | null;
  onCancel: () => void;
  onDismiss: () => void;
}

export function RunBanner({ state, onCancel, onDismiss }: RunBannerProps) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (state?.error) setExpanded(true);
  }, [state?.error]);

  if (!state) return null;

  const status = state.active ? 'Running' : state.error ? 'Failed' : 'Finished';
  const hasDetails = state.logs.length > 0 || !!state.error;

  return (
    <div className="run-banner">
      <div className="rb-head">
        {state.active ? <span className="spinner" /> : <span className={`status-dot ${state.error ? 'error' : 'ok'}`} />}
        <button
          className="rb-summary"
          disabled={!hasDetails}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="rb-status">{status}</span>
          <span className="rb-name">{state.name}</span>
          {hasDetails && <span className="rb-log-count">{expanded ? 'Hide logs' : `${state.logs.length} log chunks`}</span>}
        </button>
        <span className="rb-actions">
          {state.active ? (
            <Button variant="destructive" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={onDismiss}>
              Dismiss
            </Button>
          )}
        </span>
      </div>
      {expanded && hasDetails && (
        <div className="rb-panel">
          {state.logs.length > 0 && <div className="rb-logs">{state.logs.join('').slice(-4000)}</div>}
          {state.error && <div className="rb-error">{state.error}</div>}
        </div>
      )}
    </div>
  );
}
