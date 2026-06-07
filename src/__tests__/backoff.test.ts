import { describe, it, expect, vi } from 'vitest';
import {
  requestWithRetry,
  isRetryableStatus,
  computeBackoffDelayMs,
} from '../llm/backoff.js';

const noopSleep = async (): Promise<void> => {};

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

describe('backoff', () => {
  describe('isRetryableStatus', () => {
    it('treats 429 and 5xx as retryable, 4xx as not', () => {
      expect(isRetryableStatus(429)).toBe(true);
      expect(isRetryableStatus(500)).toBe(true);
      expect(isRetryableStatus(503)).toBe(true);
      expect(isRetryableStatus(400)).toBe(false);
      expect(isRetryableStatus(404)).toBe(false);
      expect(isRetryableStatus(200)).toBe(false);
    });
  });

  describe('computeBackoffDelayMs', () => {
    it('grows exponentially and caps at maxMs (full jitter ceiling)', () => {
      const max = (attempt: number) => computeBackoffDelayMs(attempt, 1000, 30000, () => 1);
      expect(max(0)).toBe(1000);
      expect(max(1)).toBe(2000);
      expect(max(2)).toBe(4000);
      expect(max(10)).toBe(30000); // 1000 * 2^10 capped at 30000
    });

    it('applies jitter as a fraction of the ceiling', () => {
      expect(computeBackoffDelayMs(2, 1000, 30000, () => 0.5)).toBe(2000); // 0.5 * 4000
      expect(computeBackoffDelayMs(0, 1000, 30000, () => 0)).toBe(0);
    });
  });

  describe('requestWithRetry', () => {
    it('retries on 429 then returns the success', async () => {
      const doRequest = vi
        .fn<() => Promise<Response>>()
        .mockResolvedValueOnce(response(429))
        .mockResolvedValueOnce(response(200));

      const result = await requestWithRetry(doRequest, {
        maxRetries: 4,
        baseMs: 1,
        maxMs: 10,
        sleep: noopSleep,
      });

      expect(result.status).toBe(200);
      expect(doRequest).toHaveBeenCalledTimes(2);
    });

    it('honours the Retry-After header', async () => {
      const sleep = vi.fn(noopSleep);
      const doRequest = vi
        .fn<() => Promise<Response>>()
        .mockResolvedValueOnce(response(429, { 'Retry-After': '2' }))
        .mockResolvedValueOnce(response(200));

      await requestWithRetry(doRequest, { maxRetries: 4, baseMs: 1, maxMs: 10, sleep });

      expect(sleep).toHaveBeenCalledWith(2000);
    });

    it('gives up after maxRetries and returns the last response', async () => {
      const doRequest = vi.fn<() => Promise<Response>>().mockResolvedValue(response(429));

      const result = await requestWithRetry(doRequest, {
        maxRetries: 2,
        baseMs: 1,
        maxMs: 10,
        sleep: noopSleep,
      });

      expect(result.status).toBe(429);
      expect(doRequest).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it('does not retry non-retryable 4xx', async () => {
      const doRequest = vi.fn<() => Promise<Response>>().mockResolvedValue(response(400));

      const result = await requestWithRetry(doRequest, {
        maxRetries: 4,
        baseMs: 1,
        maxMs: 10,
        sleep: noopSleep,
      });

      expect(result.status).toBe(400);
      expect(doRequest).toHaveBeenCalledTimes(1);
    });

    it('retries transient network errors then succeeds', async () => {
      const doRequest = vi
        .fn<() => Promise<Response>>()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce(response(200));

      const result = await requestWithRetry(doRequest, {
        maxRetries: 4,
        baseMs: 1,
        maxMs: 10,
        sleep: noopSleep,
      });

      expect(result.status).toBe(200);
      expect(doRequest).toHaveBeenCalledTimes(2);
    });

    it('does not retry AbortError (timeout/cancellation)', async () => {
      const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
      const doRequest = vi.fn<() => Promise<Response>>().mockRejectedValue(abort);

      await expect(
        requestWithRetry(doRequest, { maxRetries: 4, baseMs: 1, maxMs: 10, sleep: noopSleep })
      ).rejects.toThrow('aborted');
      expect(doRequest).toHaveBeenCalledTimes(1);
    });

    it('rethrows the network error after exhausting retries', async () => {
      const doRequest = vi.fn<() => Promise<Response>>().mockRejectedValue(new Error('down'));

      await expect(
        requestWithRetry(doRequest, { maxRetries: 1, baseMs: 1, maxMs: 10, sleep: noopSleep })
      ).rejects.toThrow('down');
      expect(doRequest).toHaveBeenCalledTimes(2);
    });
  });
});
