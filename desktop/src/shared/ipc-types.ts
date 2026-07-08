/**
 * Shared IPC contract between the Electron main process (CJS) and the React
 * renderer. The main process references these shapes via JSDoc typedefs; the
 * renderer imports them directly as TypeScript types.
 *
 * These mirror the corresponding DRS library types so the desktop app can
 * render review output produced by the DRS workflow engine without a hard
 * build-time dependency on the DRS package.
 */

export type IssueSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type IssueCategory = 'SECURITY' | 'QUALITY' | 'STYLE' | 'PERFORMANCE' | 'DOCUMENTATION';

/** Mirrors `ReviewIssue` from `src/lib/comment-formatter.ts`. */
export interface ReviewIssue {
  category: IssueCategory;
  severity: IssueSeverity;
  title: string;
  file: string;
  line?: number;
  problem: string;
  solution: string;
  references?: string[];
  agent: string;
}

/** Mirrors `ReviewSummary` from `src/lib/comment-formatter.ts`. */
export interface ReviewSummary {
  filesReviewed: number;
  issuesFound: number;
  bySeverity: Record<IssueSeverity, number>;
  byCategory: Record<IssueCategory, number>;
}

/** Mirrors `ReviewJsonOutput` from `src/lib/json-output.ts`. */
export interface ReviewJsonOutput {
  timestamp: string;
  summary: ReviewSummary;
  issues: ReviewIssue[];
  usage?: {
    total?: { input?: number; output?: number; totalTokens?: number; cost?: number };
  };
  metadata?: {
    source?: string;
    project?: string;
    branch?: { source?: string; target?: string };
  };
}

/** Mirrors `WorkflowListEntry` from `src/cli/workflow.ts`. */
export interface WorkflowListEntry {
  name: string;
  source: 'packaged' | 'project';
  overridden: boolean;
  description?: string;
  metadata?: WorkflowMetadata;
}

export interface WorkflowMetadata {
  kind?: string;
  tags?: string[];
  review?: {
    source?: string;
    diff?: boolean;
    issues?: boolean;
  };
  [key: string]: unknown;
}

export interface WorkflowInputConfig {
  type?: 'string' | 'boolean' | 'number' | 'enum';
  value?: string;
  file?: string;
  default?: string | number | boolean;
  required?: boolean;
  values?: Array<string | number | boolean>;
  description?: string;
}

export interface WorkflowNodeDetail {
  id: string;
  kind: 'agent' | 'agents' | 'action' | 'control';
  needs: string[];
  agent?: string;
  action?: string;
  control?: string;
}

export interface WorkflowGraphNode {
  id: string;
  label: string;
  kind: 'agent' | 'agents' | 'action' | 'control';
  agent?: string;
  agentsFrom?: string;
  action?: string;
  control?: string;
  condition?: string;
  output?: string;
  writes?: string;
}

export interface WorkflowGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: 'dependency' | 'control';
  label?: string;
}

export interface WorkflowGraph {
  workflow: string;
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
}

/** Mirrors `WorkflowDetail` from `src/cli/workflow.ts`. */
export interface WorkflowDetail {
  name: string;
  source: 'packaged' | 'project';
  overridden: boolean;
  description?: string;
  metadata?: WorkflowMetadata;
  inputs: Record<string, WorkflowInputConfig>;
  output?: string;
  nodes: WorkflowNodeDetail[];
  graph: WorkflowGraph;
}

/** Subset of `WorkflowRunResult` relevant to the desktop UI. */
export interface WorkflowRunResultJson {
  timestamp: string;
  workflow: string;
  inputs: Record<string, string>;
  nodes: Record<string, WorkflowRunNodeResult>;
  artifacts: Record<string, unknown> & {
    change?: ReviewSourceArtifact;
  };
  output?: unknown;
}

