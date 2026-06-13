import type { Config } from '../config.js';
import type {
  StageInput,
  StageResult,
  ClassificationResult,
  InvestigationResult,
  Investigation,
} from '../types.js';
import { buildInvestigatePrompt } from '../prompts/investigatePrompt.js';
import { callOpenRouterWithTools, type ToolLoopOptions } from '../llm/toolLoop.js';
import { getTools } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';
import { discoverLogGroupsTool, queryLogsTool } from '../tools/cloudwatchLogs.js';
import { metricsAndAlarmsTool } from '../tools/cloudwatchMetrics.js';
import { albAccessLogsTool } from '../tools/albAccessLogs.js';
import { ecsServiceEventsTool } from '../tools/ecs.js';
import { listMetricsTool } from '../tools/listMetrics.js';
import { findAlarmsTool } from '../tools/alarms.js';
import { lambdaConfigurationTool, lambdaDeploymentMetadataTool } from '../tools/lambda.js';
import { eventBridgeRuleTool } from '../tools/eventbridge.js';
import { cloudTrailLookupTool } from '../tools/cloudtrail.js';
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

function hasExecutableNextSteps(investigation: Investigation): boolean {
  return investigation.recommended_next_investigation_steps.some((step) => {
    const text = `${step.action} ${step.expected_signal}`;
    return EXECUTABLE_NEXT_STEP_PATTERN.test(text) && !NON_EXECUTABLE_NEXT_STEP_PATTERN.test(text);
  });
}

function needsRootCauseClosure(result: InvestigationResult): boolean {
  return result.investigations.some(
    (investigation) =>
      investigation.requires_more_evidence_before_mitigation &&
      hasExecutableNextSteps(investigation)
  );
}

function buildRootCauseClosurePrompt(
  originalPrompt: string,
  draft: InvestigationResult,
  maxToolCalls: number
): string {
  return `${originalPrompt}

## Root-Cause Closure Pass

You already produced this draft investigation JSON:

${JSON.stringify(draft, null, 2)}

Before finalizing, resolve avoidable deferrals. For any investigation where requires_more_evidence_before_mitigation=true and recommended_next_investigation_steps contains a step executable with the available read-only tools, call the relevant tool now and fold the result into the final JSON.

Hard limits for this closure pass:
- Use at most ${maxToolCalls} tool call(s) total.
- Only run read-only evidence calls available in this stage: CloudWatch logs, metrics, alarms, Lambda metadata, EventBridge, ECS, ALB access logs, and CloudTrail.
- Do not remediate, mutate infrastructure, inspect secret values, or request human-only actions as tool work.
- If the root trigger remains unknown after the closure calls, keep requires_more_evidence_before_mitigation=true and make the remaining unknowns precise.
- Return the full revised JSON object only.`;
}

async function maybeRunRootCauseClosure(
  draft: InvestigationResult,
  loopOptions: ToolLoopOptions,
  originalPrompt: string,
  config: Config
): Promise<InvestigationResult> {
  if (!config.investigate.closureEnabled || !needsRootCauseClosure(draft)) {
    return draft;
  }

  const maxIterations = Math.max(1, config.investigate.closureMaxToolIterations);
  const maxToolCalls = Math.max(0, config.investigate.closureMaxToolCalls);
  if (maxToolCalls === 0) {
    return draft;
  }

  console.log(
    `[Investigate] Starting root-cause closure pass (max ${maxIterations} iteration(s), ${maxToolCalls} tool call(s))`
  );

  const closure = await callOpenRouterWithTools({
    ...loopOptions,
    prompt: buildRootCauseClosurePrompt(originalPrompt, draft, maxToolCalls),
    maxIterations,
    maxToolCalls,
  });
  console.log(
    `[Investigate] Root-cause closure pass completed: ${closure.iterations} iteration(s), ${closure.toolCalls} tool call(s)` +
      (closure.usedFallback ? ' (used fallback model)' : '')
  );

  const revised = tryParse(closure.content);
  if (!revised) {
    console.warn('[Investigate] Root-cause closure response invalid; keeping first-pass draft');
    return draft;
  }
  return revised;
}

