import { useCallback, useEffect, useMemo, useState } from 'react';
import Form from '@rjsf/core';
import type { IChangeEvent } from '@rjsf/core';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import validator from '@rjsf/validator-ajv8';
import { parse, stringify } from 'yaml';
import { Button } from '@/renderer/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/renderer/components/ui/card';
import schemaJson from '../../shared/drs-config-schema.json';
import type { CodingAgentConfig, GlobalSettings, ProjectConfigFile } from '../../shared/ipc-types';

interface ProjectSettingsProps {
  workingDir: string | null;
  scope: 'global' | 'project';
}

type SettingsTab = 'form' | 'yaml';

const schema = schemaJson as RJSFSchema;

const uiSchema: UiSchema = {
  'ui:submitButtonOptions': { norender: true },
  pi: { 'ui:widget': 'textarea' },
  'ui:order': [
    'workflow',
    'agents',
    'review',
    'describe',
    'contextCompression',
    'github',
    'gitlab',
    'temporal',
    'pi',
    'pricing',
    'fix',
    '*',
  ],
};

function slugifyAgentName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function uniqueAgentId(base: string, agents: CodingAgentConfig[], currentId?: string) {
  const fallbackBase = base || 'agent';
  const usedIds = new Set(agents.filter((agent) => agent.id !== currentId).map((agent) => agent.id));
  if (!usedIds.has(fallbackBase)) return fallbackBase;

  let suffix = 2;
  while (usedIds.has(`${fallbackBase}-${suffix}`)) suffix += 1;
  return `${fallbackBase}-${suffix}`;
}

const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;

