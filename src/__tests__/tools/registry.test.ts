import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { toOpenAITools, dispatchToolCall } from '../../tools/registry.js';
import { clampLookback } from '../../tools/types.js';
import type { ToolContext, ToolDefinition } from '../../tools/types.js';

const ctx: ToolContext = {
  region: 'us-east-1',
  timeoutMs: 1000,
  maxResultChars: 20,
  defaultLookbackMinutes: 60,
  maxLookbackMinutes: 1440,
};

function fakeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'echo',
    description: 'Echoes the message back',
    parametersJsonSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
    argsSchema: z.object({ message: z.string() }),
    handler: async (args) => `echo: ${(args as { message: string }).message}`,
    ...overrides,
  };
}

describe('tools/registry', () => {
  describe('toOpenAITools', () => {
    it('maps definitions to the function-tool payload', () => {
      const result = toOpenAITools([fakeTool()]);

      expect(result).toEqual([
        {
          type: 'function',
          function: {
            name: 'echo',
            description: 'Echoes the message back',
            parameters: {
              type: 'object',
              properties: { message: { type: 'string' } },
              required: ['message'],
            },
          },
        },
      ]);
    });
  });

  describe('dispatchToolCall', () => {
    it('runs a valid tool and returns its result', async () => {
      const result = await dispatchToolCall('echo', JSON.stringify({ message: 'hi' }), ctx, [
        fakeTool(),
      ]);
      expect(result).toBe('echo: hi');
    });

    it('returns an error string for an unknown tool (no throw)', async () => {
      const result = await dispatchToolCall('does_not_exist', '{}', ctx, [fakeTool()]);
      expect(result).toContain('unknown tool');
      expect(result).toContain('echo');
    });

    it('returns an error string for non-JSON arguments', async () => {
      const result = await dispatchToolCall('echo', 'not json', ctx, [fakeTool()]);
      expect(result).toContain('not valid JSON');
    });

    it('returns an error string for schema-invalid arguments', async () => {
      const result = await dispatchToolCall('echo', JSON.stringify({ message: 123 }), ctx, [
        fakeTool(),
      ]);
      expect(result).toContain('invalid arguments');
      expect(result).toContain('message');
    });

    it('returns an error string when the handler throws (loop continues)', async () => {
      const throwing = fakeTool({
        handler: async () => {
          throw new Error('boom');
        },
      });
      const result = await dispatchToolCall('echo', JSON.stringify({ message: 'x' }), ctx, [
        throwing,
      ]);
      expect(result).toContain('failed');
      expect(result).toContain('boom');
    });

    it('truncates results longer than maxResultChars', async () => {
      const long = fakeTool({
        handler: async () => 'x'.repeat(100),
      });
      const result = await dispatchToolCall('echo', JSON.stringify({ message: 'x' }), ctx, [long]);
      expect(result.length).toBe(ctx.maxResultChars);
      expect(result.endsWith('…[truncated]')).toBe(true);
    });

    it('passes the tool context through to the handler', async () => {
      const handler = vi.fn(async (_args: unknown, received: ToolContext) => received.region);
      const tool = fakeTool({ handler: handler as ToolDefinition['handler'] });
      const result = await dispatchToolCall('echo', JSON.stringify({ message: 'x' }), ctx, [tool]);
      expect(result).toBe('us-east-1');
      expect(handler).toHaveBeenCalledWith({ message: 'x' }, ctx);
    });
  });

  describe('clampLookback', () => {
    it('defaults when undefined', () => {
      expect(clampLookback(undefined, ctx)).toBe(60);
    });

    it('defaults on non-positive or non-finite values', () => {
      expect(clampLookback(0, ctx)).toBe(60);
      expect(clampLookback(-5, ctx)).toBe(60);
      expect(clampLookback(Number.NaN, ctx)).toBe(60);
    });

    it('caps at the configured max', () => {
      expect(clampLookback(99999, ctx)).toBe(1440);
    });

    it('passes through an in-range value', () => {
      expect(clampLookback(120, ctx)).toBe(120);
    });
  });
});
