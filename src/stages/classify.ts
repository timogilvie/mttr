import type { Config } from '../config.js';
import type { StageInput, StageResult, ClassificationResult } from '../types.js';
import { fetchReport } from '../report/fetchReport.js';
import { buildClassifyPrompt } from '../prompts/classifyPrompt.js';
import { callOpenRouter } from '../llm/openrouter.js';
import { parseClassification } from '../validation/classificationSchema.js';
import { stripMarkdownFences } from '../llm/json.js';

async function attemptParse(
  responseText: string,
  config: Config,
  isRetry: boolean,
  originalPrompt?: string
): Promise<ClassificationResult | null> {
  try {
    const cleaned = stripMarkdownFences(responseText);
    const parsed = JSON.parse(cleaned) as unknown;
    return parseClassification(parsed);
  } catch (error) {
    if (isRetry) {
      console.error('[Classify] Retry also failed to parse/validate classification', error);
      return null;
    }

    console.warn('[Classify] Initial response invalid, attempting repair retry', error);

    const repairInstruction = `\n\nThe previous response was invalid JSON or did not match the required schema. Please return a valid JSON object matching the exact schema specified in the instructions.`;
    const repairPrompt = (originalPrompt ?? '') + repairInstruction;

    try {
      const retryResponse = await callOpenRouter(
        repairPrompt,
        config.openrouter.apiKey,
        config.openrouter.model,
        config.openrouter.baseUrl,
        config.timeouts.llmMs
      );

      return await attemptParse(retryResponse, config, true);
    } catch (retryError) {
      console.error('[Classify] Repair retry call failed', retryError);
      return null;
    }
  }
}

function createFallbackResult(reason: string): ClassificationResult {
  return {
    summary: `Classification failed: ${reason}`,
    overall_severity: 'NONE',
    incidents: [],
    findings: [],
  };
}

export async function run(_input: StageInput, config: Config): Promise<StageResult> {
  const timestamp = new Date().toISOString();

  try {
    const report = await fetchReport(
      config.healthReport.s3Uri,
      config.aws.region,
      config.timeouts.s3Ms
    );

    const prompt = buildClassifyPrompt(report);

    const llmResponse = await callOpenRouter(
      prompt,
      config.openrouter.apiKey,
      config.openrouter.model,
      config.openrouter.baseUrl,
      config.timeouts.llmMs
    );

    const classificationResult = await attemptParse(llmResponse, config, false, prompt);

    if (!classificationResult) {
      const fallback = createFallbackResult('LLM returned invalid JSON after retry');
      return {
        stage: 'Classify',
        status: 'success',
        timestamp,
        data: fallback,
      };
    }

    return {
      stage: 'Classify',
      status: 'success',
      timestamp,
      data: classificationResult,
    };
  } catch (error) {
    console.error('[Classify] Stage execution failed', error);
    return {
      stage: 'Classify',
      status: 'error',
      timestamp,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
