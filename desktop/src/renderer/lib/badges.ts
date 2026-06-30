import type { IssueCategory, IssueSeverity } from '../types';

export const SEVERITY_EMOJI: Record<IssueSeverity, string> = {
  CRITICAL: '🔴',
  HIGH: '🟡',
  MEDIUM: '🟠',
  LOW: '⚪',
};

export const SEVERITY_LABEL: Record<IssueSeverity, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

export const SEVERITY_RANK: Record<IssueSeverity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

export const SEVERITY_CLASS: Record<IssueSeverity, string> = {
  CRITICAL: 'sev-critical',
  HIGH: 'sev-high',
  MEDIUM: 'sev-medium',
  LOW: 'sev-low',
};

export const CATEGORY_EMOJI: Record<IssueCategory, string> = {
  SECURITY: '🔒',
  QUALITY: '📊',
  STYLE: '✨',
  PERFORMANCE: '⚡',
  DOCUMENTATION: '📝',
};

export const SEVERITIES: IssueSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

/** A severity is actionable if it is CRITICAL or HIGH (matches DRS posting). */
export const isActionable = (severity: IssueSeverity): boolean =>
  severity === 'CRITICAL' || severity === 'HIGH';

/** "high" in DRS workflow --input terms means HIGH and above. */
export const severityToInput = (severity: IssueSeverity): string => severity.toLowerCase();