type InvestigationItem =
  | { id: string; kind: 'incident'; item: Incident }
  | { id: string; kind: 'finding'; item: Finding };

interface CandidateLogGroup {
  name: string;
  storedBytes?: number;
}

interface MetricCandidate {
  namespace: string;
  metric_name: string;
  dimensions: Array<{ name: string; value: string }>;
  stat: 'Sum';
}

const MAX_STANDARD_LOG_GROUPS = 2;
const MAX_LIVENESS_METRIC_CANDIDATES = 3;

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

// Raw error-context lines (exceptions, timeouts, dependency failures) around a
// 5xx spike. The aggregate 5xx breakdown identifies WHICH endpoint failed; this
// sample is what carries WHY (stack trace, dependency name, timeout message).
const ERROR_CONTEXT_QUERY = `fields @timestamp, @message, @logStream
| filter @message like /(?i)(error|exception|timeout|traceback|unavailable|refused|fatal)/
| filter @message not like /\\/health/
| sort @timestamp desc
| limit 50`;

// Newest raw lines regardless of level. For observability incidents this shows
// whether the workload ran at all in the window: recent logs without metric
// datapoints indicate emission failure; silent logs indicate stoppage.
const RECENT_ACTIVITY_QUERY = `fields @timestamp, @message, @logStream
| sort @timestamp desc
| limit 25`;

const ERROR_METRIC_PATTERN = /5xx|4xx|error|fault|failure/i;
const SPIKE_PADDING_MS = 15 * 60 * 1000;

// For zero-datapoint metrics the report window cannot answer "when did the
// signal stop"; scan back this far before the window at a coarser period that
// keeps the call under CloudWatch's 1440-datapoint cap.
const OBSERVABILITY_METRIC_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const OBSERVABILITY_METRIC_PERIOD_SECONDS = 3600;
const ROOT_CAUSE_CHANGE_LOOKBACK_MS = 72 * 60 * 60 * 1000;
const LAMBDA_CHANGE_EVENTS = [
  'CreateFunction',
  'UpdateFunctionCode',
  'UpdateFunctionConfiguration',
  'PublishVersion',
  'CreateAlias',
  'UpdateAlias',
  'TagResource',
];
const EVENTBRIDGE_CHANGE_EVENTS = ['PutRule', 'PutTargets', 'EnableRule', 'DisableRule', 'TagResource'];
const EXECUTABLE_NEXT_STEP_PATTERN =
  /\b(?:cloudwatch|metric|alarm|logs?|lambda|eventbridge|cloudtrail|ecs|alb|query|lookup|inspect|discover|get_metrics_and_alarms|find_alarms|query_logs|list_metrics|get_lambda_configuration|get_lambda_deployment_metadata|get_eventbridge_rule|lookup_cloudtrail_events|get_ecs_service_events|query_alb_access_logs)\b/i;
const NON_EXECUTABLE_NEXT_STEP_PATTERN =
  /\b(?:human|manual|review source|source code|code review|patch|deploy|rollback|restart|contact|vendor|ssh|database write|write|mutate|secret value|credentials?|api key|runbook outside|external system)\b/i;

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

function needsObservabilityDrilldown(
  classification: IncidentClassification,
  text: string
): boolean {
  return (
    classification === 'OBSERVABILITY_FAILURE' ||
    /\b(?:no|zero|missing) datapoints?\b|liveness|missing metric|stopped (?:emitting|publishing|reporting)/.test(
      text
    )
  );
}

function extendedMetricWindow(ctx: ToolContext): { start_time: string; end_time: string } | null {
  if (!ctx.defaultStartTime || !ctx.defaultEndTime) {
    return null;
  }
  const start = new Date(ctx.defaultStartTime).getTime();
  const end = new Date(ctx.defaultEndTime).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }
  return {
    start_time: new Date(start - OBSERVABILITY_METRIC_LOOKBACK_MS).toISOString(),
    end_time: new Date(end).toISOString(),
  };
}

