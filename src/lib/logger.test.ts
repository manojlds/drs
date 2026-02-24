import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, createLogger, configureLogger, getLogger } from './logger.js';

// ── Helpers ──────────────────────────────────────────────────────

function captureOutput() {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return {
    logSpy,
    errorSpy,
    allOutput: () => [
      ...logSpy.mock.calls.map((c) => String(c[0])),
      ...errorSpy.mock.calls.map((c) => String(c[0])),
    ],
    restore: () => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

// ── Logger class ─────────────────────────────────────────────────

describe('Logger', () => {
  let output: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    output = captureOutput();
  });

  afterEach(() => {
    output.restore();
  });

  describe('log levels', () => {
    it('defaults to info level', () => {
      const logger = new Logger();

      logger.debug('debug msg');
      logger.info('info msg');
      logger.warn('warn msg');
      logger.error('error msg');

      const all = output.allOutput();
      expect(all.some((s) => s.includes('debug msg'))).toBe(false);
      expect(all.some((s) => s.includes('info msg'))).toBe(true);
      expect(all.some((s) => s.includes('warn msg'))).toBe(true);
      expect(all.some((s) => s.includes('error msg'))).toBe(true);
    });

    it('respects debug level', () => {
      const logger = new Logger({ level: 'debug' });
      logger.debug('visible');
      expect(output.allOutput().some((s) => s.includes('visible'))).toBe(true);
    });

    it('respects error level — suppresses warn and info', () => {
      const logger = new Logger({ level: 'error' });
      logger.info('hidden');
      logger.warn('hidden');
      logger.error('shown');

      const all = output.allOutput();
      expect(all).toHaveLength(1);
      expect(all[0]).toContain('shown');
    });

    it('setLevel changes threshold at runtime', () => {
      const logger = new Logger({ level: 'error' });
      logger.info('hidden');
      expect(output.allOutput()).toHaveLength(0);

      logger.setLevel('debug');
      logger.debug('now visible');
      expect(output.allOutput().some((s) => s.includes('now visible'))).toBe(true);
    });
  });

  describe('output format', () => {
    it('human format includes emoji icon', () => {
      const logger = new Logger({ format: 'human' });
      logger.info('test message');
      expect(output.logSpy).toHaveBeenCalled();
      // info icon is ℹ️
      const call = String(output.logSpy.mock.calls[0][0]);
      expect(call).toContain('test message');
    });

    it('json format outputs parseable JSON', () => {
      const logger = new Logger({ format: 'json' });
      logger.info('structured');

      const call = String(output.logSpy.mock.calls[0][0]);
      const parsed = JSON.parse(call);
      expect(parsed.level).toBe('info');
      expect(parsed.message).toBe('structured');
      expect(parsed.timestamp).toBeTruthy();
    });

    it('json format includes context and data', () => {
      const logger = new Logger({ format: 'json' });
      logger.info('test', { agent: 'security' }, { extra: 42 });

      const parsed = JSON.parse(String(output.logSpy.mock.calls[0][0]));
      expect(parsed.context.agent).toBe('security');
      expect(parsed.data.extra).toBe(42);
    });

    it('setFormat switches format at runtime', () => {
      const logger = new Logger({ format: 'human' });
      logger.setFormat('json');
      logger.info('now json');

      const call = String(output.logSpy.mock.calls[0][0]);
      expect(() => JSON.parse(call)).not.toThrow();
    });

    it('error level outputs to console.error', () => {
      const logger = new Logger({ format: 'human' });
      logger.error('something broke');
      expect(output.errorSpy).toHaveBeenCalled();
      expect(output.logSpy).not.toHaveBeenCalled();
    });

    it('error level in json also uses console.error', () => {
      const logger = new Logger({ format: 'json' });
      logger.error('json error');
      expect(output.errorSpy).toHaveBeenCalled();
      expect(output.logSpy).not.toHaveBeenCalled();
    });
  });

  describe('timestamps', () => {
    it('omits timestamps by default in human format', () => {
      const logger = new Logger({ format: 'human' });
      logger.info('no timestamp');

      // Should NOT contain ISO date pattern in brackets
      const call = String(output.logSpy.mock.calls[0][0]);
      expect(call).not.toMatch(/\[\d{4}-\d{2}-\d{2}/);
    });

    it('includes timestamps when enabled in human format', () => {
      const logger = new Logger({ format: 'human', timestamps: true });
      logger.info('with timestamp');

      const call = String(output.logSpy.mock.calls[0][0]);
      // ISO timestamp pattern in brackets
      expect(call).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    it('setTimestamps toggles at runtime', () => {
      const logger = new Logger({ format: 'human' });
      logger.setTimestamps(true);
      logger.info('stamped');

      const call = String(output.logSpy.mock.calls[0][0]);
      expect(call).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    it('json format always includes timestamp field', () => {
      const logger = new Logger({ format: 'json', timestamps: false });
      logger.info('test');

      const parsed = JSON.parse(String(output.logSpy.mock.calls[0][0]));
      expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('context', () => {
    it('human format shows agent context prefix', () => {
      const logger = new Logger({ format: 'human' });
      logger.info('review done', { agent: 'security' });

      const call = String(output.logSpy.mock.calls[0][0]);
      expect(call).toContain('security');
    });

    it('human format shows tool context prefix', () => {
      const logger = new Logger({ format: 'human' });
      logger.info('reading file', { tool: 'read' });

      const call = String(output.logSpy.mock.calls[0][0]);
      expect(call).toContain('read');
    });

    it('human format shows skill context prefix', () => {
      const logger = new Logger({ format: 'human' });
      logger.info('skill loaded', { skill: 'sql-patterns' });

      const call = String(output.logSpy.mock.calls[0][0]);
      expect(call).toContain('skill:sql-patterns');
    });

    it('omits empty context in json format', () => {
      const logger = new Logger({ format: 'json' });
      logger.info('no context');

      const parsed = JSON.parse(String(output.logSpy.mock.calls[0][0]));
      expect(parsed.context).toBeUndefined();
    });

    it('setDefaultContext applies to all subsequent logs', () => {
      const logger = new Logger({ format: 'json' });
      logger.setDefaultContext({ agent: 'quality' });
      logger.info('msg1');
      logger.info('msg2');

      const p1 = JSON.parse(String(output.logSpy.mock.calls[0][0]));
      const p2 = JSON.parse(String(output.logSpy.mock.calls[1][0]));
      expect(p1.context.agent).toBe('quality');
      expect(p2.context.agent).toBe('quality');
    });

    it('per-call context merges with default context', () => {
      const logger = new Logger({ format: 'json' });
      logger.setDefaultContext({ agent: 'security' });
      logger.info('msg', { tool: 'read' });

      const parsed = JSON.parse(String(output.logSpy.mock.calls[0][0]));
      expect(parsed.context.agent).toBe('security');
      expect(parsed.context.tool).toBe('read');
    });

    it('per-call context overrides default context', () => {
      const logger = new Logger({ format: 'json' });
      logger.setDefaultContext({ agent: 'security' });
      logger.info('switched', { agent: 'quality' });

      const parsed = JSON.parse(String(output.logSpy.mock.calls[0][0]));
      expect(parsed.context.agent).toBe('quality');
    });
  });

  describe('child logger', () => {
    it('inherits parent options and default context', () => {
      const parent = new Logger({ format: 'json', level: 'debug' });
      parent.setDefaultContext({ agent: 'security' });

      const child = parent.child({ tool: 'grep' });
      child.debug('child msg');

      const parsed = JSON.parse(String(output.logSpy.mock.calls[0][0]));
      expect(parsed.context.agent).toBe('security');
      expect(parsed.context.tool).toBe('grep');
    });

    it('child context does not affect parent', () => {
      const parent = new Logger({ format: 'json' });

      const child = parent.child({ agent: 'child-agent' });
      child.info('from child');
      parent.info('from parent');

      const childParsed = JSON.parse(String(output.logSpy.mock.calls[0][0]));
      const parentParsed = JSON.parse(String(output.logSpy.mock.calls[1][0]));
      expect(childParsed.context.agent).toBe('child-agent');
      expect(parentParsed.context).toBeUndefined();
    });
  });

  describe('data output', () => {
    it('human format outputs data as indented lines', () => {
      const logger = new Logger({ format: 'human' });
      logger.info('with data', undefined, { key: 'value' });

      // Two calls: one for message, one for data
      expect(output.logSpy.mock.calls.length).toBe(2);
    });

    it('human format outputs string data directly', () => {
      const logger = new Logger({ format: 'human' });
      logger.info('with string data', undefined, 'raw text');

      expect(output.logSpy.mock.calls.length).toBe(2);
      const dataCall = String(output.logSpy.mock.calls[1][0]);
      expect(dataCall).toContain('raw text');
    });

    it('json format includes data in the JSON entry', () => {
      const logger = new Logger({ format: 'json' });
      logger.info('msg', undefined, { key: 'value' });

      const parsed = JSON.parse(String(output.logSpy.mock.calls[0][0]));
      expect(parsed.data).toEqual({ key: 'value' });
    });
  });

  describe('convenience methods', () => {
    it('agentStart logs agent context', () => {
      const logger = new Logger({ format: 'json' });
      logger.agentStart('security');

      const parsed = JSON.parse(String(output.logSpy.mock.calls[0][0]));
      expect(parsed.context.agent).toBe('security');
      expect(parsed.message).toContain('Starting review');
    });

    it('agentComplete includes issue count', () => {
      const logger = new Logger({ format: 'json' });
      logger.agentComplete('quality', 5);

      const parsed = JSON.parse(String(output.logSpy.mock.calls[0][0]));
      expect(parsed.context.agent).toBe('quality');
      expect(parsed.message).toContain('5 issue(s)');
    });

    it('skillLoaded includes skill and agent context', () => {
      const logger = new Logger({ format: 'json' });
      logger.skillLoaded('sql-patterns', 'security', { version: '1.0' });

      const parsed = JSON.parse(String(output.logSpy.mock.calls[0][0]));
      expect(parsed.context.agent).toBe('security');
      expect(parsed.context.skill).toBe('sql-patterns');
      expect(parsed.data).toEqual({ version: '1.0' });
    });

    it('toolOutput clips long output', () => {
      const logger = new Logger({ format: 'json' });
      const longOutput = 'x'.repeat(1000);
      logger.toolOutput('read', 'security', longOutput);

      const parsed = JSON.parse(String(output.logSpy.mock.calls[0][0]));
      expect(parsed.context.tool).toBe('read');
      // Data should be clipped (less than original 1000 chars)
      expect(String(parsed.data).length).toBeLessThan(1000);
    });

    it('toolOutput handles empty output', () => {
      const logger = new Logger({ format: 'json' });
      logger.toolOutput('bash', 'security', '');

      const parsed = JSON.parse(String(output.logSpy.mock.calls[0][0]));
      expect(parsed.data).toBe('[no output]');
    });

    it('noSkillCalls logs warning level', () => {
      const logger = new Logger({ format: 'json', level: 'warn' });
      logger.noSkillCalls('security');

      const parsed = JSON.parse(String(output.logSpy.mock.calls[0][0]));
      expect(parsed.level).toBe('warn');
      expect(parsed.context.agent).toBe('security');
    });

    it('agentInput clips long prompts', () => {
      const logger = new Logger({ format: 'json' });
      const longPrompt = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
      logger.agentInput('security', longPrompt);

      const parsed = JSON.parse(String(output.logSpy.mock.calls[0][0]));
      expect(parsed.context.agent).toBe('security');
      // clipped to 10 lines max
      expect(typeof parsed.data).toBe('string');
    });

    it('agentMessage clips long responses', () => {
      const logger = new Logger({ format: 'json' });
      logger.agentMessage('quality', 'short response');

      const parsed = JSON.parse(String(output.logSpy.mock.calls[0][0]));
      expect(parsed.context.agent).toBe('quality');
      expect(parsed.message).toContain('Agent response');
    });
  });
});

// ── Module-level functions ───────────────────────────────────────

describe('module functions', () => {
  let output: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    output = captureOutput();
  });

  afterEach(() => {
    output.restore();
  });

  it('createLogger returns a new Logger instance', () => {
    const logger = createLogger({ level: 'debug', format: 'json' });
    logger.debug('test');

    const parsed = JSON.parse(String(output.logSpy.mock.calls[0][0]));
    expect(parsed.level).toBe('debug');
  });

  it('configureLogger replaces default logger', () => {
    configureLogger({ format: 'json', level: 'debug' });
    const logger = getLogger();
    logger.debug('from default');

    const parsed = JSON.parse(String(output.logSpy.mock.calls[0][0]));
    expect(parsed.message).toBe('from default');

    // Reset to avoid affecting other tests
    configureLogger({});
  });

  it('getLogger returns the configured default', () => {
    const logger = getLogger();
    expect(logger).toBeInstanceOf(Logger);
  });
});
