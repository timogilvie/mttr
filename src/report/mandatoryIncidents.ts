import type { ClassificationResult, Incident, IncidentClassification, Severity } from '../types.js';

interface MandatoryIncidentSpec {
  key: string;
  title: string;
  classification: IncidentClassification;
  severity: Severity;
  confidence: number;
  affectedService: string;
  evidence: string[];
  alarms?: string[];
  metrics?: string[];
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

function incidentCoversSpec(incident: Incident, spec: MandatoryIncidentSpec): boolean {
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

  const service = spec.affectedService.toLowerCase();
  const signal = [...(spec.alarms ?? []), ...(spec.metrics ?? []), ...spec.evidence]
    .join(' ')
    .toLowerCase();

  return haystack.includes(service) && signal.split(/\s+/).some((token) => token.length > 8 && haystack.includes(token));
}

function findingCoversSpec(findingText: string, spec: MandatoryIncidentSpec): boolean {
  const service = spec.affectedService.toLowerCase();
  const signal = [...(spec.alarms ?? []), ...(spec.metrics ?? []), ...spec.evidence]
    .join(' ')
    .toLowerCase();

  return findingText.includes(service) && signal.split(/\s+/).some((token) => token.length > 8 && findingText.includes(token));
}

function extractActiveAlarmSpecs(report: string): MandatoryIncidentSpec[] {
  return splitServiceSections(report).flatMap(({ service, body }) => {
    const alarms = [...body.matchAll(ALARM_ROW_RE)]
      .map((match) => match[1]?.trim())
      .filter((alarmName): alarmName is string => Boolean(alarmName));

    return alarms.map((alarmName) => ({
      key: `active-alarm-${alarmName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
      title: `Active alarm for ${service}: ${alarmName}`,
      classification: 'UNKNOWN' as const,
      severity: 'HIGH' as const,
      confidence: 0.95,
      affectedService: service,
      evidence: [`Health report lists alarm ${alarmName} in ALARM state for ${service}.`],
      alarms: [alarmName],
      suspectedCauses: ['CloudWatch alarm threshold is currently breached.'],
      firstActions: [`Inspect CloudWatch alarm ${alarmName} history and reason.`],
      questions: [
        'When did the alarm enter ALARM state?',
        'Which underlying metric or event triggered the alarm?',
        'Is the alarm correlated with task health, deploys, errors, or traffic changes?',
      ],
      queries: [`CloudWatch alarm history and metric data for ${alarmName}.`],
      userImpact: 'PARTIAL' as const,
    }));
  });
}

function extractAlb5xxSpecs(report: string): MandatoryIncidentSpec[] {
  return splitServiceSections(report).flatMap(({ service, body }) => {
    const specs: MandatoryIncidentSpec[] = [];

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
    ...extractActiveAlarmSpecs(report),
    ...extractAlb5xxSpecs(report),
    ...extractMissingDetectorSpecs(report),
  ];
}

function maxSeverity(a: Severity, b: Severity): Severity {
  const order: Severity[] = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

export function enforceMandatoryIncidents(
  classification: ClassificationResult,
  report: string
): ClassificationResult {
  const missingSpecs = mandatoryIncidentSpecs(report).filter(
    (spec) => !classification.incidents.some((incident) => incidentCoversSpec(incident, spec))
  );

  if (missingSpecs.length === 0) {
    return classification;
  }

  const addedIncidents = missingSpecs.map((spec, index) =>
    buildIncident(spec, classification.incidents.length + index)
  );
  const allIncidents = [...classification.incidents, ...addedIncidents];
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
