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
import { discoverLogGroupsTool, queryLogsTool } from '../tools/cloudwatchLogs.js';
import { metricsAndAlarmsTool } from '../tools/cloudwatchMetrics.js';
import { albAccessLogsTool } from '../tools/albAccessLogs.js';
import { ecsServiceEventsTool } from '../tools/ecs.js';
import { parseInvestigation } from '../validation/investigationSchema.js';
import { stripMarkdownFences } from '../llm/json.js';
import type { Finding, Incident, IncidentClassification } from '../types.js';

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

function buildToolContext(config: Config, classification: ClassificationResult): ToolContext {
  return {
    region: config.aws.region,
    maxAttempts: config.aws.maxAttempts,
    timeoutMs: config.tools.timeoutMs,
    maxResultChars: config.tools.resultMaxChars,
    defaultLookbackMinutes: config.tools.defaultLookbackMinutes,
    maxLookbackMinutes: config.tools.maxLookbackMinutes,
    defaultStartTime: classification.report_context?.window_start,
    defaultEndTime: classification.report_context?.window_end,
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

type InvestigationItem =
  | { id: string; kind: 'incident'; item: Incident }
  | { id: string; kind: 'finding'; item: Finding };

interface CandidateLogGroup {
  name: string;
  storedBytes?: number;
}

const MAX_STANDARD_LOG_GROUPS = 2;

const FOUR_XX_QUERY = `fields @timestamp, @message, @logStream
| parse @message /"(?<method>\\S+) (?<path>\\S+) HTTP\\/[^"]+" (?<status>\\d{3})/
| filter status like /^4/
| stats count(*) as requests by status, path
| sort requests desc
| limit 25`;

const FIVE_XX_QUERY = `fields @timestamp, @message, @logStream
| parse @message /"(?<method>\\S+) (?<path>\\S+) HTTP\\/[^"]+" (?<status>\\d{3})/
| filter status like /^5/
| stats count(*) as requests by status, path
| sort requests desc
| limit 25`;

const WARNING_QUERY = `fields @timestamp, @message, @logStream
| filter @message like /WARN|Warning|WARNING|warning/
| sort @timestamp desc
| limit 25`;

const ERROR_METRIC_PATTERN = /5xx|4xx|error|fault|failure/i;
const SPIKE_PADDING_MS = 15 * 60 * 1000;

interface SpikeWindow {
  start: string;
  end: string;
}

/**
 * Narrow drilldown queries to the span of non-zero error-metric datapoints
 * (padded by 15 minutes each side). Without this, queries over the full report
 * window return mostly healthy traffic and drown out a short error spike.
 */
function extractSpikeWindow(errorMetricEvidence: string[]): SpikeWindow | null {
  const times: number[] = [];
  for (const section of errorMetricEvidence) {
    for (const line of section.split('\n')) {
      const match = line.match(
        /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z): \w+=([\d.eE+-]+)/
      );
      if (!match || !match[1] || !match[2]) {
        continue;
      }
      const value = Number(match[2]);
      const timestamp = new Date(match[1]).getTime();
      if (Number.isFinite(value) && value > 0 && !Number.isNaN(timestamp)) {
        times.push(timestamp);
      }
    }
  }
  if (times.length === 0) {
    return null;
  }
  return {
    start: new Date(Math.min(...times) - SPIKE_PADDING_MS).toISOString(),
    end: new Date(Math.max(...times) + SPIKE_PADDING_MS).toISOString(),
  };
}

function allItems(classification: ClassificationResult): InvestigationItem[] {
  return [
    ...classification.incidents.map((item) => ({
      id: item.incident_id,
      kind: 'incident' as const,
      item,
    })),
    ...classification.findings.map((item, index) => ({
      id: `finding-${index}`,
      kind: 'finding' as const,
      item,
    })),
  ];
}

function itemText(item: Incident | Finding): string {
  return [item.title, item.classification, ...item.evidence].join(' ').toLowerCase();
}

function needs4xxDrilldown(classification: IncidentClassification, text: string): boolean {
  return classification === 'AUTH_FAILURE' || /\b4xx\b|\b401\b|\b403\b|unauthorized|forbidden/.test(text);
}

function needs5xxDrilldown(classification: IncidentClassification, text: string): boolean {
  return classification === 'APPLICATION_ERROR' || /\b5xx\b|\b50[0-9]\b|server error/.test(text);
}

function needsWarningDrilldown(text: string): boolean {
  return /warn|warning/.test(text);
}

function extractLogGroups(discoveryResult: string): CandidateLogGroup[] {
  return discoveryResult
    .split('\n')
    .map((line) => {
      const name = line.match(/^logGroupName=([^,\n]+)/)?.[1];
      if (!name) {
        return null;
      }
      const storedBytesText = line.match(/\bstoredBytes=(\d+)/)?.[1];
      return storedBytesText === undefined ? { name } : { name, storedBytes: Number(storedBytesText) };
    })
    .filter((group): group is CandidateLogGroup => group !== null);
}

function selectStandardLogGroups(discoveryResult: string): string[] {
  return extractLogGroups(discoveryResult)
    .filter((group) => group.storedBytes === undefined || group.storedBytes > 0)
    .slice(0, MAX_STANDARD_LOG_GROUPS)
    .map((group) => group.name);
}

async function runEvidenceTool(label: string, action: () => Promise<string>): Promise<string> {
  try {
    const result = await action();
    return `${label}\n${result}`;
  } catch (error) {
    return `${label}\nError: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function gatherStandardEvidence(
  classification: ClassificationResult,
  ctx: ToolContext
): Promise<string> {
  const sections: string[] = [];

  for (const { id, kind, item } of allItems(classification)) {
    const text = itemText(item);
    const shouldQuery4xx = needs4xxDrilldown(item.classification, text);
    const shouldQuery5xx = needs5xxDrilldown(item.classification, text);
    const shouldQueryWarnings = needsWarningDrilldown(text);
    const cloudwatchMetrics = 'signals' in item ? item.signals.cloudwatch_metrics ?? [] : [];

    const errorMetricEvidence: string[] = [];
    for (const metric of cloudwatchMetrics) {
      const evidence = await runEvidenceTool(
        `### ${id} ${kind}: metric ${metric.namespace}/${metric.metric_name}` +
          (metric.label ? ` (${metric.label})` : ''),
        () =>
          metricsAndAlarmsTool.handler(
            {
              namespace: metric.namespace,
              metric_name: metric.metric_name,
              dimensions: metric.dimensions,
              stat: metric.stat,
            },
            ctx
          )
      );
      sections.push(evidence);
      if (ERROR_METRIC_PATTERN.test(metric.metric_name)) {
        errorMetricEvidence.push(evidence);
      }
    }

    const spike = extractSpikeWindow(errorMetricEvidence);
    const windowArgs = spike
      ? { start_time: spike.start, end_time: spike.end }
      : { lookback_minutes: ctx.maxLookbackMinutes };
    const windowLabel = spike
      ? `narrowed to metric spike window ${spike.start}..${spike.end}`
      : `report window or ${ctx.maxLookbackMinutes} minute lookback`;

    if (shouldQuery5xx) {
      const albDimension = cloudwatchMetrics
        .filter((metric) => metric.namespace === 'AWS/ApplicationELB')
        .flatMap((metric) => metric.dimensions ?? [])
        .find((dimension) => dimension.name === 'LoadBalancer')?.value;

      if (albDimension) {
        sections.push(
          await runEvidenceTool(
            `### ${id} ${kind}: ALB access-log 5xx breakdown for ${albDimension} (${windowLabel})`,
            () =>
              albAccessLogsTool.handler(
                { load_balancer: albDimension, status_class: '5xx', ...windowArgs },
                ctx
              )
          )
        );
      }
    }

    if (!shouldQuery4xx && !shouldQuery5xx && !shouldQueryWarnings) {
      continue;
    }

    for (const service of item.affected_services) {
      console.log(`[Investigate] Pre-gathering standard evidence for ${id} (${service})`);

      if (shouldQuery5xx) {
        sections.push(
          await runEvidenceTool(
            `### ${id} ${kind}: ECS service events for ${service} (${windowLabel})`,
            () => ecsServiceEventsTool.handler({ service_name: service, ...windowArgs }, ctx)
          )
        );
      }

      const discovery = await runEvidenceTool(
        `### ${id} ${kind}: discover_log_groups(${service})`,
        () => discoverLogGroupsTool.handler({ service_name: service, limit: 5 }, ctx)
      );
      sections.push(discovery);

      const logGroups = selectStandardLogGroups(discovery);
      if (logGroups.length === 0) {
        continue;
      }

      for (const logGroup of logGroups) {
        if (shouldQuery4xx) {
          sections.push(
            await runEvidenceTool(
              `### ${id} ${kind}: standard 4xx/auth breakdown on ${logGroup} (${windowLabel})`,
              () =>
                queryLogsTool.handler(
                  {
                    log_group: logGroup,
                    filter_or_query: FOUR_XX_QUERY,
                    ...windowArgs,
                    limit: 100,
                  },
                  ctx
                )
            )
          );
        }

        if (shouldQuery5xx) {
          sections.push(
            await runEvidenceTool(
              `### ${id} ${kind}: standard 5xx breakdown on ${logGroup} (${windowLabel})`,
              () =>
                queryLogsTool.handler(
                  {
                    log_group: logGroup,
                    filter_or_query: FIVE_XX_QUERY,
                    ...windowArgs,
                    limit: 100,
                  },
                  ctx
                )
            )
          );
        }

        if (shouldQueryWarnings) {
          sections.push(
            await runEvidenceTool(
              `### ${id} ${kind}: standard warning sample on ${logGroup} (${windowLabel})`,
              () =>
                queryLogsTool.handler(
                  {
                    log_group: logGroup,
                    filter_or_query: WARNING_QUERY,
                    ...windowArgs,
                    limit: 100,
                  },
                  ctx
                )
            )
          );
        }
      }
    }
  }

  return sections.join('\n\n');
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

    const toolContext = buildToolContext(config, classification);
    const preGatheredEvidence = await gatherStandardEvidence(classification, toolContext);
    const step1Json = JSON.stringify(classification, null, 2);
    const prompt = buildInvestigatePrompt(step1Json, preGatheredEvidence);

    const loopOptions: ToolLoopOptions = {
      prompt,
      apiKey: config.openrouter.apiKey,
      baseUrl: config.openrouter.baseUrl,
      model: config.investigate.model,
      fallbackModel: config.investigate.modelFallback,
      tools: getTools(),
      toolContext,
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