export interface WorkflowRunNodeResult {
  id: string;
  type: 'agent' | 'agents' | 'action' | 'control' | 'skipped';
  status?: 'success' | 'skipped';
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  agent?: string;
  agents?: string[];
  action?: string;
  control?: string;
  decision?: string;
  target?: string;
  response?: string;
  responses?: Array<{ usage?: { usage?: { cost?: number } } }>;
  output?: unknown;
  outputs?: Record<string, unknown>;
  writes?: string;
}

export interface ReviewSourceArtifact {
  name: string;
  files: string[];
  filesWithDiffs?: Array<{ filename: string; patch: string }>;
  context?: Record<string, unknown>;
  staged?: boolean;
}

export interface DiffResult {
  patch: string;
  nameStatus: string;
  stat: string;
  files: Array<{
    path: string;
    oldPath: string | null;
    status: 'added' | 'deleted' | 'modified' | 'renamed' | 'untracked';
    additions: number;
    deletions: number;
    binary: boolean;
  }>;
  fingerprint: string;
  truncated?: boolean;
  patchBytes?: number;
  maxPatchBytes?: number;
}

export interface FileDiffResult {
  patch: string;
  truncated?: boolean;
  patchBytes?: number;
  maxPatchBytes?: number;
}

export type TaskStatus =
  | 'draft'
  | 'backlog'
  | 'todo'
  | 'open'
  | 'in_progress'
  | 'checks_failed'
  | 'in_review'
  | 'review_failed'
  | 'ready_to_merge'
  | 'merged'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface DrsTask {
  id: string;
  prdId?: string;
  storyId?: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  source: { kind: 'manual' | 'github_issue' | 'gitlab_issue' | 'review_finding'; id?: string; url?: string };
  acceptanceCriteria: string[];
  dependsOn: string[];
  workflow?: string;
  branch?: string;
  attempts: Array<{
    id: string;
    workflow?: string;
    status: 'running' | 'passed' | 'failed' | 'cancelled';
    startedAt: string;
    completedAt?: string;
    summary?: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface AddTaskRequest {
  workingDir: string;
  prdId?: string;
  storyId?: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: number;
  acceptanceCriteria?: string[];
}

export interface UpdateTaskRequest {
  workingDir: string;
  id: string;
  prdId?: string;
  storyId?: string;
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: number;
  acceptanceCriteria?: string[];
}

export interface FactoryPrd {
  id: string;
  title: string;
  status: 'draft' | 'in_review' | 'approved' | 'active' | 'paused' | 'done' | 'archived';
  description: string;
  prdPath: string;
  storiesPath: string;
  workflowStage:
    | 'prd_draft'
    | 'prd_review_requested'
    | 'prd_approved'
    | 'stories_draft'
    | 'stories_review_requested'
    | 'stories_approved'
    | 'stories_imported';
  createdAt: string;
  updatedAt: string;
}

export interface FactoryStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  status: 'draft' | 'backlog' | 'todo';
  reviewStatus: 'draft' | 'approved' | 'rejected';
  dependsOn: string[];
  notes: string;
}

export interface FactoryPrdDetail {
  prd: FactoryPrd;
  markdown: string;
  stories: FactoryStory[];
  storySet: FactoryStorySet;
}

export interface FactoryStorySet {
  version: 1;
  prdId: string;
  status: 'not_started' | 'draft' | 'review_requested' | 'approved' | 'imported';
  source: 'agent' | 'manual';
  generatedAt?: string;
  approvedAt?: string;
  importedAt?: string;
  stories: FactoryStory[];
}

export interface FactoryWorkflowStatus {
  prdId: string;
  stage: FactoryPrd['workflowStage'];
  prdStatus: FactoryPrd['status'];
  storySetStatus: FactoryStorySet['status'];
  allowedActions: string[];
  blockedReason: string | null;
}

export interface FactoryPrdVersion {
  id: string;
  prdId: string;
  markdown: string;
  createdAt: string;
  source: 'create' | 'update' | 'revert';
}

export interface RunWorkflowRequest {
  name: string;
  inputs: Record<string, string>;
  workingDir: string;
  runId?: string;
}

export interface RunWorkflowResponse {
  result: WorkflowRunResultJson;
  reviewOutput: ReviewJsonOutput | null;
}

export interface WorkflowLogEvent {
  runId: string;
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface StartReviewChatRequest {
  workingDir: string;
  codingAgentId?: string;
  thinkingLevel?: CodingAgentThinkingLevel;
  resumeSessionId?: string;
}

export interface StartFactoryChatRequest {
  workingDir: string;
  prdId?: string;
  agent?: string;
  codingAgentId?: string;
  thinkingLevel?: CodingAgentThinkingLevel;
  resumeSessionId?: string;
}

export interface StartReviewChatResponse {
  conversationId: string;
  agentSessionId?: string;
}

export interface SendReviewChatMessageRequest {
  conversationId: string;
  prompt: string;
}

export type ReviewChatEvent =
  | { type: 'message_delta'; conversationId: string; messageId: string; text: string }
  | { type: 'tool_call'; conversationId: string; toolCallId: string; title: string; kind?: string; status?: string; content?: string }
  | { type: 'tool_call_update'; conversationId: string; toolCallId: string; status?: string; content?: string }
  | {
      type: 'permission_request';
      conversationId: string;
      permissionId: string;
      toolCallId?: string;
      title?: string;
      kind?: string;
      status?: string;
      content?: string;
      risk?: 'low' | 'medium' | 'high';
      rawInput?: unknown;
      options: Array<{ optionId: string; name: string; kind: string }>;
    }
  | {
      type: 'elicitation_request';
      conversationId: string;
      elicitationId: string;
      mode: 'form' | 'url';
      message: string;
      toolCallId?: string;
      url?: string;
      schema?: ElicitationSchema;
    }
  | { type: 'turn_done'; conversationId: string }
  | { type: 'error'; conversationId: string; message: string };

export type ElicitationSchema = {
  title?: string | null;
  description?: string | null;
  properties?: Record<string, ElicitationPropertySchema>;
  required?: string[] | null;
};

export type ElicitationPropertySchema = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  title?: string | null;
  description?: string | null;
  default?: string | number | boolean | string[] | null;
  enum?: string[] | null;
  oneOf?: Array<{ const: string; title: string }> | null;
  items?: { enum?: string[]; anyOf?: Array<{ const: string; title: string }> } | null;
};

export interface RespondChatPermissionRequest {
  conversationId: string;
  permissionId: string;
  optionId?: string;
  cancelled?: boolean;
}

export interface RespondChatElicitationRequest {
  conversationId: string;
  elicitationId: string;
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, string | number | boolean | string[]>;
}

export interface TestCodingAgentResponse {
  ok: boolean;
  message: string;
}

export type CodingAgentKind = 'generic' | 'opencode' | 'claude-code';
export type CodingAgentThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export interface CodingAgentConfig {
  id: string;
  name: string;
  kind?: CodingAgentKind;
  command: string;
  args: string[];
  provider?: string;
  model?: string;
  thinkingLevel?: CodingAgentThinkingLevel;
  env?: Record<string, string>;
}

export interface GlobalSettings {
  codingAgents: CodingAgentConfig[];
  defaultCodingAgentId?: string;
}

export interface ProjectConfigFile {
  path: string;
  exists: boolean;
  yaml: string;
  value: Record<string, unknown>;
  errors: string[];
}

export interface SaveProjectConfigRequest {
  workingDir: string;
  yaml: string;
}

export interface SaveProjectConfigResponse {
  config: ProjectConfigFile;
}

export interface SkillStatus {
  name: string;
  bundled: boolean;
  installed: boolean;
  installedPath: string;
  modified: boolean;
  outdated: boolean;
}

export interface ProjectSetupStatus {
  initialized: boolean;
  configPath: string;
  skills: SkillStatus[];
  issues: string[];
}

export interface DrsApi {
  selectDirectory(): Promise<string | null>;
  getCwd(): Promise<string>;
  listWorkflows(workingDir: string): Promise<WorkflowListEntry[]>;
  showWorkflow(name: string, workingDir: string): Promise<WorkflowDetail>;
  getDiff(workingDir: string, opts: { staged: boolean }): Promise<DiffResult>;
  getProjectSetupStatus(workingDir: string): Promise<ProjectSetupStatus>;
  initProject(workingDir: string): Promise<ProjectSetupStatus>;
  syncProjectSetup(workingDir: string): Promise<ProjectSetupStatus>;
  getFileDiff(workingDir: string, opts: { staged: boolean; path: string }): Promise<FileDiffResult>;
  listTasks(workingDir: string): Promise<DrsTask[]>;
  addTask(req: AddTaskRequest): Promise<DrsTask>;
  updateTask(req: UpdateTaskRequest): Promise<DrsTask>;
  listPrds(workingDir: string): Promise<FactoryPrd[]>;
  createPrd(req: { workingDir: string; title: string; description?: string; markdown?: string }): Promise<FactoryPrdDetail>;
  getPrd(workingDir: string, id: string): Promise<FactoryPrdDetail>;
  updatePrd(req: { workingDir: string; id: string; markdown: string }): Promise<FactoryPrdDetail>;
  deletePrd(workingDir: string, id: string): Promise<FactoryPrd>;
  updatePrdStatus(req: { workingDir: string; id: string; status: FactoryPrd['status'] }): Promise<FactoryPrdDetail>;
  getFactoryWorkflowStatus(workingDir: string, prdId: string): Promise<FactoryWorkflowStatus>;
  requestPrdReview(workingDir: string, prdId: string): Promise<FactoryPrdDetail>;
  approvePrd(workingDir: string, prdId: string): Promise<FactoryPrdDetail>;
  requestPrdChanges(workingDir: string, prdId: string): Promise<FactoryPrdDetail>;
  requestStoriesReview(workingDir: string, prdId: string): Promise<FactoryPrdDetail>;
  approveStories(workingDir: string, prdId: string): Promise<FactoryPrdDetail>;
  updateStoryStatus(req: { workingDir: string; prdId: string; storyId: string; status: FactoryStory['reviewStatus'] }): Promise<FactoryPrdDetail>;
  importStories(workingDir: string, prdId: string): Promise<DrsTask[]>;
  listPrdVersions(workingDir: string, prdId: string): Promise<FactoryPrdVersion[]>;
  revertPrdVersion(workingDir: string, prdId: string, versionId: string): Promise<FactoryPrdDetail>;
  getReviewArtifact(workingDir: string): Promise<ReviewJsonOutput | null>;
  runWorkflow(req: RunWorkflowRequest): Promise<RunWorkflowResponse>;
  getProjectConfig(workingDir: string): Promise<ProjectConfigFile>;
  saveProjectConfig(req: SaveProjectConfigRequest): Promise<SaveProjectConfigResponse>;
  getGlobalSettings(): Promise<GlobalSettings>;
  saveGlobalSettings(settings: GlobalSettings): Promise<GlobalSettings>;
  testCodingAgent(agentId: string): Promise<TestCodingAgentResponse>;
  startReviewChat(req: StartReviewChatRequest): Promise<StartReviewChatResponse>;
  startFactoryChat(req: StartFactoryChatRequest): Promise<StartReviewChatResponse>;
  sendReviewChatMessage(req: SendReviewChatMessageRequest): Promise<void>;
  respondChatPermission(req: RespondChatPermissionRequest): Promise<void>;
  respondChatElicitation(req: RespondChatElicitationRequest): Promise<void>;
  closeReviewChat(conversationId: string): Promise<void>;
  cancelWorkflow(runId: string): Promise<void>;
  readFile(filePath: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  onWorkflowLog(callback: (event: WorkflowLogEvent) => void): () => void;
  onReviewChatEvent(callback: (event: ReviewChatEvent) => void): () => void;
}
