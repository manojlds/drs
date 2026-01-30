/**
 * Structured logging utility for DRS
 *
 * Supports both human-readable (colored CLI) and JSON structured output.
 * Provides log levels, context tracking, and consistent formatting.
 */

import chalk from 'chalk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFormat = 'human' | 'json';

export interface LogContext {
  /** Agent type (e.g., 'security', 'unified-reviewer') */
  agent?: string;
  /** Tool name (e.g., 'drs_skill', 'write_json_output') */
  tool?: string;
  /** Skill name if applicable */
  skill?: string;
  /** Session ID */
  sessionId?: string;
  /** Additional metadata */
  [key: string]: unknown;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
  data?: unknown;
}

interface LoggerOptions {
  /** Minimum log level to output */
  level: LogLevel;
  /** Output format */
  format: LogFormat;
  /** Include timestamps in output */
  timestamps: boolean;
  /** Enable colored output (human format only) */
  colors: boolean;
}

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LOG_LEVEL_COLORS: Record<LogLevel, (s: string) => string> = {
  debug: chalk.gray,
  info: chalk.cyan,
  warn: chalk.yellow,
  error: chalk.red,
};

const LOG_LEVEL_ICONS: Record<LogLevel, string> = {
  debug: '🔍',
  info: 'ℹ️',
  warn: '⚠️',
  error: '❌',
};

class Logger {
  private options: LoggerOptions;
  private defaultContext: LogContext = {};

  constructor(options: Partial<LoggerOptions> = {}) {
    this.options = {
      level: options.level ?? 'info',
      format: options.format ?? 'human',
      timestamps: options.timestamps ?? false,
      colors: options.colors ?? true,
    };
  }

  /**
   * Set the minimum log level
   */
  setLevel(level: LogLevel): void {
    this.options.level = level;
  }

  /**
   * Set the output format
   */
  setFormat(format: LogFormat): void {
    this.options.format = format;
  }

  /**
   * Enable or disable timestamps
   */
  setTimestamps(enabled: boolean): void {
    this.options.timestamps = enabled;
  }

  /**
   * Set default context that will be included in all log entries
   */
  setDefaultContext(context: LogContext): void {
    this.defaultContext = context;
  }

  /**
   * Create a child logger with additional default context
   */
  child(context: LogContext): Logger {
    const child = new Logger(this.options);
    child.defaultContext = { ...this.defaultContext, ...context };
    return child;
  }

  /**
   * Check if a log level should be output
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[this.options.level];
  }

  /**
   * Format and output a log entry
   */
  private log(level: LogLevel, message: string, context?: LogContext, data?: unknown): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: { ...this.defaultContext, ...context },
      data,
    };

    // Remove empty context
    if (entry.context && Object.keys(entry.context).length === 0) {
      delete entry.context;
    }

    if (this.options.format === 'json') {
      this.outputJson(entry);
    } else {
      this.outputHuman(entry);
    }
  }

  /**
   * Output as JSON (structured logging)
   */
  private outputJson(entry: LogEntry): void {
    const output = entry.level === 'error' ? console.error : console.log;
    output(JSON.stringify(entry));
  }

  /**
   * Output as human-readable (colored CLI)
   */
  private outputHuman(entry: LogEntry): void {
    const output = entry.level === 'error' ? console.error : console.log;
    const colorFn = this.options.colors ? LOG_LEVEL_COLORS[entry.level] : (s: string) => s;
    const icon = LOG_LEVEL_ICONS[entry.level];

    let prefix = '';

    // Add timestamp if enabled
    if (this.options.timestamps) {
      prefix += chalk.gray(`[${entry.timestamp}] `);
    }

    // Add context prefix (agent/tool/skill)
    if (entry.context?.agent) {
      prefix += chalk.cyan(`[${entry.context.agent}] `);
    }
    if (entry.context?.tool) {
      prefix += chalk.magenta(`[${entry.context.tool}] `);
    }
    if (entry.context?.skill) {
      prefix += chalk.green(`[skill:${entry.context.skill}] `);
    }

    // Format the message
    const formattedMessage = `${prefix}${icon} ${colorFn(entry.message)}`;
    output(formattedMessage);

    // Output data if present (indented)
    if (entry.data !== undefined) {
      const dataStr =
        typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2);
      const indentedData = dataStr
        .split('\n')
        .map((line) => `   ${line}`)
        .join('\n');
      output(chalk.gray(indentedData));
    }
  }

  // Log level methods
  debug(message: string, context?: LogContext, data?: unknown): void {
    this.log('debug', message, context, data);
  }

  info(message: string, context?: LogContext, data?: unknown): void {
    this.log('info', message, context, data);
  }

  warn(message: string, context?: LogContext, data?: unknown): void {
    this.log('warn', message, context, data);
  }

  error(message: string, context?: LogContext, data?: unknown): void {
    this.log('error', message, context, data);
  }

  // Convenience methods for common patterns

  /**
   * Log a skill tool call
   */
  skillLoaded(skillName: string, agent: string, metadata?: Record<string, unknown>): void {
    this.info(`Loaded skill: ${skillName}`, { agent, tool: 'drs_skill', skill: skillName }, metadata);
  }

  /**
   * Log a tool output
   */
  toolOutput(toolName: string, agent: string, output: string): void {
    this.debug(`Tool output`, { agent, tool: toolName }, output || '[no output]');
  }

  /**
   * Log agent message
   */
  agentMessage(agent: string, content: string): void {
    this.debug(`Agent response`, { agent }, content);
  }

  /**
   * Log start of agent review
   */
  agentStart(agent: string): void {
    this.info(`Starting review`, { agent });
  }

  /**
   * Log end of agent review
   */
  agentComplete(agent: string, issueCount: number): void {
    this.info(`Completed review - found ${issueCount} issue(s)`, { agent });
  }

  /**
   * Log missing skill call warning
   */
  noSkillCalls(agent: string): void {
    this.warn(`No skill tool calls detected during review`, { agent });
  }
}

// Default logger instance
let defaultLogger = new Logger();

/**
 * Configure the default logger
 */
export function configureLogger(options: Partial<LoggerOptions>): void {
  defaultLogger = new Logger(options);
}

/**
 * Get the default logger instance
 */
export function getLogger(): Logger {
  return defaultLogger;
}

/**
 * Create a new logger with specific options
 */
export function createLogger(options: Partial<LoggerOptions> = {}): Logger {
  return new Logger(options);
}

export { Logger };
export default defaultLogger;
