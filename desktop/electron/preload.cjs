// @ts-check

/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { contextBridge, ipcRenderer } = require('electron');

/**
 * @typedef {import('../src/shared/ipc-types').WorkflowListEntry} WorkflowListEntry
 * @typedef {import('../src/shared/ipc-types').WorkflowDetail} WorkflowDetail
 * @typedef {import('../src/shared/ipc-types').ReviewJsonOutput} ReviewJsonOutput
 * @typedef {import('../src/shared/ipc-types').RunWorkflowRequest} RunWorkflowRequest
 * @typedef {import('../src/shared/ipc-types').RunWorkflowResponse} RunWorkflowResponse
 * @typedef {import('../src/shared/ipc-types').AskReviewChatRequest} AskReviewChatRequest
 * @typedef {import('../src/shared/ipc-types').AskReviewChatResponse} AskReviewChatResponse
 * @typedef {import('../src/shared/ipc-types').DiffResult} DiffResult
 * @typedef {import('../src/shared/ipc-types').WorkflowLogEvent} WorkflowLogEvent
 * @typedef {import('../src/shared/ipc-types').DrsApi} DrsApi
 */

/** @type {DrsApi} */
const drs = {
  selectDirectory: () => ipcRenderer.invoke('drs:selectDirectory'),
  getCwd: () => ipcRenderer.invoke('drs:getCwd'),
  listWorkflows: (workingDir) => ipcRenderer.invoke('drs:listWorkflows', workingDir),
  showWorkflow: (name, workingDir) => ipcRenderer.invoke('drs:showWorkflow', name, workingDir),
  getDiff: (workingDir, opts) => ipcRenderer.invoke('drs:getDiff', workingDir, opts),
  getReviewArtifact: (workingDir) => ipcRenderer.invoke('drs:getReviewArtifact', workingDir),
  runWorkflow: (req) => ipcRenderer.invoke('drs:runWorkflow', req),
  askReviewChat: (req) => ipcRenderer.invoke('drs:askReviewChat', req),
  cancelWorkflow: (runId) => ipcRenderer.invoke('drs:cancelWorkflow', runId),
  readFile: (filePath) => ipcRenderer.invoke('drs:readFile', filePath),
  openExternal: (url) => ipcRenderer.invoke('drs:openExternal', url),
  onWorkflowLog: (callback) => {
    /** @param {Electron.IpcRendererEvent} _event @param {WorkflowLogEvent} payload */
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('drs:workflowLog', listener);
    return () => ipcRenderer.removeListener('drs:workflowLog', listener);
  },
};

contextBridge.exposeInMainWorld('drs', drs);
