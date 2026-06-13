import type { ZodType, ZodTypeDef } from 'zod';

/**
 * Runtime context passed to every tool handler. Carries the bounds that keep a
 * single tool call from running away (timeout, result size, query window).
 */
export interface ToolContext {
  region: string;
  maxAttempts: number;
  timeoutMs: number;
  maxResultChars: number;
  defaultLookbackMinutes: number;
  maxLookbackMinutes: number;
  defaultStartTime?: string | undefined;
  defaultEndTime?: string | undefined;
}

/**
 * A read-only evidence-gathering tool the Investigate stage can call.
 *
 * `parametersJsonSchema` is the OpenAI-compatible function parameter schema sent
 * to the model; `argsSchema` validates the model-supplied args at runtime before
 * the handler runs. `handler` returns text that is fed back to the model.
 */
export interface ToolDefinition<A = unknown> {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
  argsSchema: ZodType<A, ZodTypeDef, unknown>;
  handler: (args: A, ctx: ToolContext) => Promise<string>;
}

/**
 * Clamp a model-requested lookback window to the configured bounds. Missing,
 * non-finite, or non-positive values fall back to the default window; anything
 * larger than the max is capped. Tools call this so no query can scan an
 * unbounded time range.
 */
export function clampLookback(
  requestedMinutes: number | undefined,
  ctx: ToolContext
): number {
  if (requestedMinutes === undefined || !Number.isFinite(requestedMinutes) || requestedMinutes <= 0) {
    return ctx.defaultLookbackMinutes;
  }
  return Math.min(requestedMinutes, ctx.maxLookbackMinutes);
}

function parseIsoDate(value: string, fieldName: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid ISO timestamp, got: ${value}`);
  }
  return date;
}

export function resolveToolTimeRange(
  requestedStartTime: string | undefined,
  requestedEndTime: string | undefined,
  requestedLookbackMinutes: number | undefined,
  ctx: ToolContext
): { startTime: Date; endTime: Date; source: 'requested_absolute' | 'context_absolute' | 'lookback' } {
  if (requestedStartTime !== undefined || requestedEndTime !== undefined) {
    if (!requestedStartTime || !requestedEndTime) {
      throw new Error('start_time and end_time must be provided together');
    }

    const startTime = parseIsoDate(requestedStartTime, 'start_time');
    const endTime = parseIsoDate(requestedEndTime, 'end_time');
    if (startTime >= endTime) {
      throw new Error('start_time must be before end_time');
    }
    return { startTime, endTime, source: 'requested_absolute' };
  }

  if (ctx.defaultStartTime && ctx.defaultEndTime) {
    const startTime = parseIsoDate(ctx.defaultStartTime, 'defaultStartTime');
    const endTime = parseIsoDate(ctx.defaultEndTime, 'defaultEndTime');
    if (startTime < endTime) {
      return { startTime, endTime, source: 'context_absolute' };
    }
  }

  const lookbackMinutes = clampLookback(requestedLookbackMinutes, ctx);
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - lookbackMinutes * 60 * 1000);
  return { startTime, endTime, source: 'lookback' };
}
