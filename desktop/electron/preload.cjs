// @ts-check

/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { contextBridge, ipcRenderer } = require('electron');

/**
 * @typedef {import('../src/shared/ipc-types').WorkflowListEntry} WorkflowListEntry
 * @typedef {import('../src/shared/ipc-types').WorkflowDetail} WorkflowDetail
 * @typedef {import('../src/shared/ipc-types').ReviewJsonOutput} ReviewJsonOutput
 * @typedef {import('../src/shared/ipc-types').RunWorkflowRequest} RunWorkflowRequest
 * @typedef {import('../src/shared/ipc-types').RunWorkflowResponse} RunWorkflowResponse
 * @typedef {import('../src/shared/ipc-types').SaveProjectConfigRequest} SaveProjectConfigRequest
 * @typedef {import('../src/shared/ipc-types').SaveProjectConfigResponse} SaveProjectConfigResponse
 * @typedef {import('../src/shared/ipc-types').AskReviewChatRequest} AskReviewChatRequest
 * @typedef {import('../src/shared/ipc-types').AskReviewChatResponse} AskReviewChatResponse
 * @typedef {import('../src/shared/ipc-types').StartReviewChatRequest} StartReviewChatRequest
 * @typedef {import('../src/shared/ipc-types').StartReviewChatResponse} StartReviewChatResponse
 * @typedef {import('../src/shared/ipc-types').SendReviewChatMessageRequest} SendReviewChatMessageRequest
 * @typedef {import('../src/shared/ipc-types').ReviewChatEvent} ReviewChatEvent
 * @typedef {import('../src/shared/ipc-types').DiffResult} DiffResult
 * @typedef {import('../src/shared/ipc-types').DrsTask} DrsTask
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
  getFileDiff: (workingDir, opts) => ipcRenderer.invoke('drs:getFileDiff', workingDir, opts),
  listTasks: (workingDir) => ipcRenderer.invoke('drs:listTasks', workingDir),
  addTask: (req) => ipcRenderer.invoke('drs:addTask', req),
  updateTask: (req) => ipcRenderer.invoke('drs:updateTask', req),
  listPrds: (workingDir) => ipcRenderer.invoke('drs:listPrds', workingDir),
  createPrd: (req) => ipcRenderer.invoke('drs:createPrd', req),
  getPrd: (workingDir, id) => ipcRenderer.invoke('drs:getPrd', workingDir, id),
  updatePrd: (req) => ipcRenderer.invoke('drs:updatePrd', req),
  updatePrdStatus: (req) => ipcRenderer.invoke('drs:updatePrdStatus', req),
  generateStories: (workingDir, prdId) => ipcRenderer.invoke('drs:generateStories', workingDir, prdId),
  updateStoryStatus: (req) => ipcRenderer.invoke('drs:updateStoryStatus', req),
  importStories: (workingDir, prdId) => ipcRenderer.invoke('drs:importStories', workingDir, prdId),
  listProposals: (workingDir) => ipcRenderer.invoke('drs:listProposals', workingDir),
  applyProposal: (workingDir, id) => ipcRenderer.invoke('drs:applyProposal', workingDir, id),
  discardProposal: (workingDir, id) => ipcRenderer.invoke('drs:discardProposal', workingDir, id),
  getReviewArtifact: (workingDir) => ipcRenderer.invoke('drs:getReviewArtifact', workingDir),
  runWorkflow: (req) => ipcRenderer.invoke('drs:runWorkflow', req),
  getProjectConfig: (workingDir) => ipcRenderer.invoke('drs:getProjectConfig', workingDir),
  saveProjectConfig: (req) => ipcRenderer.invoke('drs:saveProjectConfig', req),
  askReviewChat: (req) => ipcRenderer.invoke('drs:askReviewChat', req),
  startReviewChat: (req) => ipcRenderer.invoke('drs:startReviewChat', req),
  startFactoryChat: (req) => ipcRenderer.invoke('drs:startFactoryChat', req),
  sendReviewChatMessage: (req) => ipcRenderer.invoke('drs:sendReviewChatMessage', req),
  closeReviewChat: (conversationId) => ipcRenderer.invoke('drs:closeReviewChat', conversationId),
  cancelWorkflow: (runId) => ipcRenderer.invoke('drs:cancelWorkflow', runId),
  readFile: (filePath) => ipcRenderer.invoke('drs:readFile', filePath),
  openExternal: (url) => ipcRenderer.invoke('drs:openExternal', url),
  onWorkflowLog: (callback) => {
    /** @param {Electron.IpcRendererEvent} _event @param {WorkflowLogEvent} payload */
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('drs:workflowLog', listener);
    return () => ipcRenderer.removeListener('drs:workflowLog', listener);
  },
  onReviewChatEvent: (callback) => {
    /** @param {Electron.IpcRendererEvent} _event @param {ReviewChatEvent} payload */
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('drs:reviewChatEvent', listener);
    return () => ipcRenderer.removeListener('drs:reviewChatEvent', listener);
  },
};

contextBridge.exposeInMainWorld('drs', drs);
