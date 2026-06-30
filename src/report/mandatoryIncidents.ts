import type {
  ClassificationResult,
  CloudWatchMetricSignal,
  Incident,
  IncidentClassification,
  Severity,
} from '../types.js';

interface MandatoryIncidentSpec {
  key: string;
  title: string;
  classification: IncidentClassification;
  severity: Severity;
  confidence: number;
  affectedService: string;
  serviceAliases?: string[];
  evidence: string[];
  alarms?: string[];
  metrics?: string[];
  cloudwatchMetrics?: CloudWatchMetricSignal[];
  logs?: string[];
  suspectedCauses: string[];
  firstActions: string[];
  questions: string[];
  queries: string[];
  userImpact: 'NONE' | 'MINIMAL' | 'PARTIAL' | 'SIGNIFICANT' | 'COMPLETE';
}

interface ServiceSection {
  service: string;
  body: string;
}

const SERVICE_HEADING_RE = /^### (.+)$/gm;
const ALARM_ROW_RE = /^\|\s*`([^`]+)`\s*\|\s*`?ALARM`?\s*\|/gm;
const ALB_ROW_RE = /^\|\s*`?([^|`]+)`?\s*\|\s*([\d,]+|-)\s*\|\s*([\d,]+|-)\s*\|\s*([\d,]+|-)\s*\|\s*([\d,]+|-)\s*\|/gm;
const ALB_DIMS_RE = /_ALB dims:\s*TargetGroup=`([^`]+)`\s+LoadBalancer=`([^`]+)`_/i;
const ECS_SERVICE_RE = /^-\s*ECS service:\s*`([^`]+)`/im;
const ECS_TASKS_RE = /^-\s*Tasks:\s*`?(\d+)`?\s*\/\s*`?(\d+)`?\s*running,\s*`?(\d+)`?\s*pending/im;

function splitServiceSections(report: string): ServiceSection[] {
  const matches = [...report.matchAll(SERVICE_HEADING_RE)];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const next = matches[index + 1]?.index ?? report.length;
    return {
      service: match[1]?.trim() ?? 'unknown-service',
      body: report.slice(start, next),
    };
  });
}

function parseCount(raw: string): number | null {
  if (raw.trim() === '-') {
    return null;
  }

  const parsed = Number.parseInt(raw.replaceAll(',', ''), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function severityFor5xx(totalRequests: number | null, fiveXx: number): Severity {
  if (fiveXx >= 10) {
    return 'HIGH';
  }

  if (totalRequests && totalRequests > 0 && fiveXx / totalRequests >= 0.05) {
    return 'HIGH';
  }

  return 'MEDIUM';
}

function buildIncident(spec: MandatoryIncidentSpec, index: number): Incident {
  return {
    incident_id: `mandatory-${spec.key}-${index}`,
    title: spec.title,
    classification: spec.classification,
    severity: spec.severity,
    confidence: spec.confidence,
    affected_services: [spec.affectedService],
    evidence: spec.evidence,
    signals: {
      alarms: spec.alarms ?? [],
      metrics: spec.metrics ?? [],
      logs: spec.logs ?? [],
      cloudwatch_metrics: spec.cloudwatchMetrics ?? [],
    },
    suspected_causes: spec.suspectedCauses,
    investigation_plan: {
      priority: index + 1,
      estimated_user_impact: spec.userImpact,
      first_actions: spec.firstActions,
      questions_to_answer: spec.questions,
      suggested_cloudwatch_queries: spec.queries,
    },
    recommended_next_stage: 'INVESTIGATE',
  };
}

function extractAlbDimensions(body: string): { targetGroup: string; loadBalancer: string } | undefined {
  const match = body.match(ALB_DIMS_RE);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  return { targetGroup: match[1], loadBalancer: match[2] };
}

function extractEcsServiceName(body: string): string | undefined {
  return body.match(ECS_SERVICE_RE)?.[1]?.trim();
}

function extractEcsTaskCounts(body: string): { running: number; desired: number; pending: number } | undefined {
  const match = body.match(ECS_TASKS_RE);
  if (!match?.[1] || !match[2] || !match[3]) {
    return undefined;
  }

  const running = Number.parseInt(match[1], 10);
  const desired = Number.parseInt(match[2], 10);
  const pending = Number.parseInt(match[3], 10);
  if ([running, desired, pending].some(Number.isNaN)) {
    return undefined;
  }

  return { running, desired, pending };
}

function isTaskHealthAlarm(alarmName: string): boolean {
  return /(?:task|service|target|container)[-_ ]?(?:health|unhealthy)|(?:health|unhealthy)[-_ ]?(?:task|service|target|container)/i.test(
    alarmName
  );
}

function normalizeSignal(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function hasExactSignalMatch(values: string[], signals: string[] | undefined): boolean {
  if (!signals || signals.length === 0) {
    return false;
  }

  const normalizedValues = values.map(normalizeSignal);
  return signals
    .map(normalizeSignal)
    .some((signal) =>
      normalizedValues.some((value) => value === signal || value.includes(signal))
    );
}

function incidentServiceMatchesSpec(incident: Incident, spec: MandatoryIncidentSpec): boolean {
  const services = [spec.affectedService, ...(spec.serviceAliases ?? [])].map((service) =>
    service.toLowerCase()
  );
  return incident.affected_services.some((service) => services.includes(service.toLowerCase()));
}

function incidentCoversSpec(incident: Incident, spec: MandatoryIncidentSpec): boolean {
  if (!incidentServiceMatchesSpec(incident, spec)) {
    return false;
  }

  if (
    hasExactSignalMatch(incident.signals.alarms, spec.alarms) ||
    hasExactSignalMatch(incident.signals.metrics, spec.metrics) ||
    hasExactSignalMatch(incident.evidence, spec.alarms) ||
    hasExactSignalMatch(incident.evidence, spec.metrics) ||
    hasExactSignalMatch(incident.evidence, spec.evidence)
  ) {
    return true;
  }

  const haystack = [
    incident.title,
    incident.classification,
    ...incident.affected_services,
    ...incident.evidence,
    ...incident.signals.alarms,
    ...incident.signals.metrics,
    ...incident.signals.logs,
  ]
    .join(' ')
    .toLowerCase();

  const signal = [...(spec.alarms ?? []), ...(spec.metrics ?? []), ...spec.evidence]
    .join(' ')
    .toLowerCase();

  return signal.split(/\s+/).some((token) => token.length > 8 && haystack.includes(token));
}

function findingCoversSpec(findingText: string, spec: MandatoryIncidentSpec): boolean {
  const services = [spec.affectedService, ...(spec.serviceAliases ?? [])].map((service) => service.toLowerCase());
  const signal = [...(spec.alarms ?? []), ...(spec.metrics ?? []), ...spec.evidence]
    .join(' ')
    .toLowerCase();

  return (
    services.some((service) => findingText.includes(service)) &&
    signal.split(/\s+/).some((token) => token.length > 8 && findingText.includes(token))
  );
}

function mergeCloudWatchMetrics(
  existing: CloudWatchMetricSignal[] | undefined,
  added: CloudWatchMetricSignal[] | undefined
): CloudWatchMetricSignal[] | undefined {
  if (!added || added.length === 0) {
    return existing;
  }

  const merged = [...(existing ?? [])];
  const keys = new Set(
    merged.map((metric) =>
      [
        metric.namespace,
        metric.metric_name,
        ...metric.dimensions.map((dimension) => `${dimension.name}=${dimension.value}`).sort(),
      ].join('|')
    )
  );

  for (const metric of added) {
    const key = [
      metric.namespace,
      metric.metric_name,
      ...metric.dimensions.map((dimension) => `${dimension.name}=${dimension.value}`).sort(),
    ].join('|');
    if (!keys.has(key)) {
      keys.add(key);
      merged.push(metric);
    }
  }

  return merged;
}

function enrichIncidentWithSpec(incident: Incident, spec: MandatoryIncidentSpec): Incident {
  const cloudwatchMetrics = mergeCloudWatchMetrics(
    incident.signals.cloudwatch_metrics,
    spec.cloudwatchMetrics
  );

  if (cloudwatchMetrics === incident.signals.cloudwatch_metrics) {
    return incident;
  }

  return {
    ...incident,
    signals: {
      ...incident.signals,
      cloudwatch_metrics: cloudwatchMetrics,
    },
  };
}

function extractActiveAlarmSpecs(report: string): MandatoryIncidentSpec[] {
  return splitServiceSections(report).flatMap(({ service, body }) => {
    const ecsService = extractEcsServiceName(body);
    const alarms = [...body.matchAll(ALARM_ROW_RE)]
      .map((match) => match[1]?.trim())
      .filter((alarmName): alarmName is string => Boolean(alarmName));

    return alarms.map((alarmName) => {
      const taskHealthAlarm = isTaskHealthAlarm(alarmName);
      const affectedService = ecsService ?? service;
      return {
        key: `active-alarm-${alarmName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
        title: `Active alarm for ${service}: ${alarmName}`,
        classification: 'UNKNOWN' as const,
        severity: taskHealthAlarm ? ('CRITICAL' as const) : ('HIGH' as const),
        confidence: 0.95,
        affectedService,
        serviceAliases: ecsService && ecsService !== service ? [service] : [],
        evidence: [
          `Health report lists alarm ${alarmName} in ALARM state for ${service}.`,
          ...(ecsService && ecsService !== service ? [`ECS service is ${ecsService}.`] : []),
        ],
        alarms: [alarmName],
        suspectedCauses: ['CloudWatch alarm threshold is currently breached.'],
        firstActions: [`Inspect CloudWatch alarm ${alarmName} history and reason.`],
        questions: [
          'When did the alarm enter ALARM state?',
          'Which underlying metric or event triggered the alarm?',
          'Is the alarm correlated with task health, deploys, errors, or traffic changes?',
        ],
        queries: [`CloudWatch alarm history and metric data for ${alarmName}.`],
        userImpact: taskHealthAlarm ? ('COMPLETE' as const) : ('PARTIAL' as const),
      };
    });
  });
}

