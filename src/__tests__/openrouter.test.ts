import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callOpenRouter, LlmError } from '../llm/openrouter.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('openrouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns message content on success', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"summary": "test"}',
            },
          },
        ],
      }),
    };

    mockFetch.mockResolvedValue(mockResponse);

    const result = await callOpenRouter(
      'test prompt',
      'test-api-key',
      'openai/gpt-4o-mini',
      'https://openrouter.ai/api/v1',
      5000
    );

    expect(result).toBe('{"summary": "test"}');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-api-key',
        }),
      })
    );

    const callArgs = mockFetch.mock.calls[0] as unknown[];
    const requestInit = callArgs[1] as { body: string };
    const body = JSON.parse(requestInit.body) as {
      model: string;
      temperature: number;
      response_format: { type: string };
    };

    expect(body.model).toBe('openai/gpt-4o-mini');
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('errors on 429 status', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'Rate limit exceeded',
    });

    await expect(
      callOpenRouter(
        'test',
        'key',
        'model',
        'https://openrouter.ai/api/v1',
        5000
      )
    ).rejects.toThrow(LlmError);
  });

  it('errors on 500 status', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal server error',
    });

    await expect(
      callOpenRouter(
        'test',
        'key',
        'model',
        'https://openrouter.ai/api/v1',
        5000
      )
    ).rejects.toThrow(LlmError);
  });

  it('errors on missing content', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {},
          },
        ],
      }),
    });

    await expect(
      callOpenRouter(
        'test',
        'key',
        'model',
        'https://openrouter.ai/api/v1',
        5000
      )
    ).rejects.toThrow(LlmError);
  });

  it('errors on timeout', async () => {
    mockFetch.mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => {
            const error = new Error('Aborted');
            (error as { name?: string }).name = 'AbortError';
            reject(error);
          }, 100);
        })
    );

    await expect(
      callOpenRouter(
        'test',
        'key',
        'model',
        'https://openrouter.ai/api/v1',
        50
      )
    ).rejects.toThrow(LlmError);
  }, 10000);
});
