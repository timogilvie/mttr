import type { Config } from '../config.js';
import type {
  StageInput,
  StageResult,
  ClassificationResult,
  InvestigationResult,
  EvidenceRequirementType,
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
import { parseInvestigation } from '../validation/investigationSchema.js';
import { stripMarkdownFences } from '../llm/json.js';
import type { Finding, Incident, IncidentClassification } from '../types.js';
import { correlateInvestigations } from './correlate.js';

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

async function gatherStandardEvidence(
  classification: ClassificationResult,
  ctx: ToolContext,
  tracker = new EvidenceRequirementTracker()
): Promise<{ evidence: string; requirements: EvidenceRequirement[] }> {
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
          sections.push(
            await runRequiredEvidenceTool(
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
            )
          );
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
        const metricDiscovery = await gatherExpandedLivenessMetricDiscovery(id, kind, service, ctx);
        sections.push(metricDiscovery);

        const extendedWindow = extendedMetricWindow(ctx);
        if (extendedWindow) {
          const livenessMetricCandidates = selectLivenessMetricCandidates(
            metricDiscovery,
            service,
            knownMetricKeys
          );
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
            sections.push(
              await runRequiredEvidenceTool(
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
              )
            );
          }
        }

        const alarmCoverageRequirement = tracker.require(
          id,
          'ALARM_COVERAGE',
          service,
          `Check alarm coverage for ${service}.`,
          'Use find_alarms by service search or exact metric identity.'
        );
        sections.push(
          await runRequiredEvidenceTool(
            `### ${id} ${kind}: alarm coverage for ${service}`,
            alarmCoverageRequirement,
            tracker,
            () => findAlarmsTool.handler({ search: service }, ctx)
          )
        );

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

  return { evidence: sections.join('\n\n'), requirements: tracker.all() };
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
      const closed = await maybeRunRootCauseClosure(
        parsed,
        closureRequirementsForDraft(parsed, preGathered.requirements),
        loopOptions,
        prompt,
        config
      );
      return {
        stage: 'Investigate',
        status: 'success',
        timestamp,
        data: correlateInvestigations(closed),
      };
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
      const closed = await maybeRunRootCauseClosure(
        repaired,
        closureRequirementsForDraft(repaired, preGathered.requirements),
        loopOptions,
        prompt,
        config
      );
      return {
        stage: 'Investigate',
        status: 'success',
        timestamp,
        data: correlateInvestigations(closed),
      };
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
