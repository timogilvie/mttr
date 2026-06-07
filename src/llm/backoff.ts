/**
 * Retry-with-backoff for HTTP requests, shared by the OpenRouter callers.
 *
 * Retries on 429 and 5xx (and transient network errors), honouring a
 * `Retry-After` header when present and otherwise using exponential backoff with
 * full jitter, capped at `maxMs`. Non-retryable 4xx responses and aborts
 * (timeouts/cancellation) are never retried. When retries are exhausted the last
 * response is returned for the caller to handle (e.g. throw `LlmError`).
 */

export interface RetryOptions {
  maxRetries: number;
  baseMs: number;
  maxMs: number;
  /** Injectable for tests; defaults to a real timer-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to Math.random. */
  random?: () => number;
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

/**
 * Full-jitter exponential backoff: a random value in [0, min(maxMs, base*2^attempt)].
 * `attempt` is the 0-based index of the attempt that just failed.
 */
export function computeBackoffDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function requestWithRetry(
  doRequest: () => Promise<Response>,
  opts: RetryOptions
): Promise<Response> {
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await doRequest();
    } catch (error) {
      // Aborts (whole-loop timeout / cancellation) must not be retried.
      if ((error as { name?: string }).name === 'AbortError') {
        throw error;
      }
      if (attempt >= opts.maxRetries) {
        throw error;
      }
      await sleep(computeBackoffDelayMs(attempt, opts.baseMs, opts.maxMs, random));
      continue;
    }

    if (response.ok || !isRetryableStatus(response.status)) {
      return response;
    }

    if (attempt >= opts.maxRetries) {
      return response;
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    const delayMs = retryAfterMs ?? computeBackoffDelayMs(attempt, opts.baseMs, opts.maxMs, random);
    await sleep(delayMs);
  }
}
