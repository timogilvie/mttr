import type { ZodType } from 'zod';

/**
 * Runtime context passed to every tool handler. Carries the bounds that keep a
 * single tool call from running away (timeout, result size, query window).
 */
export interface ToolContext {
  region: string;
  timeoutMs: number;
  maxResultChars: number;
  defaultLookbackMinutes: number;
  maxLookbackMinutes: number;
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
  argsSchema: ZodType<A>;
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
