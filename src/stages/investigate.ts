import type { Config } from '../config.js';
import type {
  StageInput,
  StageResult,
  ClassificationResult,
  InvestigationResult,
} from '../types.js';
import { buildInvestigatePrompt } from '../prompts/investigatePrompt.js';
import { callOpenRouterWithTools, type ToolLoopOptions } from '../llm/toolLoop.js';
import { getTools } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';
import { parseInvestigation } from '../validation/investigationSchema.js';
import { stripMarkdownFences } from '../llm/json.js';

function isNonActionable(classification: ClassificationResult): boolean {
  return classification.incidents.length === 0 && classification.findings.length === 0;
}

function noActionableResult(): InvestigationResult {
  return {
    summary: 'No actionable incidents or findings to investigate.',
    overall_assessment: 'NO_ACTIONABLE_INCIDENT',
    overall_severity: 'NONE',
    investigations: [],
    cross_cutting_observations: [],
    priority_order: [],
  };
}

function fallbackResult(reason: string): InvestigationResult {
  return {
    summary: `Investigation failed: ${reason}`,
    overall_assessment: 'INSUFFICIENT_EVIDENCE',
    overall_severity: 'NONE',
    investigations: [],
    cross_cutting_observations: [],
    priority_order: [],
  };
}

function buildToolContext(config: Config): ToolContext {
  return {
    region: config.aws.region,
    maxAttempts: config.aws.maxAttempts,
    timeoutMs: config.tools.timeoutMs,
    maxResultChars: config.tools.resultMaxChars,
    defaultLookbackMinutes: config.tools.defaultLookbackMinutes,
    maxLookbackMinutes: config.tools.maxLookbackMinutes,
  };
}

function tryParse(text: string): InvestigationResult | null {
  try {
    const cleaned = stripMarkdownFences(text);
    return parseInvestigation(JSON.parse(cleaned) as unknown);
  } catch {
    return null;
  }
}

export async function run(
  _input: StageInput,
  config: Config,
  classification: ClassificationResult
): Promise<StageResult> {
  const timestamp = new Date().toISOString();

  try {
    // Short-circuit: nothing actionable from Classify (including its failure
    // fallback, which is also empty). No LLM or tool calls.
    if (isNonActionable(classification)) {
      return {
        stage: 'Investigate',
        status: 'success',
        timestamp,
        data: noActionableResult(),
      };
    }

    const step1Json = JSON.stringify(classification, null, 2);
    const prompt = buildInvestigatePrompt(step1Json);

    const loopOptions: ToolLoopOptions = {
      prompt,
      apiKey: config.openrouter.apiKey,
      baseUrl: config.openrouter.baseUrl,
      model: config.investigate.model,
      fallbackModel: config.investigate.modelFallback,
      tools: getTools(),
      toolContext: buildToolContext(config),
      maxIterations: config.investigate.maxToolIterations,
      maxToolCalls: config.investigate.maxToolCalls,
      maxConcurrency: config.tools.maxConcurrency,
      consecutiveFailureLimit: config.investigate.consecutiveFailureLimit,
      llmTimeoutMs: config.investigate.llmTimeoutMs,
      retry: {
        maxRetries: config.openrouter.maxRetries,
        baseMs: config.openrouter.backoffBaseMs,
        maxMs: config.openrouter.backoffMaxMs,
      },
    };

    const first = await callOpenRouterWithTools(loopOptions);
    console.log(
      `[Investigate] Tool loop completed: ${first.iterations} iteration(s), ${first.toolCalls} tool call(s)` +
        (first.usedFallback ? ' (used fallback model)' : '')
    );

    const parsed = tryParse(first.content);
    if (parsed) {
      return { stage: 'Investigate', status: 'success', timestamp, data: parsed };
    }

    // One repair retry: ask for valid JSON only, with no tools (we already have
    // whatever evidence the first pass gathered).
    console.warn('[Investigate] Initial response invalid, attempting repair retry');
    const repairPrompt =
      `${prompt}\n\nThe previous response was invalid JSON or did not match the required schema. ` +
      `Return ONLY a valid JSON object matching the exact schema specified above. ` +
      `Previous response:\n${first.content}`;

    const repair = await callOpenRouterWithTools({
      ...loopOptions,
      prompt: repairPrompt,
      tools: [],
    });

    const repaired = tryParse(repair.content);
    if (repaired) {
      return { stage: 'Investigate', status: 'success', timestamp, data: repaired };
    }

    console.error('[Investigate] Repair retry also failed to parse/validate');
    return {
      stage: 'Investigate',
      status: 'success',
      timestamp,
      data: fallbackResult('LLM returned invalid JSON after retry'),
    };
  } catch (error) {
    console.error('[Investigate] Stage execution failed', error);
    return {
      stage: 'Investigate',
      status: 'error',
      timestamp,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