export function ProjectSettings({ workingDir, scope }: ProjectSettingsProps) {
  const [config, setConfig] = useState<ProjectConfigFile | null>(null);
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [yamlSource, setYamlSource] = useState('');
  const [yamlParseError, setYamlParseError] = useState<string | null>(null);
  const [tab, setTab] = useState<SettingsTab>('form');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [globalSettings, setGlobalSettings] = useState<GlobalSettings | null>(null);
  const [globalSettingsError, setGlobalSettingsError] = useState<string | null>(null);
  const [testingAgentId, setTestingAgentId] = useState<string | null>(null);

  const canSave = !!workingDir && !loading && !saving && !(tab === 'form' && yamlParseError);

  const loadConfig = useCallback(async () => {
    if (!workingDir || scope !== 'project') return;
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const next = await window.drs.getProjectConfig(workingDir);
      setConfig(next);
      setFormData(next.value);
      setYamlSource(next.yaml);
      setYamlParseError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [scope, workingDir]);

  useEffect(() => {
    if (scope === 'project') void loadConfig();
  }, [loadConfig, scope]);

  useEffect(() => {
    let cancelled = false;
    const loadGlobalSettings = async () => {
      try {
        const next = await window.drs.getGlobalSettings();
        if (cancelled) return;
        setGlobalSettings(next);
        setGlobalSettingsError(null);
      } catch (loadError) {
        if (!cancelled) setGlobalSettingsError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    };
    void loadGlobalSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  const validationErrors = useMemo(() => config?.errors ?? [], [config]);

  const saveYaml = useCallback(
    async (source: string) => {
      if (!workingDir) return;
      setSaving(true);
      setError(null);
      setMessage(null);
      try {
        const response = await window.drs.saveProjectConfig({ workingDir, yaml: source });
        setConfig(response.config);
        setFormData(response.config.value);
        setYamlSource(response.config.yaml);
        setYamlParseError(null);
        setMessage(`Saved ${response.config.path}`);
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : String(saveError));
      } finally {
        setSaving(false);
      }
    },
    [workingDir]
  );

  const handleFormChange = useCallback((event: IChangeEvent<Record<string, unknown>>) => {
    const next = (event.formData ?? {}) as Record<string, unknown>;
    setFormData(next);
    setYamlSource(stringify(next));
    setYamlParseError(null);
  }, []);

  const handleYamlChange = useCallback((value: string) => {
    setYamlSource(value);
    try {
      const parsed = parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        setFormData(parsed as Record<string, unknown>);
        setYamlParseError(null);
      } else {
        // Valid YAML, but not an object we can drive the schema form from
        // (e.g. a scalar or a list). Treat it the same as a parse error so
        // the form tab can't silently fall back to stale data.
        setYamlParseError('YAML must parse to an object to use the schema form.');
      }
    } catch (parseError) {
      // Keep the raw YAML editable, but remember that formData is now stale
      // relative to it so we never silently save the wrong thing.
      setYamlParseError(parseError instanceof Error ? parseError.message : String(parseError));
    }
  }, []);

  const handleSelectTab = useCallback(
    (next: SettingsTab) => {
      if (next === 'form' && yamlParseError) return;
      setTab(next);
    },
    [yamlParseError]
  );

  const handleSave = useCallback(() => {
    if (tab === 'form' && yamlParseError) return;
    void saveYaml(tab === 'form' ? stringify(formData) : yamlSource);
  }, [formData, saveYaml, tab, yamlParseError, yamlSource]);

  const handleSaveGlobalSettings = useCallback(async () => {
    if (!globalSettings) return;
    setGlobalSettingsError(null);
    try {
      const saved = await window.drs.saveGlobalSettings(globalSettings);
      setGlobalSettings(saved);
      setMessage('Saved global coding agent settings.');
    } catch (saveError) {
      setGlobalSettingsError(saveError instanceof Error ? saveError.message : String(saveError));
    }
  }, [globalSettings]);

  const updateGlobalSettings = useCallback((updater: (settings: GlobalSettings) => GlobalSettings) => {
    setGlobalSettings((current) => updater(current ?? { codingAgents: [] }));
  }, []);

  const updateCodingAgent = useCallback(
    (agentId: string, updater: (agent: CodingAgentConfig) => CodingAgentConfig) => {
      updateGlobalSettings((settings) => ({
        ...settings,
        codingAgents: settings.codingAgents.map((agent) => (agent.id === agentId ? updater(agent) : agent)),
      }));
    },
    [updateGlobalSettings]
  );

  const addCodingAgent = useCallback(() => {
    updateGlobalSettings((settings) => {
      const nextId = uniqueAgentId('new-agent', settings.codingAgents);
      return {
        ...settings,
        codingAgents: [
          ...settings.codingAgents,
          { id: nextId, name: 'New Agent', kind: 'generic', command: '', args: [] },
        ],
        defaultCodingAgentId: settings.defaultCodingAgentId ?? nextId,
      };
    });
  }, [updateGlobalSettings]);

  const removeCodingAgent = useCallback(
    (agentId: string) => {
      updateGlobalSettings((settings) => {
        const codingAgents = settings.codingAgents.filter((agent) => agent.id !== agentId);
        return {
          codingAgents,
          defaultCodingAgentId:
            settings.defaultCodingAgentId === agentId ? codingAgents[0]?.id : settings.defaultCodingAgentId,
        };
      });
    },
    [updateGlobalSettings]
  );

  const testCodingAgent = useCallback(
    async (agentId: string) => {
      if (!globalSettings) return;
      setTestingAgentId(agentId);
      setGlobalSettingsError(null);
      try {
        const saved = await window.drs.saveGlobalSettings(globalSettings);
        setGlobalSettings(saved);
        const result = await window.drs.testCodingAgent(agentId);
        if (result.ok) setMessage(result.message);
        else setGlobalSettingsError(result.message);
      } catch (testError) {
        setGlobalSettingsError(testError instanceof Error ? testError.message : String(testError));
      } finally {
        setTestingAgentId(null);
      }
    },
    [globalSettings]
  );

  if (scope === 'global') {
    return (
    <div className="settings-workspace">
      <Card className="settings-card">
        <CardHeader>
          <CardTitle>Global Coding Agents</CardTitle>
          <CardDescription>
            Configure ACP-compatible coding agents for desktop chat. Factory chat uses the default
            coding agent now; review chat will use this later.
          </CardDescription>
        </CardHeader>
        <CardContent className="settings-content">
          <div className="settings-toolbar">
            <div>
              <strong>ACP agents</strong>
              <span>Stored in the desktop global settings file.</span>
            </div>
            <div className="settings-actions">
              <Button variant="outline" size="sm" onClick={addCodingAgent}>
                Add agent
              </Button>
              <Button size="sm" onClick={handleSaveGlobalSettings}>
                Save global agents
              </Button>
            </div>
          </div>
          <label className="settings-field-row">
            <span>Default agent</span>
            <select
              value={globalSettings?.defaultCodingAgentId ?? ''}
              onChange={(event) =>
                updateGlobalSettings((settings) => ({
                  ...settings,
                  defaultCodingAgentId: event.target.value || undefined,
                }))
              }
            >
              <option value="">None</option>
              {(globalSettings?.codingAgents ?? []).map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name || agent.id}
                </option>
              ))}
            </select>
          </label>
          <div className="settings-agent-list">
            {(globalSettings?.codingAgents ?? []).map((agent, agentIndex) => (
              <div className="settings-agent-card" key={agentIndex}>
                <div className="settings-agent-card-header">
                  <strong>{agent.name || agent.id}</strong>
                  <div className="settings-actions">
                    <Button variant="outline" size="sm" onClick={() => void testCodingAgent(agent.id)} disabled={testingAgentId === agent.id || !agent.command.trim()}>
                      {testingAgentId === agent.id ? 'Testing...' : 'Test launch'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => removeCodingAgent(agent.id)}>
                      Remove
                    </Button>
                  </div>
                </div>
                <div className="settings-agent-grid">
                  <label className="settings-field-row">
                    <span>ID</span>
                    <input value={agent.id} disabled />
                  </label>
                  <label className="settings-field-row">
                    <span>Name</span>
                    <input
                      value={agent.name}
                      onChange={(event) => {
                        const nextName = event.target.value;
                        updateGlobalSettings((settings) => {
                          const nextId = uniqueAgentId(
                            slugifyAgentName(nextName),
                            settings.codingAgents,
                            agent.id
                          );

                          return {
                            ...settings,
                            defaultCodingAgentId:
                              settings.defaultCodingAgentId === agent.id
                                ? nextId
                                : settings.defaultCodingAgentId,
                            codingAgents: settings.codingAgents.map((current) =>
                              current.id === agent.id
                                ? {
                                    ...current,
                                    id: nextId,
                                    name: nextName,
                                  }
                                : current
                            ),
                          };
                        });
                      }}
                    />
                  </label>
                  <label className="settings-field-row">
                    <span>Known tool</span>
                    <select
                      value={agent.kind ?? 'generic'}
                      onChange={(event) => {
                        const kind = event.target.value === 'opencode' ? 'opencode' : 'generic';
                        updateCodingAgent(agent.id, (current) => ({
                          ...current,
                          kind,
                          command: kind === 'opencode' && !current.command.trim() ? 'opencode' : current.command,
                          args: kind === 'opencode' && current.args.length === 0 ? ['acp'] : current.args,
                        }));
                      }}
                    >
                      <option value="generic">Generic ACP</option>
                      <option value="opencode">OpenCode</option>
                    </select>
                  </label>
                  {agent.kind === 'opencode' && (
                    <>
                      <label className="settings-field-row">
                        <span>Provider</span>
                        <input value={agent.provider ?? ''} placeholder="openai" onChange={(event) => updateCodingAgent(agent.id, (current) => ({ ...current, provider: event.target.value }))} />
                      </label>
                      <label className="settings-field-row">
                        <span>Model</span>
                        <input value={agent.model ?? ''} placeholder="gpt-5.1 or openai/gpt-5.1" onChange={(event) => updateCodingAgent(agent.id, (current) => ({ ...current, model: event.target.value }))} />
                      </label>
                      <label className="settings-field-row">
                        <span>Default thinking</span>
                        <select value={agent.thinkingLevel ?? ''} onChange={(event) => updateCodingAgent(agent.id, (current) => ({ ...current, thinkingLevel: event.target.value ? event.target.value as CodingAgentConfig['thinkingLevel'] : undefined }))}>
                          <option value="">Agent default</option>
                          {THINKING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
                        </select>
                      </label>
                    </>
                  )}
                  <label className="settings-field-row settings-field-wide">
                    <span>Command</span>
                    <input value={agent.command} placeholder={agent.kind === 'opencode' ? 'opencode' : 'codex-acp'} onChange={(event) => updateCodingAgent(agent.id, (current) => ({ ...current, command: event.target.value }))} />
                  </label>
                  <label className="settings-field-row settings-field-wide">
                    <span>Args</span>
                    <input value={agent.args.join(' ')} placeholder={agent.kind === 'opencode' ? 'acp' : '--some-flag value'} onChange={(event) => updateCodingAgent(agent.id, (current) => ({ ...current, args: event.target.value.split(' ').filter(Boolean) }))} />
                  </label>
                  <label className="settings-field-row settings-field-wide">
                    <span>Environment JSON</span>
                    <textarea
                      value={JSON.stringify(agent.env ?? {}, null, 2)}
                      spellCheck={false}
                      onChange={(event) =>
                        updateCodingAgent(agent.id, (current) => {
                          try {
                            const parsed = JSON.parse(event.target.value) as Record<string, string>;
                            setGlobalSettingsError(null);
                            return { ...current, env: parsed };
                          } catch {
                            setGlobalSettingsError(`Environment JSON for ${agent.id} is not valid yet.`);
                            return current;
                          }
                        })
                      }
                    />
                  </label>
                </div>
              </div>
            ))}
          </div>
          {globalSettings && globalSettings.codingAgents.length === 0 && (
            <div className="settings-message warning">
              <strong>No ACP coding agents configured</strong>
              <span>Add at least one agent and set defaultCodingAgentId to use ACP in Factory chat.</span>
            </div>
          )}
          {message && <div className="settings-message success">{message}</div>}
          {globalSettingsError && <div className="settings-message error">{globalSettingsError}</div>}
        </CardContent>
      </Card>
    </div>
    );
  }

  if (!workingDir) {
    return <div className="workflow-graph-empty">Open a project to edit DRS config.</div>;
  }

  return (
    <div className="settings-workspace">
      <Card className="settings-card">
        <CardHeader>
          <CardTitle>Project Config</CardTitle>
          <CardDescription>
            Edit <code>.drs/drs.config.yaml</code> with a JSON Schema form, or use raw YAML for
            advanced keys.
          </CardDescription>
        </CardHeader>
        <CardContent className="settings-content">
          <div className="settings-toolbar">
            <div>
              <strong>{config?.exists ? 'Existing config' : 'New config'}</strong>
              <span>{config?.path ?? `${workingDir}/.drs/drs.config.yaml`}</span>
            </div>
            <div className="settings-actions">
              <Button variant="ghost" size="sm" onClick={loadConfig} disabled={loading || saving}>
                Reload
              </Button>
              <Button size="sm" onClick={handleSave} disabled={!canSave}>
                {saving ? 'Saving...' : 'Save config'}
              </Button>
            </div>
          </div>

          <div className="settings-tabs" role="tablist" aria-label="Project settings editor">
            <button
              className={tab === 'form' ? 'active' : ''}
              onClick={() => handleSelectTab('form')}
              disabled={!!yamlParseError}
              title={
                yamlParseError
                  ? 'Fix the YAML error before switching to the schema form.'
                  : undefined
              }
              type="button"
            >
              Schema form
            </button>
            <button
              className={tab === 'yaml' ? 'active' : ''}
              onClick={() => handleSelectTab('yaml')}
              type="button"
            >
              Raw YAML
            </button>
          </div>

          {message && <div className="settings-message success">{message}</div>}
          {error && <div className="settings-message error">{error}</div>}
          {tab === 'yaml' && yamlParseError && (
            <div className="settings-message warning">
              <strong>YAML does not parse yet</strong>
              <span>{yamlParseError}</span>
              <span>The schema form is disabled until this is fixed, so it can't go stale.</span>
            </div>
          )}
          {validationErrors.length > 0 && (
            <div className="settings-message warning">
              <strong>Current config has validation issues</strong>
              {validationErrors.map((validationError) => (
                <span key={validationError}>{validationError}</span>
              ))}
            </div>
          )}

          {loading ? (
            <div className="settings-loading">Loading project config...</div>
          ) : tab === 'form' ? (
            <div className="settings-form">
              <Form
                schema={schema}
                uiSchema={uiSchema}
                formData={formData}
                validator={validator}
                liveValidate
                noHtml5Validate
                onChange={handleFormChange}
                onSubmit={handleSave}
              />
            </div>
          ) : (
            <textarea
              className="settings-yaml-editor"
              value={yamlSource}
              spellCheck={false}
              onChange={(event) => handleYamlChange(event.target.value)}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