function rootCauseChangeWindow(ctx: ToolContext): { start_time: string; end_time: string } | null {
  if (!ctx.defaultStartTime || !ctx.defaultEndTime) {
    return null;
  }
  const start = new Date(ctx.defaultStartTime).getTime();
  const end = new Date(ctx.defaultEndTime).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }
  return {
    start_time: new Date(start - ROOT_CAUSE_CHANGE_LOOKBACK_MS).toISOString(),
    end_time: new Date(end).toISOString(),
  };
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

function extractMetricDimensionValues(metricDiscovery: string, dimensionName: string): string[] {
  const values = new Set<string>();
  const pattern = new RegExp(`(?:^|[,\\[]\\s*)${dimensionName}=([^,\\]]+)`, 'g');
  for (const line of metricDiscovery.split('\n')) {
    for (const match of line.matchAll(pattern)) {
      const value = match[1]?.trim();
      if (value) {
        values.add(value);
      }
    }
  }
  return [...values];
}

function parseMetricDiscoveryLine(line: string): MetricCandidate | null {
  const namespace = line.match(/\bnamespace=([^,\n]+)/)?.[1]?.trim();
  const metricName = line.match(/\bmetric=([^,\n]+)/)?.[1]?.trim();
  if (!namespace || !metricName) {
    return null;
  }

  const dimensionsText = line.match(/\bdimensions=\[([^\]]*)\]/)?.[1] ?? '';
  const dimensions = dimensionsText
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, ...valueParts] = part.split('=');
      const value = valueParts.join('=');
      return name && value !== '' ? { name: name.trim(), value: value.trim() } : null;
    })
    .filter((dimension): dimension is { name: string; value: string } => dimension !== null);

  return { namespace, metric_name: metricName, dimensions, stat: 'Sum' };
}

function metricKey(metric: Pick<MetricCandidate, 'namespace' | 'metric_name' | 'dimensions'>): string {
  const dimensions = [...(metric.dimensions ?? [])]
    .sort((a, b) => a.name.localeCompare(b.name) || a.value.localeCompare(b.value))
    .map((dimension) => `${dimension.name}=${dimension.value}`)
    .join(',');
  return `${metric.namespace}/${metric.metric_name}/${dimensions}`;
}

