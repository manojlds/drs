import { useEffect, useState } from 'react';
import type { RunBannerState } from './RunBanner';
import { RunBanner } from './RunBanner';
import type { WorkflowDetail, WorkflowInputConfig, WorkflowListEntry } from '../types';

interface SidebarProps {
  workingDir: string | null;
  workflows: WorkflowListEntry[];
  runState: RunBannerState | null;
  onPickDirectory: () => void;
  onRunWorkflow: (name: string, inputs: Record<string, string>) => void;
  onRunGithubReview: (inputs: Record<string, string>) => void;
  onRunGitlabReview: (inputs: Record<string, string>) => void;
  onCancelWorkflow: () => void;
  onDismissRun: () => void;
}

export function Sidebar(props: SidebarProps) {
  const { workingDir, workflows, runState, onPickDirectory } = props;
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="sidebar">
      <div className="sidebar-scroll">
        <div className="sidebar-section">
          <h3>Repository</h3>
          <div className="repo-card">
            <div className="repo-path">{workingDir ?? 'No repository selected'}</div>
            <div className="repo-actions">
              <button className="btn" onClick={onPickDirectory} style={{ flex: 1 }}>
                📁 Open…
              </button>
            </div>
          </div>
        </div>

        <RunBanner
          state={runState}
          onCancel={props.onCancelWorkflow}
          onDismiss={props.onDismissRun}
        />

        <ReviewSourcePanel
          disabled={!workingDir || !!runState?.active}
          onRunGithubReview={props.onRunGithubReview}
          onRunGitlabReview={props.onRunGitlabReview}
        />

        <div className="sidebar-section">
          <h3>Workflows</h3>
          {workflows.length === 0 && (
            <div className="muted" style={{ fontSize: 11.5 }}>
              {workingDir
                ? 'No workflows available. Run `drs init` in the repository.'
                : 'Open a repository to list workflows.'}
            </div>
          )}
          {workflows.map((entry) => (
            <WorkflowRow
              key={entry.name}
              entry={entry}
              workingDir={workingDir}
              expanded={expanded === entry.name}
              onToggle={() =>
                setExpanded((cur) => (cur === entry.name ? null : entry.name))
              }
              onRun={props.onRunWorkflow}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ReviewSourcePanel({
  disabled,
  onRunGithubReview,
  onRunGitlabReview,
}: {
  disabled: boolean;
  onRunGithubReview: (inputs: Record<string, string>) => void;
  onRunGitlabReview: (inputs: Record<string, string>) => void;
}) {
  const [source, setSource] = useState<'github' | 'gitlab'>('github');
  const [github, setGithub] = useState({ owner: '', repo: '', pr: '' });
  const [gitlab, setGitlab] = useState({ project: '', mr: '' });
  const [options, setOptions] = useState({ describe: false, post: false, visual: false, fix: false });

  const optionInputs = {
    describe: String(options.describe),
    post: String(options.post),
    visual: String(options.visual),
    fix: String(options.fix),
  };

  const canRunGithub = github.owner.trim() && github.repo.trim() && github.pr.trim();
  const canRunGitlab = gitlab.project.trim() && gitlab.mr.trim();

  return (
    <div className="sidebar-section">
      <h3>Review Source</h3>
      <div className="review-source-card">
        <div className="seg source-tabs">
          <button className={source === 'github' ? 'active' : ''} onClick={() => setSource('github')}>
            GitHub PR
          </button>
          <button className={source === 'gitlab' ? 'active' : ''} onClick={() => setSource('gitlab')}>
            GitLab MR
          </button>
        </div>

        {source === 'github' ? (
          <>
            <LabeledInput label="Owner" value={github.owner} onChange={(owner) => setGithub((cur) => ({ ...cur, owner }))} />
            <LabeledInput label="Repo" value={github.repo} onChange={(repo) => setGithub((cur) => ({ ...cur, repo }))} />
            <LabeledInput label="PR" type="number" value={github.pr} onChange={(pr) => setGithub((cur) => ({ ...cur, pr }))} />
            <button
              className="btn btn-primary"
              disabled={disabled || !canRunGithub}
              onClick={() => onRunGithubReview({ ...optionInputs, owner: github.owner.trim(), repo: github.repo.trim(), pr: github.pr.trim() })}
              style={{ width: '100%', justifyContent: 'center' }}
            >
              Review GitHub PR
            </button>
          </>
        ) : (
          <>
            <LabeledInput label="Project" value={gitlab.project} onChange={(project) => setGitlab((cur) => ({ ...cur, project }))} placeholder="group/project" />
            <LabeledInput label="MR" type="number" value={gitlab.mr} onChange={(mr) => setGitlab((cur) => ({ ...cur, mr }))} />
            <button
              className="btn btn-primary"
              disabled={disabled || !canRunGitlab}
              onClick={() => onRunGitlabReview({ ...optionInputs, project: gitlab.project.trim(), mr: gitlab.mr.trim() })}
              style={{ width: '100%', justifyContent: 'center' }}
            >
              Review GitLab MR
            </button>
          </>
        )}

        <div className="source-options">
          {(['describe', 'post', 'visual', 'fix'] as const).map((name) => (
            <label key={name}>
              <input
                type="checkbox"
                checked={options[name]}
                onChange={(event) => setOptions((cur) => ({ ...cur, [name]: event.target.checked }))}
              />
              {name}
            </label>
          ))}
        </div>
        <div className="muted source-note">Posting and fixing are off by default.</div>
      </div>
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'number';
  placeholder?: string;
}) {
  return (
    <div className="input-row">
      <label>{label}</label>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

interface WorkflowRowProps {
  entry: WorkflowListEntry;
  workingDir: string | null;
  expanded: boolean;
  onToggle: () => void;
  onRun: (name: string, inputs: Record<string, string>) => void;
}

function WorkflowRow({ entry, workingDir, expanded, onToggle, onRun }: WorkflowRowProps) {
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});

  // Fetch the workflow detail (inputs + nodes) when first expanded.
  useEffect(() => {
    if (!expanded || detail || !workingDir) return;
    let cancelled = false;
    window.drs
      .showWorkflow(entry.name, workingDir)
            .then((d: WorkflowDetail | null) => {
        if (cancelled || !d) return;
        setDetail(d);
        const defaults: Record<string, string> = {};
        for (const [key, input] of Object.entries(d.inputs ?? {}) as Array<
          [string, WorkflowInputConfig]
        >) {
          defaults[key] = defaultInputValue(input);
        }
        setInputs(defaults);
      })
      .catch(() => {
        // Detail is optional; the row still works without an input form.
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, detail, entry.name, workingDir]);

  return (
    <div className="workflow-item">
      <div className="workflow-header" onClick={onToggle}>
        <span>{expanded ? '▾' : '▸'}</span>
        <span className="wf-name">{entry.name}</span>
        <span className="wf-source">{entry.source}</span>
      </div>
      {expanded && (
        <div className="workflow-body">
          {entry.description && <p className="workflow-desc">{entry.description}</p>}
          {detail &&
            Object.entries(detail.inputs ?? {}).map(([key, input]) => (
              <InputField
                key={key}
                name={key}
                input={input}
                value={inputs[key] ?? ''}
                onChange={(value) => setInputs((cur) => ({ ...cur, [key]: value }))}
              />
            ))}
          <button
            className="btn btn-primary"
            onClick={() => onRun(entry.name, inputs)}
            disabled={!workingDir}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            ▶ Run {entry.name}
          </button>
        </div>
      )}
    </div>
  );
}

function InputField({
  name,
  input,
  value,
  onChange,
}: {
  name: string;
  input: WorkflowInputConfig;
  value: string;
  onChange: (value: string) => void;
}) {
  const type = input.type ?? 'string';
  const id = `wf-input-${name}`;

  if (type === 'boolean') {
    const checked = value === 'true';
    return (
      <div className="input-row">
        <label htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
          />
          {name}
          {input.description ? <span className="muted"> — {input.description}</span> : null}
        </label>
      </div>
    );
  }

  if (type === 'enum' && input.values) {
    return (
      <div className="input-row">
        <label htmlFor={id}>
          {name}
          {input.description ? <span className="muted"> — {input.description}</span> : null}
        </label>
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {input.values.map((v) => (
            <option key={String(v)} value={String(v)}>
              {String(v)}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div className="input-row">
      <label htmlFor={id}>
        {name}
        {input.description ? <span className="muted"> — {input.description}</span> : null}
      </label>
      <input
        id={id}
        type={type === 'number' ? 'number' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function defaultInputValue(input: WorkflowInputConfig): string {
  if (input.type === 'boolean') {
    return input.default === true ? 'true' : 'false';
  }
  if (input.default !== undefined && input.default !== null) {
    return String(input.default);
  }
  return '';
}
