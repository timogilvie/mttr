import { LlmError } from './openrouter.js';
import { requestWithRetry } from './backoff.js';
import { CircuitBreaker } from '../util/circuitBreaker.js';
import { toOpenAITools, dispatchToolCall } from '../tools/registry.js';
import type { ToolDefinition, ToolContext } from '../tools/types.js';

/**
 * Multi-turn OpenRouter tool loop that drives the Investigate stage's read-only
 * tools. Separate from the single-shot `callOpenRouter` so the proven Classify
 * path stays untouched.
 *
 * Bounded by design: per-run iteration and tool-call budgets, a whole-loop
 * timeout (AbortController), a circuit breaker on consecutive failing tool
 * turns, and 429/5xx backoff on every request. When the model is unavailable or
 * does not support tools, the loop retries once with the fallback model.
 */

export class ToolLoopError extends LlmError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'ToolLoopError';
  }
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
}

export interface ToolLoopOptions {
  prompt: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  fallbackModel?: string;
  tools: ToolDefinition[];
  toolContext: ToolContext;
  maxIterations: number;
  maxToolCalls: number;
  maxConcurrency: number;
  consecutiveFailureLimit: number;
  llmTimeoutMs: number;
  retry: { maxRetries: number; baseMs: number; maxMs: number };
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export interface ToolLoopResult {
  content: string;
  iterations: number;
  toolCalls: number;
  usedFallback: boolean;
}

interface TurnResult {
  content: string | null;
  toolCalls: ToolCall[];
}

async function mapWithConcurrency<I, O>(
  items: I[],
  limit: number,
  fn: (item: I, index: number) => Promise<O>
): Promise<O[]> {
  const results = new Array<O>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function isModelOrToolError(error: unknown): boolean {
  if (!(error instanceof LlmError)) {
    return false;
  }
  const cause = error.cause as { status?: number; body?: string } | undefined;
  const status = cause?.status;
  const body = cause?.body ?? error.message;
  if (status === 404) {
    return true;
  }
  if ((status === 400 || status === 422) && /model|tool|function|unsupported|not support/i.test(body)) {
    return true;
  }
  return false;
}

export async function callOpenRouterWithTools(opts: ToolLoopOptions): Promise<ToolLoopResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.llmTimeoutMs);

  const messages: ChatMessage[] = [{ role: 'user', content: opts.prompt }];
  const breaker = new CircuitBreaker(opts.consecutiveFailureLimit);
  let model = opts.model;
  let usedFallback = false;
  let iterations = 0;
  let toolCalls = 0;

  async function callOnce(offerTools: boolean): Promise<TurnResult> {
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: 0,
    };
    // Deliberately omit response_format while tools are offered: several
    // providers reject json-mode together with tool_calls. The stage enforces
    // strict JSON on the final answer instead.
    if (offerTools && opts.tools.length > 0) {
      body['tools'] = toOpenAITools(opts.tools);
    }

    const response = await requestWithRetry(
      () =>
        fetchFn(`${opts.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
      { maxRetries: opts.retry.maxRetries, baseMs: opts.retry.baseMs, maxMs: opts.retry.maxMs }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new LlmError(`OpenRouter returned status ${response.status}`, {
        status: response.status,
        body: text.slice(0, 200),
      });
    }

    const data = (await response.json()) as ChatResponse;
    const message = data.choices?.[0]?.message;
    if (!message) {
      throw new LlmError('OpenRouter response missing message');
    }
    return { content: message.content ?? null, toolCalls: message.tool_calls ?? [] };
  }

  async function callTurn(offerTools: boolean): Promise<TurnResult> {
    try {
      return await callOnce(offerTools);
    } catch (error) {
      if (!usedFallback && opts.fallbackModel && isModelOrToolError(error)) {
        usedFallback = true;
        model = opts.fallbackModel;
        console.warn(`[ToolLoop] Primary model failed; falling back to ${model}`);
        return await callOnce(offerTools);
      }
      throw error;
    }
  }

  try {
    for (;;) {
      const budgetExhausted = iterations >= opts.maxIterations || toolCalls >= opts.maxToolCalls;
      const offerTools = opts.tools.length > 0 && !budgetExhausted && !breaker.tripped;

      let turn: TurnResult;
      try {
        turn = await callTurn(offerTools);
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          throw new ToolLoopError(
            `Investigate tool loop exceeded its ${opts.llmTimeoutMs}ms time budget`,
            error
          );
        }
        throw error;
      }
      iterations += 1;

      if (!offerTools || turn.toolCalls.length === 0) {
        return { content: turn.content ?? '', iterations, toolCalls, usedFallback };
      }

      // Record the assistant turn (with its tool_calls) before answering them.
      messages.push({ role: 'assistant', content: turn.content ?? '', tool_calls: turn.toolCalls });

      const outcomes = await mapWithConcurrency(
        turn.toolCalls,
        opts.maxConcurrency,
        async (call) => {
          if (toolCalls >= opts.maxToolCalls) {
            return {
              id: call.id,
              content: 'Error: tool-call budget exhausted; not executed.',
              failed: true,
            };
          }
          toolCalls += 1;
          console.log(`[ToolLoop] Calling tool ${call.function.name}`);
          const content = await dispatchToolCall(
            call.function.name,
            call.function.arguments,
            opts.toolContext,
            opts.tools
          );
          console.log(
            `[ToolLoop] Tool ${call.function.name} ${content.startsWith('Error:') ? 'failed' : 'succeeded'}`
          );
          return { id: call.id, content, failed: content.startsWith('Error:') };
        }
      );

      for (const outcome of outcomes) {
        messages.push({ role: 'tool', tool_call_id: outcome.id, content: outcome.content });
      }

      if (outcomes.some((outcome) => !outcome.failed)) {
        breaker.recordSuccess();
      } else {
        breaker.recordFailure();
        if (breaker.tripped) {
          console.warn(
            `[ToolLoop] Circuit breaker tripped after ${breaker.failures} consecutive failing tool turns; forcing final answer`
          );
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