function extractUnavailableEcsServiceSpecs(report: string): MandatoryIncidentSpec[] {
  return splitServiceSections(report).flatMap(({ service, body }) => {
    const taskCounts = extractEcsTaskCounts(body);
    if (!taskCounts || taskCounts.desired <= 0 || taskCounts.running > 0) {
      return [];
    }

    const ecsService = extractEcsServiceName(body);
    const affectedService = ecsService ?? service;
    return [
      {
        key: `ecs-service-unavailable-${affectedService.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
        title: `ECS service unavailable for ${service}`,
        classification: 'UNKNOWN' as const,
        severity: 'CRITICAL' as const,
        confidence: 0.99,
        affectedService,
        serviceAliases: ecsService && ecsService !== service ? [service] : [],
        evidence: [
          `Health report shows ${taskCounts.running}/${taskCounts.desired} ECS tasks running for ${service}.`,
          `Pending tasks: ${taskCounts.pending}.`,
          ...(ecsService && ecsService !== service ? [`ECS service is ${ecsService}.`] : []),
        ],
        metrics: [`ECS desired tasks: ${taskCounts.desired}`, `ECS running tasks: ${taskCounts.running}`],
        suspectedCauses: [
          'The ECS service has no healthy running tasks, so the service is unavailable until tasks recover.',
        ],
        firstActions: [
          `Inspect ECS service events for ${affectedService}.`,
          'Check stopped-task reasons, failed health checks, deployment state, and image/runtime errors.',
        ],
        questions: [
          'When did the last healthy task stop?',
          'Are replacement tasks failing to start or failing load balancer health checks?',
          'Did this coincide with a deployment, configuration change, or dependency outage?',
        ],
        queries: [`ECS service events and stopped-task reasons for ${affectedService}.`],
        userImpact: 'COMPLETE' as const,
      },
    ];
  });
}

function extractAlb5xxSpecs(report: string): MandatoryIncidentSpec[] {
  return splitServiceSections(report).flatMap(({ service, body }) => {
    const specs: MandatoryIncidentSpec[] = [];
    const dimensions = extractAlbDimensions(body);

    for (const match of body.matchAll(ALB_ROW_RE)) {
      const target = match[1]?.trim();
      if (!target || !match[2] || !match[5]) {
        continue;
      }

      if (target.toLowerCase() === 'alb target') {
        continue;
      }

      const requests = parseCount(match[2]);
      const fiveXx = parseCount(match[5]);
      if (!fiveXx || fiveXx <= 0) {
        continue;
      }

      const rate = requests && requests > 0 ? ` (${Math.round((fiveXx / requests) * 100)}% of ${requests} requests)` : '';
      specs.push({
        key: `alb-5xx-${service.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${target.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
        title: `ALB 5xx responses for ${service}`,
        classification: 'APPLICATION_ERROR',
        severity: severityFor5xx(requests, fiveXx),
        confidence: 0.9,
        affectedService: service,
        evidence: [`Health report shows ${fiveXx} ALB 5xx responses for ${target}${rate}.`],
        metrics: [`ALB 5xx responses: ${fiveXx}`],
        cloudwatchMetrics: dimensions
          ? [
              {
                namespace: 'AWS/ApplicationELB',
                metric_name: 'HTTPCode_Target_5XX_Count',
                stat: 'Sum',
                label: 'Target 5xx responses from the health report ALB dimensions',
                dimensions: [
                  { name: 'LoadBalancer', value: dimensions.loadBalancer },
                  { name: 'TargetGroup', value: dimensions.targetGroup },
                ],
              },
              {
                namespace: 'AWS/ApplicationELB',
                metric_name: 'HTTPCode_ELB_5XX_Count',
                stat: 'Sum',
                label: 'Load balancer generated 5xx responses for the same ALB',
                dimensions: [{ name: 'LoadBalancer', value: dimensions.loadBalancer }],
              },
            ]
          : [],
        logs: [],
        suspectedCauses: ['Application or upstream dependency returned server errors behind the load balancer.'],
        firstActions: [
          `Inspect recent ${service} logs for 5xx errors.`,
          'Check deployment timing and downstream dependency health for the same window.',
        ],
        questions: [
          'Which endpoint returned the 5xx responses?',
          'Did the errors start after a deploy or dependency change?',
          'Are retries or customers currently affected?',
        ],
        queries: [`CloudWatch Logs Insights query for ${service} HTTP 5xx responses in the report window.`],
        userImpact: 'PARTIAL',
      });
    }

    return specs;
  });
}

function extractMissingDetectorSpecs(report: string): MandatoryIncidentSpec[] {
  return splitServiceSections(report)
    .filter(({ body }) => /No datapoints from the detector's liveness metric/i.test(body))
    .map(({ service }) => ({
      key: `missing-detector-liveness-${service.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
      title: `No detector liveness datapoints for ${service}`,
      classification: 'OBSERVABILITY_FAILURE' as const,
      severity: 'HIGH' as const,
      confidence: 0.95,
      affectedService: service,
      evidence: [
        "Health report says no datapoints were received from the detector's liveness metric in this window.",
        'The report states zero datapoints means the detector stopped running and anomalies would go undetected.',
      ],
      metrics: ['Detector liveness metric has zero datapoints.'],
      suspectedCauses: ['Detector runtime, scheduler, permissions, or metric publication path may be broken.'],
      firstActions: [
        'Inspect detector metric history and alarm coverage.',
        'Locate detector runtime logs or deployment records for the report window.',
      ],
      questions: [
        'When did liveness datapoints stop?',
        'Did the detector stop running, or did metric emission fail?',
        'Why are no alarms configured for this detector prefix?',
      ],
      queries: ['CloudWatch metric statistics for detector liveness and related Lambda or scheduler logs.'],
      userImpact: 'SIGNIFICANT' as const,
    }));
}

function mandatoryIncidentSpecs(report: string): MandatoryIncidentSpec[] {
  return [
    ...extractUnavailableEcsServiceSpecs(report),
    ...extractActiveAlarmSpecs(report),
    ...extractAlb5xxSpecs(report),
    ...extractMissingDetectorSpecs(report),
  ];
}

function maxSeverity(a: Severity, b: Severity): Severity {
  const order: Severity[] = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

function specDedupeKey(spec: MandatoryIncidentSpec): string {
  return [
    normalizeSignal(spec.affectedService),
    spec.classification,
    ...(spec.alarms ?? []).map(normalizeSignal).sort(),
    ...(spec.metrics ?? []).map(normalizeSignal).sort(),
  ].join('|');
}

function dedupeMandatorySpecs(specs: MandatoryIncidentSpec[]): MandatoryIncidentSpec[] {
  const byKey = new Map<string, MandatoryIncidentSpec>();
  for (const spec of specs) {
    const key = specDedupeKey(spec);
    const existing = byKey.get(key);
    if (!existing || maxSeverity(spec.severity, existing.severity) === spec.severity) {
      byKey.set(key, spec);
    }
  }
  return [...byKey.values()];
}

export function enforceMandatoryIncidents(
  classification: ClassificationResult,
  report: string
): ClassificationResult {
  const specs = dedupeMandatorySpecs(mandatoryIncidentSpecs(report));
  let didEnrichIncident = false;
  const enrichedIncidents = classification.incidents.map((incident) => {
    const coveringSpec = specs.find((spec) => incidentCoversSpec(incident, spec));
    const enriched = coveringSpec ? enrichIncidentWithSpec(incident, coveringSpec) : incident;
    didEnrichIncident ||= enriched !== incident;
    return enriched;
  });
  const missingSpecs = specs.filter(
    (spec) => !classification.incidents.some((incident) => incidentCoversSpec(incident, spec))
  );

  if (missingSpecs.length === 0) {
    return didEnrichIncident ? { ...classification, incidents: enrichedIncidents } : classification;
  }

  const addedIncidents = missingSpecs.map((spec, index) =>
    buildIncident(spec, enrichedIncidents.length + index)
  );
  const allIncidents = [...enrichedIncidents, ...addedIncidents];
  const highestSeverity = allIncidents.reduce(
    (severity, incident) => maxSeverity(severity, incident.severity),
    classification.overall_severity
  );
  const coveredFindings = new Set(
    classification.findings
      .map((finding, index) => ({
        index,
        text: [finding.title, finding.classification, ...finding.affected_services, ...finding.evidence]
          .join(' ')
          .toLowerCase(),
      }))
      .filter(({ text }) => missingSpecs.some((spec) => findingCoversSpec(text, spec)))
      .map(({ index }) => index)
  );

  return {
    ...classification,
    summary:
      classification.incidents.length === 0
        ? `Mandatory incident signals detected: ${addedIncidents.map((incident) => incident.title).join('; ')}.`
        : classification.summary,
    overall_severity: highestSeverity,
    incidents: allIncidents,
    findings: classification.findings.filter((_, index) => !coveredFindings.has(index)),
  };
}
