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
import type { ProjectConfigFile } from '../../shared/ipc-types';

interface ProjectSettingsProps {
  workingDir: string | null;
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

export function ProjectSettings({ workingDir }: ProjectSettingsProps) {
  const [config, setConfig] = useState<ProjectConfigFile | null>(null);
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [yamlSource, setYamlSource] = useState('');
  const [tab, setTab] = useState<SettingsTab>('form');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canSave = !!workingDir && !loading && !saving;

  const loadConfig = useCallback(async () => {
    if (!workingDir) return;
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const next = await window.drs.getProjectConfig(workingDir);
      setConfig(next);
      setFormData(next.value);
      setYamlSource(next.yaml);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [workingDir]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

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
  }, []);

  const handleYamlChange = useCallback((value: string) => {
    setYamlSource(value);
    try {
      const parsed = parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        setFormData(parsed as Record<string, unknown>);
      }
    } catch {
      // Keep the raw YAML editable; validation happens on save.
    }
  }, []);

  if (!workingDir) {
    return <div className="workflow-graph-empty">Open a project to edit DRS settings.</div>;
  }

  return (
    <div className="settings-workspace">
      <Card className="settings-card">
        <CardHeader>
          <CardTitle>Project Settings</CardTitle>
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
              <Button
                size="sm"
                onClick={() => void saveYaml(tab === 'form' ? stringify(formData) : yamlSource)}
                disabled={!canSave}
              >
                {saving ? 'Saving...' : 'Save config'}
              </Button>
            </div>
          </div>

          <div className="settings-tabs" role="tablist" aria-label="Project settings editor">
            <button
              className={tab === 'form' ? 'active' : ''}
              onClick={() => setTab('form')}
              type="button"
            >
              Schema form
            </button>
            <button
              className={tab === 'yaml' ? 'active' : ''}
              onClick={() => setTab('yaml')}
              type="button"
            >
              Raw YAML
            </button>
          </div>

          {message && <div className="settings-message success">{message}</div>}
          {error && <div className="settings-message error">{error}</div>}
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
                onSubmit={() => void saveYaml(stringify(formData))}
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
