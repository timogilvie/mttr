import type { Config } from '../config.js';
import type {
  StageInput,
  StageResult,
  ClassificationResult,
  InvestigationResult,
  EvidenceRequirementType,
  TelemetryFallbackAttempt,
  TelemetryGap,
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
import {
  lambdaConfigurationTool,
  lambdaDeploymentMetadataTool,
  lambdaDeploymentProvenanceTool,
} from '../tools/lambda.js';
import { eventBridgeRuleTool } from '../tools/eventbridge.js';
import { cloudTrailLookupTool } from '../tools/cloudtrail.js';
import { serviceSearchTerms } from '../tools/serviceNames.js';
import { resolveServiceResource } from '../tools/serviceResources.js';
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

export type EvidenceRequirementStatus = 'pending' | 'satisfied' | 'unavailable';

export interface EvidenceRequirement {
  id: string;
  incident_id: string;
  type: EvidenceRequirementType;
  description: string;
  tool_hint: string;
  status: EvidenceRequirementStatus;
  evidence_label?: string | undefined;
  unavailable_reason?: string | undefined;
}

class EvidenceRequirementTracker {
  private readonly requirements = new Map<string, EvidenceRequirement>();

  require(
    incidentId: string,
    type: EvidenceRequirementType,
    target: string,
    description: string,
    toolHint: string
  ): string {
    const id = requirementId(incidentId, type, target);
    if (!this.requirements.has(id)) {
      this.requirements.set(id, {
        id,
        incident_id: incidentId,
        type,
        description,
        tool_hint: toolHint,
        status: 'pending',
      });
    }
    return id;
  }

  markSatisfied(id: string, evidenceLabel: string): void {
    const requirement = this.requirements.get(id);
    if (requirement && requirement.status === 'pending') {
      requirement.status = 'satisfied';
      requirement.evidence_label = evidenceLabel;
    }
  }

  markUnavailable(id: string, evidenceLabel: string, reason: string): void {
    const requirement = this.requirements.get(id);
    if (requirement && requirement.status === 'pending') {
      requirement.status = 'unavailable';
      requirement.evidence_label = evidenceLabel;
      requirement.unavailable_reason = reason;
    }
  }

  all(): EvidenceRequirement[] {
    return [...this.requirements.values()];
  }
}

function requirementId(
  incidentId: string,
  type: EvidenceRequirementType,
  target: string
): string {
  return `${incidentId}:${type}:${target.toLowerCase().replace(/[^a-z0-9:./_-]+/g, '-')}`;
}

export function createEvidenceRequirement(
  overrides: Partial<EvidenceRequirement> = {}
): EvidenceRequirement {
  return {
    id: overrides.id ?? 'incident-1:CUSTOM_METRIC_HISTORY:metric',
    incident_id: overrides.incident_id ?? 'incident-1',
    type: overrides.type ?? 'CUSTOM_METRIC_HISTORY',
    description: overrides.description ?? 'Fetch extended custom metric history.',
    tool_hint: overrides.tool_hint ?? 'Use get_metrics_and_alarms.',
    status: overrides.status ?? 'pending',
    evidence_label: overrides.evidence_label,
    unavailable_reason: overrides.unavailable_reason,
  };
}

export function needsRootCauseClosure(
  result: InvestigationResult,
  unresolvedRequirements: EvidenceRequirement[]
): boolean {
  if (unresolvedRequirements.length === 0) {
    return false;
  }
  const unresolvedIds = new Set(unresolvedRequirements.map((requirement) => requirement.incident_id));
  return result.investigations.some(
    (investigation) =>
      investigation.requires_more_evidence_before_mitigation &&
      unresolvedIds.has(investigation.incident_id)
  );
}

export function unresolvedRequirementsForDraft(
  result: InvestigationResult,
  requirements: EvidenceRequirement[]
): EvidenceRequirement[] {
  const needsEvidence = new Set(
    result.investigations
      .filter((investigation) => investigation.requires_more_evidence_before_mitigation)
      .map((investigation) => investigation.incident_id)
  );
  return requirements.filter(
    (requirement) =>
      requirement.status === 'pending' && needsEvidence.has(requirement.incident_id)
  );
}

export function structuredRequirementsFromDraft(
  result: InvestigationResult
): EvidenceRequirement[] {
  return result.investigations.flatMap((investigation) =>
    investigation.unresolved_evidence_requirements.map((requirement, index) =>
      createEvidenceRequirement({
        id: `${investigation.incident_id}:${requirement.type}:draft-${index + 1}`,
        incident_id: investigation.incident_id,
        type: requirement.type,
        description: requirement.description,
        tool_hint: requirement.tool_hint,
        status: 'pending',
      })
    )
  );
}

function closureRequirementsForDraft(
  result: InvestigationResult,
  preGatheredRequirements: EvidenceRequirement[]
): EvidenceRequirement[] {
  return [
    ...unresolvedRequirementsForDraft(result, preGatheredRequirements),
    ...unresolvedRequirementsForDraft(result, structuredRequirementsFromDraft(result)),
  ];
}

export function buildRootCauseClosurePrompt(
  originalPrompt: string,
  draft: InvestigationResult,
  unresolvedRequirements: EvidenceRequirement[],
  maxToolCalls: number
): string {
  return `${originalPrompt}

## Root-Cause Closure Pass

You already produced this draft investigation JSON:

${JSON.stringify(draft, null, 2)}

Before finalizing, resolve avoidable deferrals. The deterministic pre-gather already attempted known evidence requirements where it had enough target data. The remaining tool-executable requirements are listed below as structured objects; use these objects, not recommended_next_investigation_steps prose, to decide which tool calls are eligible for this closure pass.

Unresolved evidence requirements:
${JSON.stringify(unresolvedRequirements, null, 2)}

Hard limits for this closure pass:
- Use at most ${maxToolCalls} tool call(s) total.
- Only run read-only evidence calls available in this stage: CloudWatch logs, metrics, alarms, Lambda metadata, EventBridge, ECS, ALB access logs, and CloudTrail.
- Do not remediate, mutate infrastructure, inspect secret values, or request human-only actions as tool work.
- Human-only recommended_next_investigation_steps are out of scope for this closure pass and must not consume tool budget.
- If the root trigger remains unknown after the closure calls, keep requires_more_evidence_before_mitigation=true and make the remaining unknowns precise.
- Return the full revised JSON object only.`;
}

async function maybeRunRootCauseClosure(
  draft: InvestigationResult,
  unresolvedRequirements: EvidenceRequirement[],
  loopOptions: ToolLoopOptions,
  originalPrompt: string,
  config: Config
): Promise<InvestigationResult> {
  if (
    !config.investigate.closureEnabled ||
    !needsRootCauseClosure(draft, unresolvedRequirements)
  ) {
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
    prompt: buildRootCauseClosurePrompt(
      originalPrompt,
      draft,
      unresolvedRequirements,
      maxToolCalls
    ),
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

interface MetricDiscoveryRequest {
  label: string;
  args: {
    namespace?: string;
    metric_name?: string;
    search?: string;
    limit?: number;
  };
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

const FIRST_BAD_LOG_TIMESTAMP_QUERY = `fields @timestamp, @message, @logStream
| filter @message like /(?i)(error|exception|timeout|traceback|unavailable|refused|fatal|invalid params)/
| filter @message not like /\\/health/
| stats min(@timestamp) as firstBadTimestamp, max(@timestamp) as latestBadTimestamp, count(*) as badEvents by @logStream
| sort firstBadTimestamp asc
| limit 25`;

// Newest raw lines regardless of level. For observability incidents this shows
// whether the workload ran at all in the window: recent logs without metric
// datapoints indicate emission failure; silent logs indicate stoppage.
const RECENT_ACTIVITY_QUERY = `fields @timestamp, @message, @logStream
| sort @timestamp desc
| limit 25`;

const LAMBDA_ERROR_SUMMARY_QUERY = `fields @timestamp, @message, @logStream
| filter @message like /(?i)(error|exception|traceback|runtimeerror|invalid params|task timed out|failed)/
| parse @message /(?<errorCode>-\\d{5})/
| parse @message /(?<rpcError>RPC error\\s+-\\d{5}\\s+[^\\r\\n,\\]]+)/
| parse @message /(?<exceptionType>[A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception))[: ]+(?<errorMessage>[^\\r\\n]+)/
| parse @message /File "(?<file>[^"]+)", line (?<line>\\d+), in (?<function>[^ \\r\\n]+)/
| stats min(@timestamp) as earliest, max(@timestamp) as latest, count(*) as failures by errorCode, rpcError, exceptionType, errorMessage, file, function, @logStream
| sort failures desc
| limit 50`;

const LAMBDA_STACK_FRAME_QUERY = `fields @timestamp, @message, @logStream
| filter @message like /File "/
| parse @message /File "(?<file>[^"]+)", line (?<line>\\d+), in (?<function>[^ \\r\\n]+)/
| stats min(@timestamp) as earliest, max(@timestamp) as latest, count(*) as frames by file, function, @logStream
| sort frames desc
| limit 25`;

const LAMBDA_COMPLETION_QUERY = `fields @timestamp, @message, @logStream, @type, @duration, @billedDuration, @maxMemoryUsed
| filter @type = "REPORT" or @message like /^REPORT RequestId:/
| stats min(@timestamp) as earliest, max(@timestamp) as latest, count(*) as completedInvocations, avg(@duration) as avgDurationMs, max(@duration) as maxDurationMs, max(@maxMemoryUsed) as maxMemoryUsedMb by @logStream
| sort latest desc
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
const ECS_CHANGE_EVENTS = [
  'CreateService',
  'UpdateService',
  'DeleteService',
  'RegisterTaskDefinition',
  'RunTask',
  'StopTask',
];
const RESOURCE_SATURATION_METRICS: Array<{ metric_name: string; stat: 'Average' | 'Maximum' }> = [
  { metric_name: 'CPUUtilization', stat: 'Average' },
  { metric_name: 'MemoryUtilization', stat: 'Average' },
];
const MAX_CAUSAL_ECS_TARGETS = 2;

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

function reportWindow(ctx: ToolContext): { start_time: string; end_time: string } | null {
  if (!ctx.defaultStartTime || !ctx.defaultEndTime) {
    return null;
  }
  const start = new Date(ctx.defaultStartTime).getTime();
  const end = new Date(ctx.defaultEndTime).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || start >= end) {
    return null;
  }
  return {
    start_time: new Date(start).toISOString(),
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

function uniqueValues(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(trimmed);
  }
  return unique;
}

function detectorBaseName(service: string): string | null {
  const normalized = service.toLowerCase();
  const base = normalized
    .replace(/[-_]+anomaly[-_]+detection$/, '')
    .replace(/[-_]+anomaly[-_]+detector$/, '')
    .replace(/[-_]+detector$/, '');
  return base && base !== normalized ? base : null;
}

function livenessMetricTargetTerms(service: string): string[] {
  const genericDetectorTokens = new Set(['anomaly', 'detection', 'detector', 'service']);
  return uniqueValues([
    service.toLowerCase(),
    detectorBaseName(service),
    ...serviceSearchTerms(service).filter((term) => !genericDetectorTokens.has(term)),
  ]).map((term) => term.toLowerCase());
}

function buildLivenessMetricDiscoveryRequests(service: string): MetricDiscoveryRequest[] {
  const targetTerms = livenessMetricTargetTerms(service);
  const searchTerms = uniqueValues([service, detectorBaseName(service), ...targetTerms]);
  const requests: MetricDiscoveryRequest[] = [
    ...searchTerms.map((search) => ({
      label: `search=${search}`,
      args: { search, limit: 100 },
    })),
    {
      label: 'search=liveness',
      args: { search: 'liveness', limit: 100 },
    },
    {
      label: 'search=heartbeat',
      args: { search: 'heartbeat', limit: 100 },
    },
    {
      label: 'metric_name=DetectorLiveness',
      args: { metric_name: 'DetectorLiveness', limit: 100 },
    },
    {
      label: 'metric_name=DetectorHeartbeat',
      args: { metric_name: 'DetectorHeartbeat', limit: 100 },
    },
  ];

  const seen = new Set<string>();
  return requests.filter((request) => {
    const key = JSON.stringify(request.args).toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function formatMetricDiscoveryRequestArgs(args: MetricDiscoveryRequest['args']): string {
  return Object.entries(args)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(', ');
}

async function gatherExpandedLivenessMetricDiscovery(
  id: string,
  kind: InvestigationItem['kind'],
  service: string,
  ctx: ToolContext
): Promise<string> {
  const requests = buildLivenessMetricDiscoveryRequests(service);
  const sections: string[] = [
    `### ${id} ${kind}: expanded liveness metric discovery for ${service}`,
    `Requests: ${requests.map((request) => request.label).join(', ')}`,
  ];

  for (const request of requests) {
    sections.push(
      await runEvidenceTool(
        `#### list_metrics(${formatMetricDiscoveryRequestArgs(request.args)})`,
        () => listMetricsTool.handler(request.args, ctx)
      )
    );
  }

  return sections.join('\n');
}

function selectLivenessMetricCandidates(
  metricDiscovery: string,
  service: string,
  knownMetricKeys: Set<string>
): MetricCandidate[] {
  const candidates: MetricCandidate[] = [];
  const seen = new Set<string>();
  const targetTerms = livenessMetricTargetTerms(service);

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
    if (
      !targetTerms.some((term) => haystack.includes(term)) &&
      !candidate.dimensions.some((d) => d.value === service)
    ) {
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
  logWindowArgs: { start_time: string; end_time: string } | { lookback_minutes: number },
  logWindowLabel: string,
  ctx: ToolContext,
  tracker: EvidenceRequirementTracker
): Promise<string[]> {
  const logGroup = `/aws/lambda/${functionName}`;
  const provenanceWindow = rootCauseChangeWindow(ctx) ?? {};
  const failureSummaryRequirement = tracker.require(
    id,
    'LAMBDA_FAILURE_SUMMARY',
    functionName,
    `Summarize Lambda runtime failures for ${functionName}.`,
    'Use query_logs against the Lambda log group with the Lambda error summary query.'
  );
  const deploymentProvenanceRequirement = tracker.require(
    id,
    'DEPLOYMENT_PROVENANCE',
    functionName,
    `Connect Lambda ${functionName} to deployment source, image, and rollout metadata.`,
    'Use get_deployment_provenance for the Lambda function.'
  );
  const sections = [
    await runRequiredEvidenceTool(
      `### ${id} ${kind}: Lambda error summary for ${functionName} on ${logGroup} (${logWindowLabel})`,
      failureSummaryRequirement,
      tracker,
      () =>
        queryLogsTool.handler(
          {
            log_group: logGroup,
            filter_or_query: LAMBDA_ERROR_SUMMARY_QUERY,
            ...logWindowArgs,
            limit: 100,
          },
          ctx
        )
    ),
    await runEvidenceTool(
      `### ${id} ${kind}: Lambda stack-frame summary for ${functionName} on ${logGroup} (${logWindowLabel})`,
      () =>
        queryLogsTool.handler(
          {
            log_group: logGroup,
            filter_or_query: LAMBDA_STACK_FRAME_QUERY,
            ...logWindowArgs,
            limit: 50,
          },
          ctx
        )
    ),
    await runEvidenceTool(
      `### ${id} ${kind}: Lambda completion summary for ${functionName} on ${logGroup} (${logWindowLabel})`,
      () =>
        queryLogsTool.handler(
          {
            log_group: logGroup,
            filter_or_query: LAMBDA_COMPLETION_QUERY,
            ...logWindowArgs,
            limit: 50,
          },
          ctx
        )
    ),
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
    await runRequiredEvidenceTool(
      `### ${id} ${kind}: Lambda deployment provenance for ${functionName} (root-cause context)`,
      deploymentProvenanceRequirement,
      tracker,
      () =>
        lambdaDeploymentProvenanceTool.handler(
          { function_name: functionName, ...provenanceWindow },
          ctx
        )
    ),
  ];

  const changeWindow = rootCauseChangeWindow(ctx);
  if (changeWindow) {
    const changeDetailsRequirement = tracker.require(
      id,
      'CHANGE_EVENT_DETAILS',
      functionName,
      `Inspect Lambda deployment/configuration change events for ${functionName}.`,
      'Use lookup_cloudtrail_events for Lambda change event details.'
    );
    sections.push(
      await runRequiredEvidenceTool(
        `### ${id} ${kind}: CloudTrail Lambda changes for ${functionName} (72h before report window through window end)`,
        changeDetailsRequirement,
        tracker,
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
  ctx: ToolContext,
  tracker: EvidenceRequirementTracker
): Promise<string[]> {
  const sections = [
    await runEvidenceTool(
      `### ${id} ${kind}: EventBridge rule ${ruleName} (root-cause context)`,
      () => eventBridgeRuleTool.handler({ rule_name: ruleName }, ctx)
    ),
  ];

  const changeWindow = rootCauseChangeWindow(ctx);
  if (changeWindow) {
    const changeDetailsRequirement = tracker.require(
      id,
      'CHANGE_EVENT_DETAILS',
      ruleName,
      `Inspect EventBridge schedule/target change events for ${ruleName}.`,
      'Use lookup_cloudtrail_events for EventBridge change event details.'
    );
    sections.push(
      await runRequiredEvidenceTool(
        `### ${id} ${kind}: CloudTrail EventBridge changes for ${ruleName} (72h before report window through window end)`,
        changeDetailsRequirement,
        tracker,
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

interface CausalEcsTarget {
  cluster: string;
  serviceName: string;
}

const ECS_EVENTS_SERVICE_LINE_RE = /^Service ([A-Za-z0-9_.:/-]+) \(cluster ([A-Za-z0-9_.:/-]+)\):/gm;

/**
 * Recover the ECS cluster/service names get_ecs_service_events actually
 * matched from its formatted evidence text. This lets the causal-evidence
 * pivot target resource-saturation metrics and CloudTrail change lookups
 * generically for any service the ECS name search resolved, without relying
 * on a static per-service registry.
 */
function extractEcsServiceMatches(ecsEvidenceText: string): CausalEcsTarget[] {
  const matches: CausalEcsTarget[] = [];
  for (const match of ecsEvidenceText.matchAll(ECS_EVENTS_SERVICE_LINE_RE)) {
    const serviceName = match[1];
    const clusterName = match[2];
    if (serviceName && clusterName) {
      matches.push({ serviceName, cluster: clusterName });
    }
  }
  return matches;
}

/**
 * Resolve the ECS cluster/service target(s) for the causal-evidence pivot.
 * Prefers the generic service-resource registry (serviceResources.ts), which
 * also covers services identified only by alias, and falls back to parsing
 * the actual get_ecs_service_events output so unregistered services still
 * resolve a target deterministically.
 */
function resolveCausalEcsTargets(service: string, ecsEvidenceText: string): CausalEcsTarget[] {
  const registryTargets = resolveServiceResource(service)
    .ecsServices.filter((candidate): candidate is { cluster: string; serviceName: string } =>
      Boolean(candidate.cluster)
    )
    .map((candidate) => ({ cluster: candidate.cluster, serviceName: candidate.serviceName }));

  const targets = registryTargets.length > 0 ? registryTargets : extractEcsServiceMatches(ecsEvidenceText);
  return targets.slice(0, MAX_CAUSAL_ECS_TARGETS);
}

/**
 * Second-level causal-evidence gathering for a confirmed application-error
 * (API 5xx / ALB-backed) incident: resource saturation and deployment/config
 * change correlation for the resolved ECS target(s). Generic across services
 * — targets are resolved via resolveCausalEcsTargets, never a literal service
 * name. Every tool call degrades gracefully (via runEvidenceTool /
 * runRequiredEvidenceTool) so a missing or failing source is recorded as
 * evidence text rather than aborting the investigation.
 */
async function gatherApplicationCausalEvidence(
  id: string,
  kind: InvestigationItem['kind'],
  service: string,
  ecsEvidenceText: string,
  windowArgs: { start_time: string; end_time: string } | { lookback_minutes: number },
  windowLabel: string,
  ctx: ToolContext,
  tracker: EvidenceRequirementTracker
): Promise<string[]> {
  const sections: string[] = [];
  const targets = resolveCausalEcsTargets(service, ecsEvidenceText);

  if (targets.length === 0) {
    sections.push(
      `### ${id} ${kind}: causal-evidence resource resolution for ${service}\n` +
        `No ECS cluster/service resource could be resolved for ${service} via the service-resource registry or ECS service-event evidence; resource saturation and deployment-change correlation cannot be queried.`
    );
    return sections;
  }

  const changeWindow = rootCauseChangeWindow(ctx);

  for (const target of targets) {
    for (const metric of RESOURCE_SATURATION_METRICS) {
      sections.push(
        await runEvidenceTool(
          `### ${id} ${kind}: resource saturation ${metric.metric_name} for ${target.serviceName} (cluster ${target.cluster}, ${windowLabel})`,
          () =>
            metricsAndAlarmsTool.handler(
              {
                namespace: 'AWS/ECS',
                metric_name: metric.metric_name,
                dimensions: [
                  { name: 'ClusterName', value: target.cluster },
                  { name: 'ServiceName', value: target.serviceName },
                ],
                stat: metric.stat,
                ...windowArgs,
              },
              ctx
            )
        )
      );
    }

    if (changeWindow) {
      const changeDetailsRequirement = tracker.require(
        id,
        'CHANGE_EVENT_DETAILS',
        target.serviceName,
        `Inspect deployment/config change events for ${target.serviceName} around the failure window.`,
        'Use lookup_cloudtrail_events for ECS deployment/task-definition change event details.'
      );
      sections.push(
        await runRequiredEvidenceTool(
          `### ${id} ${kind}: CloudTrail deployment changes for ${target.serviceName} (72h before report window through window end)`,
          changeDetailsRequirement,
          tracker,
          () =>
            cloudTrailLookupTool.handler(
              {
                resource_name: target.serviceName,
                event_names: ECS_CHANGE_EVENTS,
                ...changeWindow,
                limit: 50,
              },
              ctx
            )
        )
      );
    }
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

async function runRequiredEvidenceTool(
  label: string,
  requirementIdValue: string,
  tracker: EvidenceRequirementTracker,
  action: () => Promise<string>
): Promise<string> {
  try {
    const result = await action();
    tracker.markSatisfied(requirementIdValue, label);
    return `${label}\n${result}`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    tracker.markUnavailable(requirementIdValue, label, reason);
    return `${label}\nError: ${reason}`;
  }
}

const MAX_RUNTIME_OWNER_LOG_GROUPS = 2;

function isToolErrorText(text: string): boolean {
  return /\nError: /.test(text);
}

function hasMetricDatapoints(text: string): boolean {
  return /Metric datapoints \(\d+\)/.test(text);
}

function hasNoMetricDatapoints(text: string): boolean {
  return /No metric datapoints in the requested window/.test(text);
}

function hasRuntimeRows(text: string): boolean {
  return /Query returned \d+ row\(s\):/.test(text);
}

/**
 * Deterministic signals accumulated across every fallback tool call for one
 * investigation item, used to classify an unresolved telemetry gap without
 * relying on the model to self-report why evidence stayed thin.
 */
interface TelemetryActivitySignals {
  metricAttempted: boolean;
  metricResolved: boolean;
  logGapAttempted: boolean;
  logGapResolved: boolean;
  activityObserved: boolean;
  ownerFound: boolean;
  toolError: boolean;
  nextMetricSource?: string | undefined;
  nextLogSource?: string | undefined;
}

function emptyTelemetrySignals(): TelemetryActivitySignals {
  return {
    metricAttempted: false,
    metricResolved: false,
    logGapAttempted: false,
    logGapResolved: false,
    activityObserved: false,
    ownerFound: false,
    toolError: false,
  };
}

function mergeTelemetrySignals(
  current: TelemetryActivitySignals,
  update: Partial<TelemetryActivitySignals>
): TelemetryActivitySignals {
  return {
    metricAttempted: current.metricAttempted || Boolean(update.metricAttempted),
    metricResolved: current.metricResolved || Boolean(update.metricResolved),
    logGapAttempted: current.logGapAttempted || Boolean(update.logGapAttempted),
    logGapResolved: current.logGapResolved || Boolean(update.logGapResolved),
    activityObserved: current.activityObserved || Boolean(update.activityObserved),
    ownerFound: current.ownerFound || Boolean(update.ownerFound),
    toolError: current.toolError || Boolean(update.toolError),
    nextMetricSource: current.nextMetricSource ?? update.nextMetricSource,
    nextLogSource: current.nextLogSource ?? update.nextLogSource,
  };
}

/**
 * Deterministically classify an unresolved telemetry gap from the fallback
 * attempts and activity signals gathered for one investigation item. Returns
 * undefined when no fallback was attempted, or when every attempted fallback
 * resolved the original missing-telemetry problem (recorded instead as
 * telemetry_fallbacks with outcome "resolved").
 */
function classifyTelemetryGap(
  attempts: TelemetryFallbackAttempt[],
  signals: TelemetryActivitySignals
): TelemetryGap | undefined {
  const metricGap = signals.metricAttempted && !signals.metricResolved;
  const logGap = signals.logGapAttempted && !signals.logGapResolved;

  if (attempts.length === 0 || (!metricGap && !logGap)) {
    return undefined;
  }

  if (signals.toolError) {
    return {
      kind: 'unknown',
      next_telemetry_source:
        signals.nextMetricSource ??
        signals.nextLogSource ??
        'Retry the failed fallback tool call once the underlying error clears.',
      fallback_attempts: attempts,
      reason: 'A telemetry fallback attempt errored, so the gap cannot be classified with confidence.',
    };
  }

  if (metricGap && signals.activityObserved) {
    return {
      kind: 'instrumentation',
      next_telemetry_source:
        signals.nextMetricSource ??
        'Confirm the metric publisher configuration and exact namespace/dimensions for the active workload.',
      fallback_attempts: attempts,
      reason:
        'Runtime activity was confirmed but the metric never published datapoints even after widened discovery.',
    };
  }

  if (logGap && signals.ownerFound) {
    return {
      kind: 'discovery',
      next_telemetry_source:
        signals.nextLogSource ?? 'Query the resolved runtime owner directly once its log group name is confirmed.',
      fallback_attempts: attempts,
      reason: 'A runtime owner was identified but no log group or log rows could be located after retry.',
    };
  }

  if (!signals.ownerFound && !signals.activityObserved) {
    return {
      kind: 'runtime',
      next_telemetry_source:
        signals.nextMetricSource ??
        signals.nextLogSource ??
        'Confirm whether the expected owner (ECS service, Lambda function, or EventBridge rule) still exists for this service name.',
      fallback_attempts: attempts,
      reason:
        'No runtime owner or activity could be found across metrics, logs, or discovery after bounded alternate lookups.',
    };
  }

  return {
    kind: 'unknown',
    next_telemetry_source:
      signals.nextMetricSource ??
      signals.nextLogSource ??
      'Re-attempt discovery once additional identifying details (dimensions, log group name) are available.',
    fallback_attempts: attempts,
    reason: 'Fallback attempts left conflicting or insufficient signal to classify the gap confidently.',
  };
}

/**
 * Collects telemetry-gap fallback attempts and activity signals per
 * investigation item while standard evidence is gathered, so Investigate can
 * pivot to alternate discovery paths before declaring an item an
 * observability gap, and can guarantee the attempt is captured even if the
 * model omits it from its structured output.
 */
class TelemetryFallbackCollector {
  private readonly attempts = new Map<string, TelemetryFallbackAttempt[]>();
  private readonly signals = new Map<string, TelemetryActivitySignals>();

  record(id: string, attempt: TelemetryFallbackAttempt): void {
    const list = this.attempts.get(id) ?? [];
    list.push(attempt);
    this.attempts.set(id, list);
  }

  mergeSignals(id: string, update: Partial<TelemetryActivitySignals>): void {
    const current = this.signals.get(id) ?? emptyTelemetrySignals();
    this.signals.set(id, mergeTelemetrySignals(current, update));
  }

  fallbacksById(): Map<string, TelemetryFallbackAttempt[]> {
    return this.attempts;
  }

  gapsById(): Map<string, TelemetryGap> {
    const gaps = new Map<string, TelemetryGap>();
    for (const [id, attempts] of this.attempts) {
      const signals = this.signals.get(id) ?? emptyTelemetrySignals();
      const gap = classifyTelemetryGap(attempts, signals);
      if (gap) {
        gaps.set(id, gap);
      }
    }
    return gaps;
  }
}

/**
 * Attempt alternate runtime-owner discovery when a service name resolves no
 * standard log groups: the service-resource registry (and evidence parsed
 * from it), Lambda/EventBridge names recovered from metric dimensions, and an
 * ECS service-events check. Retries log discovery/query against whatever
 * owner is found so an observability gap is only declared after this bounded
 * fallback, per the Investigate telemetry-gap recovery requirement.
 */
async function attemptRuntimeOwnerDiscovery(
  id: string,
  kind: InvestigationItem['kind'],
  service: string,
  discoveryText: string,
  metricDiscoveryText: string,
  ctx: ToolContext,
  telemetry: TelemetryFallbackCollector
): Promise<{ sections: string[]; logGroups: string[] }> {
  const sections: string[] = [];
  const resolved = resolveServiceResource(service, `${discoveryText}\n${metricDiscoveryText}`);
  const lambdaNames = selectLambdaFunctions(metricDiscoveryText);
  const eventBridgeNames = selectEventBridgeRules(metricDiscoveryText);

  const ecsEvidence = await runEvidenceTool(
    `### ${id} ${kind}: ECS service check for ${service} (runtime-owner discovery fallback)`,
    () => ecsServiceEventsTool.handler({ service_name: service }, ctx)
  );
  sections.push(ecsEvidence);
  const ecsActive = /status=ACTIVE/.test(ecsEvidence);
  const ecsErrored = isToolErrorText(ecsEvidence);

  // resolveServiceResource tags matchedBy=['evidence'] whenever it merely
  // looked at non-empty evidence text, even if no regex actually matched
  // anything — so only a known-registry match or a concretely extracted
  // ECS/log-group/alias/Lambda/EventBridge name counts as a resolved owner.
  const ownerFound =
    resolved.matchedBy.includes('known-registry') ||
    resolved.ecsServices.length > 0 ||
    resolved.logGroups.length > 0 ||
    resolved.aliases.length > 0 ||
    lambdaNames.length > 0 ||
    eventBridgeNames.length > 0 ||
    ecsActive;

  telemetry.mergeSignals(id, {
    logGapAttempted: true,
    ownerFound,
    activityObserved: ecsActive,
    toolError: ecsErrored,
  });

  telemetry.record(id, {
    path: 'runtime_owner_discovery',
    query: `resolve runtime owner for ${service} via the service-resource registry, get_ecs_service_events, and Lambda/EventBridge names from metric dimensions`,
    outcome: ownerFound ? 'resolved' : 'empty',
    detail: ownerFound
      ? `Resolved an alternate runtime owner for ${service}: ${[
          resolved.matchedBy.includes('known-registry') ? 'known service-resource registry entry' : null,
          resolved.ecsServices.length > 0
            ? `ECS service(s) ${resolved.ecsServices.map((s) => s.serviceName).join(', ')}`
            : null,
          lambdaNames.length > 0 ? `Lambda function(s) ${lambdaNames.join(', ')}` : null,
          eventBridgeNames.length > 0 ? `EventBridge rule(s) ${eventBridgeNames.join(', ')}` : null,
          ecsActive ? 'an active ECS service match' : null,
        ]
          .filter(Boolean)
          .join('; ')}.`
      : `No alternate runtime owner could be resolved for ${service} via the service-resource registry, ECS service events, or Lambda/EventBridge names from metric dimensions.`,
    next_source: resolved.logGroups[0] ?? (lambdaNames[0] ? `/aws/lambda/${lambdaNames[0]}` : undefined),
  });

  const directLogGroups = uniqueValues([
    ...resolved.logGroups,
    ...lambdaNames.map((name) => `/aws/lambda/${name}`),
  ]).slice(0, MAX_RUNTIME_OWNER_LOG_GROUPS);

  const aliasCandidates = uniqueValues([
    ...resolved.aliases,
    ...resolved.ecsServices.map((s) => s.serviceName),
  ]).filter((alias) => alias.toLowerCase() !== service.toLowerCase());

  const candidateLogGroups = [...directLogGroups];
  if (candidateLogGroups.length === 0 && aliasCandidates.length > 0) {
    const alias = aliasCandidates[0]!;
    const retryDiscovery = await runEvidenceTool(
      `### ${id} ${kind}: discover_log_groups(${alias}) (runtime-owner discovery fallback for ${service})`,
      () => discoverLogGroupsTool.handler({ service_name: alias, limit: 5 }, ctx)
    );
    sections.push(retryDiscovery);
    candidateLogGroups.push(...selectStandardLogGroups(retryDiscovery));
  }

  if (candidateLogGroups.length === 0 && aliasCandidates.length === 0) {
    return { sections, logGroups: [] };
  }

  let runtimeRowsFound = false;
  let queryErrored = false;
  for (const logGroup of candidateLogGroups.slice(0, MAX_RUNTIME_OWNER_LOG_GROUPS)) {
    const activityText = await runEvidenceTool(
      `### ${id} ${kind}: recent runtime activity sample on ${logGroup} (runtime-owner discovery fallback for ${service})`,
      () =>
        queryLogsTool.handler(
          {
            log_group: logGroup,
            filter_or_query: RECENT_ACTIVITY_QUERY,
            lookback_minutes: ctx.maxLookbackMinutes,
            limit: 25,
          },
          ctx
        )
    );
    sections.push(activityText);
    if (hasRuntimeRows(activityText)) {
      runtimeRowsFound = true;
    }
    if (isToolErrorText(activityText)) {
      queryErrored = true;
    }
  }

  // A resolved log group name alone is not proof of activity: only recent rows
  // confirm the workload actually ran, so classification treats "found the
  // group but zero rows" the same as "no group at all" (still a gap).
  const logGapResolved = runtimeRowsFound;
  telemetry.mergeSignals(id, {
    logGapResolved,
    activityObserved: runtimeRowsFound,
    toolError: queryErrored,
    nextLogSource: candidateLogGroups[0]
      ? `query_logs against ${candidateLogGroups[0]} with a wider lookback window`
      : undefined,
  });

  telemetry.record(id, {
    path: 'log_group_retry',
    query:
      candidateLogGroups.length > 0
        ? `query_logs recent-activity retry on ${candidateLogGroups.join(', ')}`
        : `discover_log_groups retry using alternate owner name "${aliasCandidates[0]}"`,
    outcome: queryErrored ? 'error' : logGapResolved ? 'resolved' : 'empty',
    detail: queryErrored
      ? 'The log retry against the discovered runtime owner failed.'
      : runtimeRowsFound
        ? `Recent runtime log rows were found on ${candidateLogGroups.join(', ')} after retry.`
        : candidateLogGroups.length > 0
          ? `Log group(s) ${candidateLogGroups.join(', ')} were found but returned no recent rows.`
          : `No log group could be found for ${service} even after retrying discovery with alternate owner name "${aliasCandidates[0]}".`,
    next_source: candidateLogGroups[0],
  });

  return { sections, logGroups: candidateLogGroups };
}

async function gatherStandardEvidence(
  classification: ClassificationResult,
  ctx: ToolContext,
  tracker = new EvidenceRequirementTracker()
): Promise<{
  evidence: string;
  requirements: EvidenceRequirement[];
  telemetryFallbacks: Map<string, TelemetryFallbackAttempt[]>;
  telemetryGaps: Map<string, TelemetryGap>;
}> {
  const telemetry = new TelemetryFallbackCollector();
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
          const customMetricHistoryRequirement = tracker.require(
            id,
            'CUSTOM_METRIC_HISTORY',
            metricKey(metric),
            `Fetch extended history for ${metric.namespace}/${metric.metric_name} to locate the last datapoint before the report window.`,
            'Use get_metrics_and_alarms with a multi-day window and period_seconds=3600.'
          );
          const extendedHistoryText = await runRequiredEvidenceTool(
            `### ${id} ${kind}: extended 14-day history for ${metric.namespace}/${metric.metric_name} (locates the last datapoint before the report window)`,
            customMetricHistoryRequirement,
            tracker,
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
          );
          sections.push(extendedHistoryText);

          const primaryHasData = hasMetricDatapoints(evidence);
          const primaryMissingDatapoints = hasNoMetricDatapoints(evidence);
          const extendedHasData = hasMetricDatapoints(extendedHistoryText);
          const extendedErrored = isToolErrorText(extendedHistoryText);
          telemetry.mergeSignals(id, {
            metricAttempted: true,
            metricResolved: primaryHasData || extendedHasData,
            toolError: extendedErrored,
            nextMetricSource: `${metric.namespace}/${metric.metric_name} (alarm configuration and log-based runtime activity)`,
          });
          if (primaryMissingDatapoints) {
            telemetry.record(id, {
              path: 'metric_widened_lookback',
              query: `get_metrics_and_alarms(${metric.namespace}/${metric.metric_name}, ${extendedWindow.start_time}..${extendedWindow.end_time}, period_seconds=${OBSERVABILITY_METRIC_PERIOD_SECONDS})`,
              outcome: extendedErrored ? 'error' : extendedHasData ? 'resolved' : 'empty',
              detail: extendedErrored
                ? 'The extended metric history query failed.'
                : extendedHasData
                  ? 'The widened 14-day lookback located datapoints outside the report window.'
                  : 'The widened 14-day lookback still returned no datapoints for this metric.',
              next_source: extendedHasData
                ? undefined
                : `${metric.namespace}/${metric.metric_name} alarm configuration and log-based runtime activity`,
            });
          }
        }
      }
    }

    const spike = extractSpikeWindow(errorMetricEvidence);
    const windowArgs = spike
      ? { start_time: spike.start, end_time: spike.end }
      : { lookback_minutes: ctx.maxLookbackMinutes };
    const lambdaLogWindowArgs = spike ? windowArgs : reportWindow(ctx) ?? windowArgs;
    const windowLabel = spike
      ? `narrowed to metric spike window ${spike.start}..${spike.end}`
      : `report window or ${ctx.maxLookbackMinutes} minute lookback`;
    const lambdaLogWindowLabel = spike ? windowLabel : 'report window';

    if (shouldQuery5xx) {
      const explicitAlbDimension = cloudwatchMetrics
        .filter((metric) => metric.namespace === 'AWS/ApplicationELB')
        .flatMap((metric) => metric.dimensions ?? [])
        .find((dimension) => dimension.name === 'LoadBalancer')?.value;

      // Fall back to the generic service-resource registry when Step 1 did not
      // supply an explicit ALB metric signal, so the same 5xx drilldown works
      // for any ALB-backed service, not only ones Classify instrumented.
      const albTargets = explicitAlbDimension
        ? [explicitAlbDimension]
        : uniqueValues(
            item.affected_services.map((service) => resolveServiceResource(service).albs[0]?.loadBalancer)
          );

      for (const albDimension of albTargets) {
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

      let ecsEvidenceText = '';
      if (shouldQuery5xx) {
        ecsEvidenceText = await runEvidenceTool(
          `### ${id} ${kind}: ECS service events for ${service} (${windowLabel})`,
          () => ecsServiceEventsTool.handler({ service_name: service, ...windowArgs }, ctx)
        );
        sections.push(ecsEvidenceText);
      }

      let metricDiscovery = '';
      if (shouldQueryObservability) {
        metricDiscovery = await gatherExpandedLivenessMetricDiscovery(id, kind, service, ctx);
        sections.push(metricDiscovery);

        const discoveredLambdaNames = selectLambdaFunctions(metricDiscovery);
        const discoveredEventBridgeNames = selectEventBridgeRules(metricDiscovery);

        const extendedWindow = extendedMetricWindow(ctx);
        if (extendedWindow) {
          const livenessMetricCandidates = selectLivenessMetricCandidates(
            metricDiscovery,
            service,
            knownMetricKeys
          );
          telemetry.mergeSignals(id, {
            metricAttempted: true,
            ownerFound: discoveredLambdaNames.length > 0 || discoveredEventBridgeNames.length > 0,
          });
          telemetry.record(id, {
            path: 'metric_exact_discovery',
            query: `list_metrics expanded discovery for ${service} (service/detector search terms plus liveness/heartbeat names)`,
            outcome: livenessMetricCandidates.length > 0 ? 'resolved' : 'empty',
            detail:
              livenessMetricCandidates.length > 0
                ? `Found ${livenessMetricCandidates.length} candidate liveness/heartbeat metric(s) via expanded discovery: ${livenessMetricCandidates.map(metricKey).join(', ')}.`
                : `No liveness/heartbeat metric candidates were found via expanded list_metrics discovery for ${service}.`,
            next_source: livenessMetricCandidates[0] ? metricKey(livenessMetricCandidates[0]) : undefined,
          });
          if (livenessMetricCandidates.length === 0) {
            const customMetricHistoryRequirement = tracker.require(
              id,
              'CUSTOM_METRIC_HISTORY',
              `${service}:expanded-liveness-discovery`,
              `Find a liveness or heartbeat metric for ${service} and fetch extended history.`,
              'Expanded pre-gather searched by service, detector base name, liveness/heartbeat terms, and known detector metric names.'
            );
            tracker.markUnavailable(
              customMetricHistoryRequirement,
              `### ${id} ${kind}: expanded liveness metric discovery for ${service}`,
              `No liveness/heartbeat custom metric candidates found after bounded discovery searches for ${service}.`
            );
            sections.push(
              `### ${id} ${kind}: liveness metric history unavailable for ${service}\n` +
                `No liveness/heartbeat custom metric candidates found after bounded discovery searches for ${service}.`
            );
          }

          for (const metric of livenessMetricCandidates) {
            const customMetricHistoryRequirement = tracker.require(
              id,
              'CUSTOM_METRIC_HISTORY',
              metricKey(metric),
              `Fetch extended history for discovered liveness metric ${metric.namespace}/${metric.metric_name}.`,
              'Use get_metrics_and_alarms with a multi-day window and period_seconds=3600.'
            );
            const discoveredMetricHistoryText = await runRequiredEvidenceTool(
              `### ${id} ${kind}: discovered liveness metric 14-day history for ${metric.namespace}/${metric.metric_name} (locates the last datapoint before the report window)`,
              customMetricHistoryRequirement,
              tracker,
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
            );
            sections.push(discoveredMetricHistoryText);

            const discoveredMetricResolved = hasMetricDatapoints(discoveredMetricHistoryText);
            const discoveredMetricErrored = isToolErrorText(discoveredMetricHistoryText);
            telemetry.mergeSignals(id, {
              metricResolved: discoveredMetricResolved,
              toolError: discoveredMetricErrored,
              nextMetricSource: `${metric.namespace}/${metric.metric_name} (discovered liveness metric)`,
            });
            telemetry.record(id, {
              path: 'metric_widened_lookback',
              query: `get_metrics_and_alarms(${metric.namespace}/${metric.metric_name}, extended window, period_seconds=${OBSERVABILITY_METRIC_PERIOD_SECONDS})`,
              outcome: discoveredMetricErrored ? 'error' : discoveredMetricResolved ? 'resolved' : 'empty',
              detail: discoveredMetricErrored
                ? 'The discovered liveness metric extended history query failed.'
                : discoveredMetricResolved
                  ? `Extended history for the discovered liveness metric ${metric.namespace}/${metric.metric_name} located datapoints.`
                  : `Extended history for the discovered liveness metric ${metric.namespace}/${metric.metric_name} still returned no datapoints.`,
              next_source: discoveredMetricResolved ? undefined : metricKey(metric),
            });
          }
        }

        const alarmCoverageRequirement = tracker.require(
          id,
          'ALARM_COVERAGE',
          service,
          `Check alarm coverage for ${service}.`,
          'Use find_alarms by service search or exact metric identity.'
        );
        const alarmCoverageText = await runRequiredEvidenceTool(
          `### ${id} ${kind}: alarm coverage for ${service}`,
          alarmCoverageRequirement,
          tracker,
          () => findAlarmsTool.handler({ search: service }, ctx)
        );
        sections.push(alarmCoverageText);

        const alarmsFound = /Found \d+ alarm/.test(alarmCoverageText);
        const alarmErrored = isToolErrorText(alarmCoverageText);
        telemetry.mergeSignals(id, { toolError: alarmErrored });
        telemetry.record(id, {
          path: 'alarm_configuration',
          query: `find_alarms(search=${service})`,
          outcome: alarmErrored ? 'error' : alarmsFound ? 'resolved' : 'empty',
          detail: alarmErrored
            ? 'The alarm-configuration lookup failed.'
            : alarmsFound
              ? `Alarm configuration (state, threshold, evaluation period, missing-data handling) found for ${service}.`
              : `No alarm coverage was found for ${service} by name search.`,
        });

        for (const functionName of selectLambdaFunctions(metricDiscovery)) {
          if (rootCauseFunctionsGathered.has(functionName)) {
            continue;
          }
          rootCauseFunctionsGathered.add(functionName);
          sections.push(
            ...(await gatherLambdaRootCauseEvidence(
              id,
              kind,
              functionName,
              lambdaLogWindowArgs,
              lambdaLogWindowLabel,
              ctx,
              tracker
            ))
          );
        }

        for (const ruleName of selectEventBridgeRules(metricDiscovery)) {
          if (rootCauseRulesGathered.has(ruleName)) {
            continue;
          }
          rootCauseRulesGathered.add(ruleName);
          sections.push(
            ...(await gatherEventBridgeRootCauseEvidence(id, kind, ruleName, ctx, tracker))
          );
        }
      }

      const discovery = await runEvidenceTool(
        `### ${id} ${kind}: discover_log_groups(${service})`,
        () => discoverLogGroupsTool.handler({ service_name: service, limit: 5 }, ctx)
      );
      sections.push(discovery);

      if (shouldQuery5xx) {
        sections.push(
          ...(await gatherApplicationCausalEvidence(
            id,
            kind,
            service,
            `${discovery}\n${ecsEvidenceText}`,
            windowArgs,
            windowLabel,
            ctx,
            tracker
          ))
        );
      }

      let logGroups = selectStandardLogGroups(discovery);
      if (logGroups.length === 0 && shouldQueryObservability) {
        const runtimeOwnerFallback = await attemptRuntimeOwnerDiscovery(
          id,
          kind,
          service,
          discovery,
          metricDiscovery,
          ctx,
          telemetry
        );
        sections.push(...runtimeOwnerFallback.sections);
        if (runtimeOwnerFallback.logGroups.length > 0) {
          logGroups = runtimeOwnerFallback.logGroups;
        }
      }
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
          const firstBadLogRequirement = tracker.require(
            id,
            'FIRST_BAD_LOG_TIMESTAMP',
            logGroup,
            `Find the first bad log timestamp in ${logGroup}.`,
            'Use query_logs with an aggregate min(@timestamp) over error/exception/timeout lines.'
          );
          sections.push(
            await runRequiredEvidenceTool(
              `### ${id} ${kind}: first bad log timestamp on ${logGroup} (${windowLabel})`,
              firstBadLogRequirement,
              tracker,
              () =>
                queryLogsTool.handler(
                  {
                    log_group: logGroup,
                    filter_or_query: FIRST_BAD_LOG_TIMESTAMP_QUERY,
                    ...windowArgs,
                    limit: 25,
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
          const activityText = await runEvidenceTool(
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
          );
          sections.push(activityText);
          telemetry.mergeSignals(id, {
            activityObserved: hasRuntimeRows(activityText),
            ownerFound: true,
            toolError: isToolErrorText(activityText),
          });
        }
      }
    }
  }

  return {
    evidence: sections.join('\n\n'),
    requirements: tracker.all(),
    telemetryFallbacks: telemetry.fallbacksById(),
    telemetryGaps: telemetry.gapsById(),
  };
}

/**
 * Guarantee telemetry-gap fallback attempts and unresolved-gap classification
 * survive even if the model omits them from its structured output: attach the
 * deterministic pre-gather results whenever the model didn't already report
 * its own, then re-validate so downstream consumers always see the schema's
 * shape.
 */
function mergeTelemetryData(
  result: InvestigationResult,
  fallbacksById: Map<string, TelemetryFallbackAttempt[]>,
  gapsById: Map<string, TelemetryGap>
): InvestigationResult {
  if (fallbacksById.size === 0 && gapsById.size === 0) {
    return result;
  }

  const merged: InvestigationResult = {
    ...result,
    investigations: result.investigations.map((investigation) => {
      const deterministicFallbacks = fallbacksById.get(investigation.incident_id);
      const deterministicGap = gapsById.get(investigation.incident_id);
      const telemetry_fallbacks =
        investigation.telemetry_fallbacks && investigation.telemetry_fallbacks.length > 0
          ? investigation.telemetry_fallbacks
          : deterministicFallbacks;
      const telemetry_gap = investigation.telemetry_gap ?? deterministicGap;

      if (!telemetry_fallbacks && !telemetry_gap) {
        return investigation;
      }
      return {
        ...investigation,
        ...(telemetry_fallbacks ? { telemetry_fallbacks } : {}),
        ...(telemetry_gap ? { telemetry_gap } : {}),
      };
    }),
  };

  try {
    return parseInvestigation(merged);
  } catch (error) {
    console.warn(
      '[Investigate] Deterministic telemetry-gap merge failed re-validation; keeping model output',
      error
    );
    return result;
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

    const toolContext = buildToolContext(config, classification);
    const preGathered = await gatherStandardEvidence(classification, toolContext);
    const step1Json = JSON.stringify(classification, null, 2);
    const prompt = buildInvestigatePrompt(step1Json, preGathered.evidence);

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
      const merged = mergeTelemetryData(parsed, preGathered.telemetryFallbacks, preGathered.telemetryGaps);
      const closed = await maybeRunRootCauseClosure(
        merged,
        closureRequirementsForDraft(merged, preGathered.requirements),
        loopOptions,
        prompt,
        config
      );
      const closedMerged = mergeTelemetryData(closed, preGathered.telemetryFallbacks, preGathered.telemetryGaps);
      return { stage: 'Investigate', status: 'success', timestamp, data: closedMerged };
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
      const merged = mergeTelemetryData(repaired, preGathered.telemetryFallbacks, preGathered.telemetryGaps);
      const closed = await maybeRunRootCauseClosure(
        merged,
        closureRequirementsForDraft(merged, preGathered.requirements),
        loopOptions,
        prompt,
        config
      );
      const closedMerged = mergeTelemetryData(closed, preGathered.telemetryFallbacks, preGathered.telemetryGaps);
      return { stage: 'Investigate', status: 'success', timestamp, data: closedMerged };
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
