import { parseJevResponse, type JevResponse } from './schema.js';

export const JEV_API_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
// Pin the model because rubric behavior and any confidence thresholds must be
// validated per version. The response still records the resolved model id.
export const JEV_MODEL = 'jev-1.13.0';

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type SleepImplementation = (milliseconds: number) => Promise<void>;

export type JevClientErrorCode =
  | 'missing_key'
  | 'rejected_key'
  | 'token_limit'
  | 'invalid_response'
  | 'timeout'
  | 'rate_limit'
  | 'overload'
  | 'network_failure'
  | 'invalid_request'
  | 'api_error';

export interface JevClientOptions {
  apiKey: string;
  fetch?: FetchImplementation;
  sleep?: SleepImplementation;
  timeoutMs?: number;
  maxRetries?: number;
}

export class JevClientError extends Error {
  constructor(
    readonly code: JevClientErrorCode,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'JevClientError';
  }
}

export class JevClient {
  readonly #apiKey: string;
  readonly #fetch: FetchImplementation;
  readonly #sleep: SleepImplementation;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;

  constructor(options: JevClientOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new JevClientError('missing_key', 'JEV_API_KEY is required to run Jev evaluation.');
    }
    this.#apiKey = apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#sleep =
      options.sleep ?? ((milliseconds) => new Promise((r) => setTimeout(r, milliseconds)));
    this.#timeoutMs = options.timeoutMs ?? 30000;
    this.#maxRetries = options.maxRetries ?? 2;
  }

  async evaluate(state: unknown, questions: unknown): Promise<JevResponse> {
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);

      try {
        const response = await this.#fetch(JEV_API_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ state, model: JEV_MODEL, questions }),
          signal: controller.signal,
        });

        if (response.ok) {
          try {
            return parseJevResponse(await response.json());
          } catch {
            throw new JevClientError(
              'invalid_response',
              'Jev returned a response that did not match its documented schema.'
            );
          }
        }

        if (isRetryable(response.status) && attempt < this.#maxRetries) {
          await this.#sleep(retryDelayMs(response.headers.get('retry-after'), attempt));
          continue;
        }

        throw await statusError(response);
      } catch (error) {
        if (error instanceof JevClientError) throw error;
        if (isAbortError(error)) {
          throw new JevClientError('timeout', `Jev did not respond within ${this.#timeoutMs}ms.`);
        }
        throw new JevClientError(
          'network_failure',
          'Could not reach the Jev API. Check network access and try again.'
        );
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new JevClientError('api_error', 'Jev request failed after retries.');
  }
}

export function createJevClientFromEnvironment(
  options: Omit<JevClientOptions, 'apiKey'> = {}
): JevClient {
  return new JevClient({
    ...options,
    apiKey: process.env.JEV_API_KEY ?? '',
  });
}

function isRetryable(status: number): boolean {
  return status === 429 || status === 529 || status >= 500;
}

async function statusError(response: Response): Promise<JevClientError> {
  const status = response.status;
  const errorType = await readErrorType(response);

  if (status === 400 && errorType === 'max_tokens_exceeded') {
    return new JevClientError(
      'token_limit',
      'Jev input limit was exceeded. Reduce review context or split the change.',
      status
    );
  }
  if (status === 401) {
    return new JevClientError('rejected_key', 'Jev rejected JEV_API_KEY.', status);
  }
  if (status === 422) {
    return new JevClientError(
      'invalid_request',
      'Jev rejected the supplied evaluation context or questions.',
      status
    );
  }
  if (status === 429) {
    return new JevClientError(
      'rate_limit',
      'Jev rate-limited the request after retries. Try again shortly.',
      status
    );
  }
  if (status === 529) {
    return new JevClientError(
      'overload',
      'Jev remained overloaded after retries. Try again shortly.',
      status
    );
  }
  return new JevClientError('api_error', `Jev API request failed with HTTP ${status}.`, status);
}

async function readErrorType(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (!isRecord(body) || !isRecord(body.detail)) return undefined;
    return typeof body.detail.error_type === 'string' ? body.detail.error_type : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function retryDelayMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5000);

    const retryDate = Date.parse(retryAfter);
    if (Number.isFinite(retryDate)) return Math.min(Math.max(retryDate - Date.now(), 0), 5000);
  }
  return 250 * 2 ** attempt;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
