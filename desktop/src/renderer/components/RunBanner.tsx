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
  if (!state) return null;

  return (
    <div className="run-banner">
      <div className="rb-head">
        {state.active ? <span className="spinner" /> : <span className="status-dot ok" />}
        <span className="rb-name">{state.name}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {state.active ? (
            <button className="btn btn-danger" onClick={onCancel} style={{ padding: '3px 9px', fontSize: 11 }}>
              Cancel
            </button>
          ) : (
            <button className="btn" onClick={onDismiss} style={{ padding: '3px 9px', fontSize: 11 }}>
              Dismiss
            </button>
          )}
        </span>
      </div>
      {state.logs.length > 0 && (
        <div className="rb-logs">{state.logs.join('').slice(-4000)}</div>
      )}
      {state.error && <div className="rb-error">{state.error}</div>}
    </div>
  );
}
