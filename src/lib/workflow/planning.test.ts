import { describe, expect, it } from 'vitest';
import type { WorkflowNodeConfig } from '../config.js';
import type { WorkflowNodeResult, WorkflowTemplateContext } from './types.js';
import {
  computeActiveWorkflowNodes,
  createSkippedWorkflowNodeResult,
  evaluateWorkflowExpression,
  findWorkflowSegmentIndex,
  getWorkflowExecutionOrder,
  getWorkflowNodeSkipReason,
  parseWorkflowExpressionValue,
  splitWorkflowExpressionOperator,
  splitWorkflowSegments,
  validateWorkflowControlRouteDirection,
} from './planning.js';

function ctx(overrides: Partial<WorkflowTemplateContext> = {}): WorkflowTemplateContext {
  return {
    inputs: {},
    nodes: {},
    artifacts: {},
    loop: {},
    ...overrides,
  };
}

function node(overrides: Partial<WorkflowNodeConfig> = {}): WorkflowNodeConfig {
  return { ...overrides };
}

describe('workflow planning', () => {
  describe('getWorkflowExecutionOrder', () => {
    it('returns needs in dependency order', () => {
      const nodes: Record<string, WorkflowNodeConfig> = {
        b: node({ agent: 'x', needs: ['a'] }),
        a: node({ agent: 'x' }),
      };
      const order = getWorkflowExecutionOrder(nodes);
      expect(order).toEqual(['a', 'b']);
    });

    it('rejects a dependency cycle', () => {
      const nodes: Record<string, WorkflowNodeConfig> = {
        a: node({ agent: 'x', needs: ['b'] }),
        b: node({ agent: 'x', needs: ['a'] }),
      };
      expect(() => getWorkflowExecutionOrder(nodes)).toThrow(/dependency cycle at node "a"/);
    });

    it('rejects a node needing an unknown node', () => {
      const nodes: Record<string, WorkflowNodeConfig> = {
        a: node({ agent: 'x', needs: ['missing'] }),
      };
      expect(() => getWorkflowExecutionOrder(nodes)).toThrow(
        /node "a" needs unknown node "missing"/
      );
    });

    it('accepts change request creator attribution for git commits', () => {
      const nodes: Record<string, WorkflowNodeConfig> = {
        commit: node({
          action: 'git-commit',
          with: {
            message: 'fix: update change request',
            source: 'change',
            useChangeRequestAuthor: true,
          },
        }),
      };

      expect(getWorkflowExecutionOrder(nodes)).toEqual(['commit']);
    });

    it('rejects unknown git commit attribution options', () => {
      const nodes: Record<string, WorkflowNodeConfig> = {
        commit: node({
          action: 'git-commit',
          with: {
            message: 'fix: update change request',
            useChangeRequestCreator: true,
          },
        }),
      };

      expect(() => getWorkflowExecutionOrder(nodes)).toThrow(/useChangeRequestCreator/);
    });

    it('accepts permissions for agents and read-only review actions', () => {
      const permissions = {
        filesystem: { write: { roots: ['wiki'], allow: ['**/*.md'] } },
        shell: false,
      };
      const readOnlyPermissions = {
        filesystem: { read: { roots: ['.'], allow: ['**'] } },
        shell: false,
      };
      expect(
        getWorkflowExecutionOrder({ maintain: node({ agent: 'task/maintain', permissions }) })
      ).toEqual(['maintain']);
      expect(
        getWorkflowExecutionOrder({
          review: node({ action: 'review', permissions: readOnlyPermissions }),
        })
      ).toEqual(['review']);
      expect(() =>
        getWorkflowExecutionOrder({
          write: node({ action: 'write', writes: 'out.md', permissions }),
        })
      ).toThrow('can only define permissions or validation for agents');
      expect(() =>
        getWorkflowExecutionOrder({
          maintain: node({ agent: 'task/maintain', writes: 'out.md', permissions }),
        })
      ).toThrow('cannot combine agent permissions with writes');
      expect(() =>
        getWorkflowExecutionOrder({
          maintain: node({ agentsFrom: 'review.agents', permissions }),
        })
      ).toThrow('cannot grant filesystem write permissions');
      expect(() =>
        getWorkflowExecutionOrder({ review: node({ action: 'review', permissions }) })
      ).toThrow('cannot grant filesystem write permissions');
      expect(() =>
        getWorkflowExecutionOrder({
          review: node({ action: 'review', permissions: { shell: true } }),
        })
      ).toThrow('require shell: false');
      expect(() =>
        getWorkflowExecutionOrder({
          review: node({
            action: 'review',
            permissions: readOnlyPermissions,
            validation: { afterMutation: [{ name: 'okf-document', root: '.' }] },
          }),
        })
      ).toThrow('cannot define mutation validation');
    });
  });

  describe('validateWorkflowControlRouteDirection', () => {
    it('rejects backward jumps for non-loop control nodes', () => {
      // executionOrder: [a, switch, b]; switch jumps back to a.
      const nodes: Record<string, WorkflowNodeConfig> = {
        a: node({ agent: 'x' }),
        switch: node({ control: 'switch', value: 'x', cases: { x: 'a' } }),
        b: node({ agent: 'x', needs: ['switch'] }),
      };
      const executionOrder = ['a', 'switch', 'b'];
      expect(() => validateWorkflowControlRouteDirection(nodes, executionOrder)).toThrow(
        /cannot jump backward to "a"/
      );
    });

    it('allows forward jumps for non-loop control nodes', () => {
      const nodes: Record<string, WorkflowNodeConfig> = {
        switch: node({ control: 'switch', value: 'x', cases: { x: 'b' } }),
        b: node({ agent: 'x' }),
      };
      const executionOrder = ['switch', 'b'];
      expect(() => validateWorkflowControlRouteDirection(nodes, executionOrder)).not.toThrow();
    });
  });

  describe('splitWorkflowSegments / findWorkflowSegmentIndex', () => {
    it('groups dag nodes between control nodes', () => {
      const nodes: Record<string, WorkflowNodeConfig> = {
        a: node({ agent: 'x' }),
        b: node({ agent: 'x' }),
        loop: node({ control: 'loop', if: 'true', target: 'a', exit: 'b', maxIterations: 2 }),
        c: node({ agent: 'x' }),
      };
      const segments = splitWorkflowSegments(nodes, ['a', 'b', 'loop', 'c']);
      expect(segments).toEqual([
        { type: 'dag', nodeIds: ['a', 'b'] },
        { type: 'control', nodeId: 'loop' },
        { type: 'dag', nodeIds: ['c'] },
      ]);
      expect(findWorkflowSegmentIndex(segments, 'loop')).toBe(1);
      expect(findWorkflowSegmentIndex(segments, 'a')).toBe(0);
      expect(findWorkflowSegmentIndex(segments, 'missing')).toBe(-1);
    });
  });

  describe('computeActiveWorkflowNodes', () => {
    it('only activates downstream of the root plus root dependencies', () => {
      const nodes: Record<string, WorkflowNodeConfig> = {
        root: node({ agent: 'x' }),
        dep: node({ agent: 'x', needs: ['shared'] }),
        shared: node({ agent: 'x' }),
        unrelated: node({ agent: 'x' }),
      };
      const active = computeActiveWorkflowNodes(
        nodes,
        ['root', 'dep', 'shared', 'unrelated'],
        'root'
      );
      expect(active.has('root')).toBe(true);
      expect(active.has('unrelated')).toBe(false);
    });
  });

  describe('parseWorkflowExpressionValue', () => {
    it('parses booleans, null, and numbers', () => {
      const context = ctx();
      expect(parseWorkflowExpressionValue('true', context)).toBe(true);
      expect(parseWorkflowExpressionValue('false', context)).toBe(false);
      expect(parseWorkflowExpressionValue('null', context)).toBe(null);
      expect(parseWorkflowExpressionValue('42', context)).toBe(42);
      expect(parseWorkflowExpressionValue('-3.5', context)).toBe(-3.5);
    });

    it('resolves template references and dot-notation paths from context', () => {
      const context = ctx({ inputs: { branch: 'main' }, artifacts: { count: 2 } });
      expect(parseWorkflowExpressionValue('{{inputs.branch}}', context)).toBe('main');
      expect(parseWorkflowExpressionValue('artifacts.count', context)).toBe(2);
    });

    it('falls back to JSON parse for objects and to the raw string otherwise', () => {
      const context = ctx();
      expect(parseWorkflowExpressionValue('{"a":1}', context)).toEqual({ a: 1 });
      expect(parseWorkflowExpressionValue('not-json', context)).toBe('not-json');
    });

    it('throws on unknown template values', () => {
      expect(() => parseWorkflowExpressionValue('{{inputs.missing}}', ctx())).toThrow(
        /Unknown workflow template value/
      );
    });
  });

  describe('splitWorkflowExpressionOperator', () => {
    it('splits on && and || outside quotes and parens', () => {
      expect(splitWorkflowExpressionOperator('a && b', '&&')).toEqual(['a', 'b']);
      expect(splitWorkflowExpressionOperator('a || b || c', '||')).toEqual(['a', 'b', 'c']);
      expect(splitWorkflowExpressionOperator('a||b', '||')).toEqual(['a', 'b']);
    });

    it('does not split inside quotes', () => {
      expect(splitWorkflowExpressionOperator('"a && b"', '&&')).toEqual(['"a && b"']);
      expect(splitWorkflowExpressionOperator("'x || y'", '||')).toEqual(["'x || y'"]);
    });

    it('does not split inside parens', () => {
      expect(splitWorkflowExpressionOperator('(a && b) && c', '&&')).toEqual(['(a && b)', 'c']);
    });
  });

  describe('evaluateWorkflowExpression', () => {
    it('evaluates comparisons and boolean logic', () => {
      const context = ctx({ inputs: { severity: 'high', count: '3' } });
      expect(evaluateWorkflowExpression('true', context)).toBe(true);
      expect(evaluateWorkflowExpression('false', context)).toBe(false);
      expect(evaluateWorkflowExpression('1 > 2', context)).toBe(false);
      expect(evaluateWorkflowExpression('3 >= 3', context)).toBe(true);
      expect(evaluateWorkflowExpression('true && false', context)).toBe(false);
      expect(evaluateWorkflowExpression('true || false', context)).toBe(true);
      expect(evaluateWorkflowExpression('"a" == "a"', context)).toBe(true);
      expect(evaluateWorkflowExpression('(true || false) && true', context)).toBe(true);
    });
  });

  describe('getWorkflowNodeSkipReason', () => {
    it('reports a false if condition', () => {
      const reason = getWorkflowNodeSkipReason(node({ agent: 'x', if: 'false' }), ctx());
      expect(reason).toBe('if false: false');
    });

    it('reports skipped dependencies', () => {
      const nodes: Record<string, WorkflowNodeResult> = {
        dep: createSkippedWorkflowNodeResult('dep'),
      };
      const reason = getWorkflowNodeSkipReason(
        node({ agent: 'x', needs: ['dep'] }),
        ctx({ nodes })
      );
      expect(reason).toBe('dependency skipped: dep');
    });

    it('returns undefined when nothing skips the node', () => {
      const nodes: Record<string, WorkflowNodeResult> = {
        dep: { id: 'dep', type: 'agent', status: 'success', response: 'ok' },
      };
      expect(
        getWorkflowNodeSkipReason(node({ agent: 'x', needs: ['dep'] }), ctx({ nodes }))
      ).toBeUndefined();
    });
  });
});
