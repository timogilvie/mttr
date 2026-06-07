import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { callOpenRouterWithTools, ToolLoopError, type ToolLoopOptions } from '../llm/toolLoop.js';
import type { ToolContext, ToolDefinition } from '../tools/types.js';

const ctx: ToolContext = {
  region: 'us-east-1',
  maxAttempts: 3,
  timeoutMs: 1000,
  maxResultChars: 8000,
  defaultLookbackMinutes: 60,
  maxLookbackMinutes: 1440,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function contentResponse(content: string): Response {
  return jsonResponse({ choices: [{ message: { content } }] });
}

function toolCallResponse(name: string, args: unknown): Response {
  return jsonResponse({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  });
}

function fakeTool(handler: ToolDefinition['handler']): ToolDefinition {
  return {
    name: 'echo',
    description: 'echo tool',
    parametersJsonSchema: { type: 'object' },
    argsSchema: z.object({}).passthrough(),
    handler,
  };
}

interface MockFetch {
  fn: ReturnType<typeof vi.fn>;
  asFetch: typeof fetch;
}

function mockFetch(): MockFetch {
  const fn = vi.fn();
  return { fn, asFetch: fn as unknown as typeof fetch };
}

function baseOpts(overrides: Partial<ToolLoopOptions>): ToolLoopOptions {
  return {
    prompt: 'investigate this',
    apiKey: 'k',
    baseUrl: 'https://test',
    model: 'primary/model',
    fallbackModel: 'fallback/model',
    tools: [fakeTool(async () => 'tool-result')],
    toolContext: ctx,
    maxIterations: 4,
    maxToolCalls: 8,
    maxConcurrency: 2,
    consecutiveFailureLimit: 3,
    llmTimeoutMs: 5000,
    retry: { maxRetries: 2, baseMs: 1, maxMs: 5 },
    ...overrides,
  };
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe('callOpenRouterWithTools', () => {
  it('returns content directly when the model makes no tool calls', async () => {
    const { fn, asFetch } = mockFetch();
    fn.mockResolvedValueOnce(contentResponse('{"ok":true}'));

    const result = await callOpenRouterWithTools(baseOpts({ fetchFn: asFetch }));

    expect(result.content).toBe('{"ok":true}');
    expect(result.iterations).toBe(1);
    expect(result.toolCalls).toBe(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('offers tools without response_format on the first turn', async () => {
    const { fn, asFetch } = mockFetch();
    fn.mockResolvedValueOnce(contentResponse('done'));

    await callOpenRouterWithTools(baseOpts({ fetchFn: asFetch }));

    const body = bodyOf(fn.mock.calls[0]!);
    expect(body['tools']).toBeDefined();
    expect(body['response_format']).toBeUndefined();
    expect(body['temperature']).toBe(0);
  });

  it('executes a tool call and feeds the result back as a tool message', async () => {
    const { fn, asFetch } = mockFetch();
    fn
      .mockResolvedValueOnce(toolCallResponse('echo', { x: '1' }))
      .mockResolvedValueOnce(contentResponse('final answer'));

    const result = await callOpenRouterWithTools(
      baseOpts({ fetchFn: asFetch, tools: [fakeTool(async () => 'tool-result')] })
    );

    expect(result.content).toBe('final answer');
    expect(result.toolCalls).toBe(1);
    expect(fn).toHaveBeenCalledTimes(2);

    const secondBody = bodyOf(fn.mock.calls[1]!);
    const messages = secondBody['messages'] as Array<Record<string, unknown>>;
    const toolMessage = messages.find((m) => m['role'] === 'tool');
    expect(toolMessage?.['content']).toBe('tool-result');
    expect(toolMessage?.['tool_call_id']).toBe('call-1');
    expect(messages.some((m) => m['role'] === 'assistant' && Array.isArray(m['tool_calls']))).toBe(
      true
    );
  });

  it('forces a final no-tools answer once maxIterations is reached', async () => {
    const { fn, asFetch } = mockFetch();
    fn.mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { tools?: unknown };
      return Promise.resolve(body.tools ? toolCallResponse('echo', {}) : contentResponse('forced'));
    });

    const result = await callOpenRouterWithTools(
      baseOpts({ fetchFn: asFetch, maxIterations: 1, tools: [fakeTool(async () => 'r')] })
    );

    expect(result.content).toBe('forced');
    const lastBody = bodyOf(fn.mock.calls[fn.mock.calls.length - 1]!);
    expect(lastBody['tools']).toBeUndefined();
  });

  it('forces a final answer once the tool-call budget is reached', async () => {
    const { fn, asFetch } = mockFetch();
    fn.mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { tools?: unknown };
      return Promise.resolve(body.tools ? toolCallResponse('echo', {}) : contentResponse('done'));
    });

    const result = await callOpenRouterWithTools(
      baseOpts({ fetchFn: asFetch, maxToolCalls: 1, maxIterations: 5, tools: [fakeTool(async () => 'r')] })
    );

    expect(result.content).toBe('done');
    expect(result.toolCalls).toBe(1);
  });

  it('stops offering tools after the circuit breaker trips', async () => {
    const { fn, asFetch } = mockFetch();
    fn.mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { tools?: unknown };
      return Promise.resolve(body.tools ? toolCallResponse('echo', {}) : contentResponse('gaveup'));
    });

    const result = await callOpenRouterWithTools(
      baseOpts({
        fetchFn: asFetch,
        consecutiveFailureLimit: 2,
        maxIterations: 10,
        maxToolCalls: 10,
        tools: [fakeTool(async () => 'Error: dependency down')],
      })
    );

    expect(result.content).toBe('gaveup');
  });

  it('maps a whole-loop abort to ToolLoopError', async () => {
    const { fn, asFetch } = mockFetch();
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    fn.mockRejectedValue(abort);

    await expect(callOpenRouterWithTools(baseOpts({ fetchFn: asFetch }))).rejects.toThrow(
      ToolLoopError
    );
  });

  it('retries once with the fallback model on a model-unavailable error', async () => {
    const { fn, asFetch } = mockFetch();
    fn
      .mockResolvedValueOnce(new Response('model not found', { status: 404 }))
      .mockResolvedValueOnce(contentResponse('ok'));

    const result = await callOpenRouterWithTools(baseOpts({ fetchFn: asFetch }));

    expect(result.content).toBe('ok');
    expect(result.usedFallback).toBe(true);
    expect(bodyOf(fn.mock.calls[1]!)['model']).toBe('fallback/model');
  });
});
