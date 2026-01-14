export interface ChangeSummary {
  type: 'feature' | 'bugfix' | 'refactor' | 'docs' | 'test' | 'config' | 'other';
  description: string;
  subsystems: string[];
  complexity: 'simple' | 'medium' | 'high';
  riskLevel: 'low' | 'medium' | 'high';
}
