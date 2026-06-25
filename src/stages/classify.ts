import type { Config } from '../config.js';
import type { StageInput, StageResult, ClassificationResult } from '../types.js';
import { fetchReport } from '../report/fetchReport.js';
import { buildClassifyPrompt } from '../prompts/classifyPrompt.js';
import { callOpenRouter } from '../llm/openrouter.js';
import { parseClassification } from '../validation/classificationSchema.js';
import { stripMarkdownFences } from '../llm/json.js';
import { enforceMandatoryIncidents } from '../report/mandatoryIncidents.js';
import { parseReportContext } from '../report/reportContext.js';
import { z } from 'zod';

function formatValidationDetails(error: unknown): string {
  if (
    error instanceof Error &&
    'zodError' in error &&
    error.zodError instanceof z.ZodError
  ) {
    return error.zodError.issues
      .slice(0, 5)
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
        const options =
          issue.code === 'invalid_enum_value' ? ` Allowed values: ${issue.options.join(', ')}.` : '';
        return `- ${path}: ${issue.message}.${options}`;
      })
      .join('\n');
  }

  return error instanceof Error ? error.message : String(error);
}

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

    const validationDetails = formatValidationDetails(error);
    const repairInstruction = `\n\nThe previous response was invalid JSON or did not match the required schema.\n\nValidation details:\n${validationDetails}\n\nReturn a valid JSON object matching the exact schema specified in the instructions. For investigation_plan.estimated_user_impact, use only one of: NONE, MINIMAL, PARTIAL, SIGNIFICANT, COMPLETE. Do not use severity labels such as LOW, MEDIUM, HIGH, or CRITICAL for estimated_user_impact.`;
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

function attachReportContext(
  classification: ClassificationResult,
  report: string
): ClassificationResult {
  const reportContext = parseReportContext(report);
  return reportContext ? { ...classification, report_context: reportContext } : classification;
}

async function classifyReport(report: string, config: Config, timestamp: string): Promise<StageResult> {
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
    const fallback = attachReportContext(
      createFallbackResult('LLM returned invalid JSON after retry'),
      report
    );
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
    data: attachReportContext(enforceMandatoryIncidents(classificationResult, report), report),
  };
}

export async function runWithReport(
  _input: StageInput,
  config: Config,
  report: string
): Promise<StageResult> {
  const timestamp = new Date().toISOString();

  try {
    return await classifyReport(report, config, timestamp);
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

export async function run(input: StageInput, config: Config): Promise<StageResult> {
  const timestamp = new Date().toISOString();

  try {
    const report = await fetchReport(
      config.healthReport.s3Uri,
      config.aws.region,
      config.timeouts.s3Ms
    );

    return await classifyReport(report, config, timestamp);
  } catch (error) {
    console.error('[Classify] Stage execution failed', error);
    return {
      stage: input.stage,
      status: 'error',
      timestamp,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
