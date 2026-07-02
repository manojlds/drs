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
}

/** Subset of `WorkflowRunResult` relevant to the desktop UI. */
export interface WorkflowRunResultJson {
  timestamp: string;
  workflow: string;
  inputs: Record<string, string>;
  nodes: Record<string, unknown>;
  artifacts: Record<string, unknown> & {
    change?: ReviewSourceArtifact;
  };
  output?: unknown;
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

export interface DrsApi {
  selectDirectory(): Promise<string | null>;
  getCwd(): Promise<string>;
  listWorkflows(workingDir: string): Promise<WorkflowListEntry[]>;
  showWorkflow(name: string, workingDir: string): Promise<WorkflowDetail>;
  getDiff(workingDir: string, opts: { staged: boolean }): Promise<DiffResult>;
  getReviewArtifact(workingDir: string): Promise<ReviewJsonOutput | null>;
  runWorkflow(req: RunWorkflowRequest): Promise<RunWorkflowResponse>;
  askReviewChat(req: AskReviewChatRequest): Promise<AskReviewChatResponse>;
  cancelWorkflow(runId: string): Promise<void>;
  readFile(filePath: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  onWorkflowLog(callback: (event: WorkflowLogEvent) => void): () => void;
}