function selectLivenessMetricCandidates(
  metricDiscovery: string,
  service: string,
  knownMetricKeys: Set<string>
): MetricCandidate[] {
  const candidates: MetricCandidate[] = [];
  const seen = new Set<string>();
  const serviceLower = service.toLowerCase();

  for (const line of metricDiscovery.split('\n')) {
    const candidate = parseMetricDiscoveryLine(line);
    if (!candidate) {
      continue;
    }

    const haystack = [
      candidate.namespace,
      candidate.metric_name,
      ...candidate.dimensions.flatMap((dimension) => [dimension.name, dimension.value]),
    ]
      .join(' ')
      .toLowerCase();
    if (!/(?:liveness|heartbeat|heart[-_ ]?beat)/i.test(haystack)) {
      continue;
    }
    if (!haystack.includes(serviceLower) && !candidate.dimensions.some((d) => d.value === service)) {
      continue;
    }

    const key = metricKey(candidate);
    if (knownMetricKeys.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push(candidate);
    if (candidates.length >= MAX_LIVENESS_METRIC_CANDIDATES) {
      break;
    }
  }

  return candidates;
}

function selectLambdaFunctions(metricDiscovery: string): string[] {
  return extractMetricDimensionValues(metricDiscovery, 'FunctionName').filter((name) =>
    /^hokusai-.*-(?:development|staging|production)$/.test(name)
  );
}

function selectEventBridgeRules(metricDiscovery: string): string[] {
  return extractMetricDimensionValues(metricDiscovery, 'RuleName').filter((name) =>
    /^hokusai-.*-(?:development|staging|production)$/.test(name)
  );
}

async function gatherLambdaRootCauseEvidence(
  id: string,
  kind: InvestigationItem['kind'],
  functionName: string,
  ctx: ToolContext
): Promise<string[]> {
  const sections = [
    await runEvidenceTool(
      `### ${id} ${kind}: Lambda invocation/error metrics for ${functionName} (root-cause context)`,
      async () => {
        const invocations = await metricsAndAlarmsTool.handler(
          {
            namespace: 'AWS/Lambda',
            metric_name: 'Invocations',
            dimensions: [{ name: 'FunctionName', value: functionName }],
            stat: 'Sum',
            period_seconds: OBSERVABILITY_METRIC_PERIOD_SECONDS,
          },
          ctx
        );
        const errors = await metricsAndAlarmsTool.handler(
          {
            namespace: 'AWS/Lambda',
            metric_name: 'Errors',
            dimensions: [{ name: 'FunctionName', value: functionName }],
            stat: 'Sum',
            period_seconds: OBSERVABILITY_METRIC_PERIOD_SECONDS,
          },
          ctx
        );
        return `Invocations:\n${invocations}\n\nErrors:\n${errors}`;
      }
    ),
    await runEvidenceTool(
      `### ${id} ${kind}: Lambda configuration for ${functionName} (root-cause context)`,
      () =>
        lambdaConfigurationTool.handler(
          { function_name: functionName, include_environment_keys: true },
          ctx
        )
    ),
    await runEvidenceTool(
      `### ${id} ${kind}: Lambda deployment metadata for ${functionName} (root-cause context)`,
      () => lambdaDeploymentMetadataTool.handler({ function_name: functionName }, ctx)
    ),
  ];

  const changeWindow = rootCauseChangeWindow(ctx);
  if (changeWindow) {
    sections.push(
      await runEvidenceTool(
        `### ${id} ${kind}: CloudTrail Lambda changes for ${functionName} (72h before report window through window end)`,
        () =>
          cloudTrailLookupTool.handler(
            {
              resource_name: functionName,
              event_names: LAMBDA_CHANGE_EVENTS,
              ...changeWindow,
              limit: 50,
            },
            ctx
          )
      )
    );
  }

  return sections;
}

async function gatherEventBridgeRootCauseEvidence(
  id: string,
  kind: InvestigationItem['kind'],
  ruleName: string,
  ctx: ToolContext
): Promise<string[]> {
  const sections = [
    await runEvidenceTool(
      `### ${id} ${kind}: EventBridge rule ${ruleName} (root-cause context)`,
      () => eventBridgeRuleTool.handler({ rule_name: ruleName }, ctx)
    ),
  ];

  const changeWindow = rootCauseChangeWindow(ctx);
  if (changeWindow) {
    sections.push(
      await runEvidenceTool(
        `### ${id} ${kind}: CloudTrail EventBridge changes for ${ruleName} (72h before report window through window end)`,
        () =>
          cloudTrailLookupTool.handler(
            {
              resource_name: ruleName,
              event_names: EVENTBRIDGE_CHANGE_EVENTS,
              ...changeWindow,
              limit: 50,
            },
            ctx
          )
      )
    );
  }

  return sections;
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
  const rootCauseFunctionsGathered = new Set<string>();
  const rootCauseRulesGathered = new Set<string>();

  for (const { id, kind, item } of allItems(classification)) {
    const text = itemText(item);
    const shouldQuery4xx = needs4xxDrilldown(item.classification, text);
    const shouldQuery5xx = needs5xxDrilldown(item.classification, text);
    const shouldQueryWarnings = needsWarningDrilldown(text);
    const shouldQueryObservability = needsObservabilityDrilldown(item.classification, text);
    const cloudwatchMetrics = 'signals' in item ? item.signals.cloudwatch_metrics ?? [] : [];
    const knownMetricKeys = new Set(cloudwatchMetrics.map(metricKey));

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

      if (shouldQueryObservability) {
        const extendedWindow = extendedMetricWindow(ctx);
        if (extendedWindow) {
          sections.push(
            await runEvidenceTool(
              `### ${id} ${kind}: extended 14-day history for ${metric.namespace}/${metric.metric_name} (locates the last datapoint before the report window)`,
              () =>
                metricsAndAlarmsTool.handler(
                  {
                    namespace: metric.namespace,
                    metric_name: metric.metric_name,
                    dimensions: metric.dimensions,
                    stat: metric.stat,
                    period_seconds: OBSERVABILITY_METRIC_PERIOD_SECONDS,
                    ...extendedWindow,
                  },
                  ctx
                )
            )
          );
        }
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

    if (!shouldQuery4xx && !shouldQuery5xx && !shouldQueryWarnings && !shouldQueryObservability) {
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

      if (shouldQueryObservability) {
        const metricDiscovery = await runEvidenceTool(
          `### ${id} ${kind}: metric discovery for ${service}`,
          () => listMetricsTool.handler({ search: service }, ctx)
        );
        sections.push(metricDiscovery);

        const extendedWindow = extendedMetricWindow(ctx);
        if (extendedWindow) {
          for (const metric of selectLivenessMetricCandidates(
            metricDiscovery,
            service,
            knownMetricKeys
          )) {
            sections.push(
              await runEvidenceTool(
                `### ${id} ${kind}: discovered liveness metric 14-day history for ${metric.namespace}/${metric.metric_name} (locates the last datapoint before the report window)`,
                () =>
                  metricsAndAlarmsTool.handler(
                    {
                      namespace: metric.namespace,
                      metric_name: metric.metric_name,
                      dimensions: metric.dimensions,
                      stat: metric.stat,
                      period_seconds: OBSERVABILITY_METRIC_PERIOD_SECONDS,
                      ...extendedWindow,
                    },
                    ctx
                  )
              )
            );
          }
        }

        sections.push(
          await runEvidenceTool(
            `### ${id} ${kind}: alarm coverage for ${service}`,
            () => findAlarmsTool.handler({ search: service }, ctx)
          )
        );

        for (const functionName of selectLambdaFunctions(metricDiscovery)) {
          if (rootCauseFunctionsGathered.has(functionName)) {
            continue;
          }
          rootCauseFunctionsGathered.add(functionName);
          sections.push(
            ...(await gatherLambdaRootCauseEvidence(id, kind, functionName, ctx))
          );
        }

        for (const ruleName of selectEventBridgeRules(metricDiscovery)) {
          if (rootCauseRulesGathered.has(ruleName)) {
            continue;
          }
          rootCauseRulesGathered.add(ruleName);
          sections.push(
            ...(await gatherEventBridgeRootCauseEvidence(id, kind, ruleName, ctx))
          );
        }
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
          sections.push(
            await runEvidenceTool(
              `### ${id} ${kind}: error-context sample on ${logGroup} (${windowLabel})`,
              () =>
                queryLogsTool.handler(
                  {
                    log_group: logGroup,
                    filter_or_query: ERROR_CONTEXT_QUERY,
                    ...windowArgs,
                    limit: 50,
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

        if (shouldQueryObservability) {
          sections.push(
            await runEvidenceTool(
              `### ${id} ${kind}: recent runtime activity sample on ${logGroup} (${windowLabel})`,
              () =>
                queryLogsTool.handler(
                  {
                    log_group: logGroup,
                    filter_or_query: RECENT_ACTIVITY_QUERY,
                    ...windowArgs,
                    limit: 25,
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
      const closed = await maybeRunRootCauseClosure(parsed, loopOptions, prompt, config);
      return { stage: 'Investigate', status: 'success', timestamp, data: closed };
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
      const closed = await maybeRunRootCauseClosure(repaired, loopOptions, prompt, config);
      return { stage: 'Investigate', status: 'success', timestamp, data: closed };
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
