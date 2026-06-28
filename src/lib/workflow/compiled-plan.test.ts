import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { compileWorkflowPlan, type CompiledWorkflowPlan } from './compiled-plan.js';

const workingDir = process.cwd();

function loadPlan(workflowName: string): CompiledWorkflowPlan {
  const config = loadConfig(workingDir);
  return compileWorkflowPlan(config, workflowName, { workingDir });
}

describe('compileWorkflowPlan', () => {
  describe('DAG-only workflows (local-review)', () => {
    const plan = () => loadPlan('local-review');

    it('records workflow metadata', () => {
      const p = plan();
      expect(p.schemaVersion).toBe(1);
      expect(p.workflowName).toBe('local-review');
      expect(p.description).toBe('Review local git diff');
      expect(p.source).toBe('packaged');
      expect(p.overridesPackaged).toBe(false);
      expect(p.output).toBe('review');
    });

    it('normalizes inputs to plain objects', () => {
      const p = plan();
      expect(Object.keys(p.inputs).sort()).toEqual(['staged']);
      expect(p.inputs.staged).toEqual({
        type: 'boolean',
        value: undefined,
        file: undefined,
        default: false,
        required: undefined,
        values: undefined,
        description: 'Review staged changes instead of unstaged changes',
      });
    });

    it('produces dependency-ordered execution and waves', () => {
      const p = plan();
      expect(p.executionOrder).toEqual(['change', 'review']);
      expect(p.waves).toEqual([['change'], ['review']]);
    });

    it('has no control-flow segments', () => {
      const p = plan();
      expect(p.hasControlNodes).toBe(false);
      expect(p.segments).toEqual([]);
    });

    it('points lastNodeId at the final node', () => {
      expect(plan().lastNodeId).toBe('review');
    });
  });

  describe('control-flow workflows (local-fix-review-issues)', () => {
    const plan = () => loadPlan('local-fix-review-issues');

    it('sets hasControlNodes and splits control segments', () => {
      const p = plan();
      expect(p.hasControlNodes).toBe(true);
      const controlSegments = p.segments.filter((s) => s.type === 'control');
      expect(controlSegments.map((s) => (s.type === 'control' ? s.nodeId : ''))).toEqual([
        'fix-loop',
        'done',
      ]);
    });

    it('emits at least one DAG segment before the first control node', () => {
      const p = plan();
      expect(p.segments[0]?.type).toBe('dag');
      if (p.segments[0]?.type === 'dag') {
        expect(p.segments[0].nodeIds[0]).toBe('change');
      }
    });

    it('keeps execution order ending with standalone control end node', () => {
      const p = plan();
      expect(p.executionOrder[p.executionOrder.length - 1]).toBe('done');
      expect(p.lastNodeId).toBe('done');
    });

    it('records all declared nodes', () => {
      const p = plan();
      expect(Object.keys(p.nodes).sort()).toEqual(
        [
          'change',
          'load-review-artifact',
          'fix-issues',
          'final-change',
          'verification-change',
          're-review',
          'verify-fix',
          'fix-loop',
          'done',
        ].sort()
      );
    });
  });

  describe('plan stability and serialization', () => {
    it('survives JSON round-trip unchanged', () => {
      const p = loadPlan('local-review');
      const text = JSON.stringify(p);
      const roundTripped = JSON.parse(text) as CompiledWorkflowPlan;
      expect(roundTripped).toEqual(p);
    });

    it('contains no functions or class instances', () => {
      const p = loadPlan('local-fix-review-issues');
      const serialized = JSON.stringify(p);
      // Function source would serialize to undefined and break round-trip; class
      // instances would lose their prototype. Both are caught by the round-trip
      // equality above, but assert the JSON text does not mention constructor
      // artifacts either.
      expect(serialized).not.toMatch(/"\\u0000"/); // no private class fields
      expect(serialized).not.toMatch(/\[Function/);
    });

    it('is stable across repeated compilations', () => {
      const a = loadPlan('github-pr-show-changes');
      const b = loadPlan('github-pr-show-changes');
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
  });

  describe('unknown workflow', () => {
    it('throws', () => {
      const config = loadConfig(workingDir);
      expect(() => compileWorkflowPlan(config, 'does-not-exist', { workingDir })).toThrow(
        /Unknown workflow "does-not-exist"/
      );
    });
  });
});
