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
  prompt: string;
  prdPath: string;
  storiesPath: string;
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

export interface AskReviewChatRequest {
  workingDir: string;
  prompt: string;
}

export interface AskReviewChatResponse {
  conversationId: string;
  response: string;
}

export interface StartReviewChatRequest {
  workingDir: string;
}

export interface StartFactoryChatRequest {
  workingDir: string;
  prdId?: string;
  agent?: string;
}

export interface StartReviewChatResponse {
  conversationId: string;
}

export interface SendReviewChatMessageRequest {
  conversationId: string;
  prompt: string;
}

export type ReviewChatEvent =
  | { type: 'message_delta'; conversationId: string; messageId: string; text: string }
  | { type: 'turn_done'; conversationId: string }
  | { type: 'error'; conversationId: string; message: string };

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

export interface DrsApi {
  selectDirectory(): Promise<string | null>;
  getCwd(): Promise<string>;
  listWorkflows(workingDir: string): Promise<WorkflowListEntry[]>;
  showWorkflow(name: string, workingDir: string): Promise<WorkflowDetail>;
  getDiff(workingDir: string, opts: { staged: boolean }): Promise<DiffResult>;
  getFileDiff(workingDir: string, opts: { staged: boolean; path: string }): Promise<FileDiffResult>;
  listTasks(workingDir: string): Promise<DrsTask[]>;
  addTask(req: AddTaskRequest): Promise<DrsTask>;
  updateTask(req: UpdateTaskRequest): Promise<DrsTask>;
  listPrds(workingDir: string): Promise<FactoryPrd[]>;
  createPrd(req: { workingDir: string; title: string; prompt?: string; markdown?: string }): Promise<FactoryPrdDetail>;
  getPrd(workingDir: string, id: string): Promise<FactoryPrdDetail>;
  updatePrd(req: { workingDir: string; id: string; markdown: string }): Promise<FactoryPrdDetail>;
  updatePrdStatus(req: { workingDir: string; id: string; status: FactoryPrd['status'] }): Promise<FactoryPrdDetail>;
  generateStories(workingDir: string, prdId: string): Promise<FactoryPrdDetail>;
  updateStoryStatus(req: { workingDir: string; prdId: string; storyId: string; status: FactoryStory['reviewStatus'] }): Promise<FactoryPrdDetail>;
  importStories(workingDir: string, prdId: string): Promise<DrsTask[]>;
  listPrdVersions(workingDir: string, prdId: string): Promise<FactoryPrdVersion[]>;
  revertPrdVersion(workingDir: string, prdId: string, versionId: string): Promise<FactoryPrdDetail>;
  getReviewArtifact(workingDir: string): Promise<ReviewJsonOutput | null>;
  runWorkflow(req: RunWorkflowRequest): Promise<RunWorkflowResponse>;
  getProjectConfig(workingDir: string): Promise<ProjectConfigFile>;
  saveProjectConfig(req: SaveProjectConfigRequest): Promise<SaveProjectConfigResponse>;
  askReviewChat(req: AskReviewChatRequest): Promise<AskReviewChatResponse>;
  startReviewChat(req: StartReviewChatRequest): Promise<StartReviewChatResponse>;
  startFactoryChat(req: StartFactoryChatRequest): Promise<StartReviewChatResponse>;
  sendReviewChatMessage(req: SendReviewChatMessageRequest): Promise<void>;
  closeReviewChat(conversationId: string): Promise<void>;
  cancelWorkflow(runId: string): Promise<void>;
  readFile(filePath: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  onWorkflowLog(callback: (event: WorkflowLogEvent) => void): () => void;
  onReviewChatEvent(callback: (event: ReviewChatEvent) => void): () => void;
}
