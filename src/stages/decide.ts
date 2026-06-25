import type {
  DecisionNextStage,
  DecisionResult,
  EvidenceCheckPlan,
  IncidentDecision,
  Investigation,
  InvestigationResult,
  StageInput,
  StageResult,
} from '../types.js';
import { resolveServiceResource } from '../tools/serviceResources.js';

const STAGE_PRIORITY: Record<DecisionNextStage, number> = {
  Mitigate: 4,
  Verify: 3,
  Investigate: 2,
  None: 1,
};

function highestNextStage(decisions: IncidentDecision[]): DecisionNextStage {
  return decisions.reduce<DecisionNextStage>((highest, decision) => {
    return STAGE_PRIORITY[decision.next_stage] > STAGE_PRIORITY[highest]
      ? decision.next_stage
      : highest;
  }, 'None');
}

function evidenceToPass(investigation: Investigation): string[] {
  return [
    ...investigation.confirmed_facts,
    ...investigation.supporting_evidence,
    ...investigation.contradicting_evidence.map((evidence) => `Contradicting: ${evidence}`),
  ].slice(0, 12);
}

function uniqueByCheckId(checks: EvidenceCheckPlan[]): EvidenceCheckPlan[] {
  const seen = new Set<string>();
  const unique: EvidenceCheckPlan[] = [];
  for (const check of checks) {
    if (!seen.has(check.check_id)) {
      seen.add(check.check_id);
      unique.push(check);
    }
  }
  return unique;
}

function investigationText(investigation: Investigation): string {
  return [
    investigation.title,
    investigation.original_classification,
    investigation.investigation_status,
    ...investigation.affected_services,
    ...investigation.confirmed_facts,
    ...investigation.supporting_evidence,
    ...investigation.contradicting_evidence,
    ...investigation.unknowns,
    ...investigation.recommended_next_investigation_steps.map((step) => step.action),
  ].join('\n');
}

function extractAlarmNames(text: string): string[] {
  const names: string[] = [];
  const patterns = [
    /\balarm=([A-Za-z0-9_.:/-]+)/gi,
    /\balarm\s+(?!for\b|state\b)([A-Za-z0-9_.:/-]*alarm[A-Za-z0-9_.:/-]*)/gi,
    /\b([A-Za-z0-9][A-Za-z0-9_.:/-]*-[A-Za-z0-9_.:/-]*alarm[A-Za-z0-9_.:/-]*)\b/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1]?.replace(/[.,;:)]+$/g, '');
      if (candidate && !['alarm', 'state', 'history'].includes(candidate.toLowerCase())) {
        names.push(candidate);
      }
    }
  }

  return [...new Set(names)];
}

function fallbackEvidenceCheckPlan(investigation: Investigation): EvidenceCheckPlan[] {
  const text = investigationText(investigation);
  const lowerText = text.toLowerCase();
  const checks: EvidenceCheckPlan[] = [...(investigation.evidence_check_plan ?? [])];

  for (const alarmName of extractAlarmNames(text)) {
    checks.push({
      check_id: `${investigation.incident_id}:alarm:${alarmName}`,
      incident_id: investigation.incident_id,
      check_type: 'ALARM_STATE',
      tool: 'find_alarms',
      target: alarmName,
      args: { search: alarmName },
      expected_signal: `Current state and missing-data handling for alarm ${alarmName}.`,
      freshness_window_minutes: 60,
      pass_criteria: 'Alarm is OK or corroborating evidence shows no active service impact.',
      fail_criteria: 'Alarm is ALARM with trusted corroborating service-health evidence.',
    });
  }

  for (const service of investigation.affected_services) {
    const resource = resolveServiceResource(service, text);
    if (lowerText.includes('alarm')) {
      for (const alarmName of resource.alarms) {
        checks.push({
          check_id: `${investigation.incident_id}:alarm:${alarmName}`,
          incident_id: investigation.incident_id,
          check_type: 'ALARM_STATE',
          tool: 'find_alarms',
          target: alarmName,
          args: { search: alarmName },
          expected_signal: `Current state and missing-data handling for alarm ${alarmName}.`,
          freshness_window_minutes: 60,
          pass_criteria: 'Alarm is OK or corroborating evidence shows no active service impact.',
          fail_criteria: 'Alarm is ALARM with trusted corroborating service-health evidence.',
        });
      }
    }

    const ecs = resource.ecsServices[0];
    if (ecs) {
      checks.push({
        check_id: `${investigation.incident_id}:ecs:${ecs.cluster ?? 'any'}:${ecs.serviceName}`,
        incident_id: investigation.incident_id,
        check_type: 'ECS_SERVICE_HEALTH',
        tool: 'get_ecs_service_events',
        target: ecs.serviceName,
        args: { service_name: ecs.serviceName, cluster: ecs.cluster, lookback_minutes: 60 },
        expected_signal: `Current ECS health for ${ecs.serviceName}.`,
        freshness_window_minutes: 60,
        pass_criteria: 'Service is ACTIVE with desired tasks running and no fresh failure evidence.',
        fail_criteria: 'Service has zero running tasks, failed rollout, or recent stopped tasks.',
      });
    } else {
      checks.push({
        check_id: `${investigation.incident_id}:resource-lookup:${service}`,
        incident_id: investigation.incident_id,
        check_type: 'RESOURCE_LOOKUP',
        tool: 'discover_log_groups',
        target: service,
        args: { service_name: service, limit: 5 },
        expected_signal: `Resolve exact resources for ${service}.`,
        freshness_window_minutes: 60,
        pass_criteria: 'Exact service resources are found before service-health checks run.',
        fail_criteria: 'Only generic service labels are available.',
      });
    }

    if (lowerText.includes('5xx') || lowerText.includes('503')) {
      const alb = resource.albs[0];
      if (alb) {
        checks.push({
          check_id: `${investigation.incident_id}:alb:${alb.loadBalancer}`,
          incident_id: investigation.incident_id,
          check_type: 'ALB_ACCESS_LOGS',
          tool: 'query_alb_access_logs',
          target: alb.loadBalancer,
          args: {
            load_balancer: alb.loadBalancer,
            status_class: '5xx',
            lookback_minutes: 60,
            sample_limit: 5,
          },
          expected_signal: `Recent ALB 5xx access-log evidence for ${alb.loadBalancer}.`,
          freshness_window_minutes: 60,
          pass_criteria: 'No recent matching 5xx requests in the verification window.',
          fail_criteria: 'Recent matching target or ELB 5xx requests are present.',
        });
      }
    }

    if (lowerText.includes('log') || lowerText.includes('warning') || lowerText.includes('timeout')) {
      const logGroup = resource.logGroups[0];
      if (logGroup) {
        checks.push({
          check_id: `${investigation.incident_id}:logs:${logGroup}`,
          incident_id: investigation.incident_id,
          check_type: 'LOG_QUERY',
          tool: 'query_logs',
          target: logGroup,
          args: {
            log_group: logGroup,
            filter_or_query:
              'fields @timestamp, @message, @logStream | filter @message like /(?i)(error|exception|timeout|warning|failed)/ | sort @timestamp desc | limit 25',
            lookback_minutes: 60,
            limit: 25,
          },
          expected_signal: `Recent failure, timeout, or warning logs from ${logGroup}.`,
          freshness_window_minutes: 60,
          pass_criteria: 'No recent matching bad-event logs.',
          fail_criteria: 'Recent timeout/error/warning burst is still present.',
        });
      }
    }

    for (const metric of resource.healthMetrics) {
      if (
        lowerText.includes(metric.metric_name.toLowerCase()) ||
        lowerText.includes('missing datapoint') ||
        lowerText.includes('no datapoint')
      ) {
        checks.push({
          check_id: `${investigation.incident_id}:metric:${metric.namespace}:${metric.metric_name}`,
          incident_id: investigation.incident_id,
          check_type: 'METRIC_DATA',
          tool: 'get_metrics_and_alarms',
          target: `${metric.namespace}/${metric.metric_name}`,
          args: {
            namespace: metric.namespace,
            metric_name: metric.metric_name,
            dimensions: metric.dimensions,
            stat: metric.stat,
            lookback_minutes: 60,
          },
          expected_signal: `Recent datapoints for ${metric.namespace}/${metric.metric_name}.`,
          freshness_window_minutes: 60,
          pass_criteria: 'Recent datapoints exist and corroborate healthy service state.',
          fail_criteria: 'Metric is absent or breaching and corroborated by service-health evidence.',
        });
      }
    }
  }

  return uniqueByCheckId(checks);
}

function unresolvedActions(investigation: Investigation): string[] {
  return [
    ...investigation.unresolved_evidence_requirements.map(
      (requirement) => `${requirement.description} ${requirement.tool_hint}`.trim()
    ),
    ...investigation.additional_data_needed.map(
      (request) => `${request.data}: ${request.suggested_query_or_source}`
    ),
    ...investigation.recommended_next_investigation_steps.map((step) => step.action),
  ];
}

function isTransientCandidate(investigation: Investigation): boolean {
  const text = [
    ...investigation.supporting_evidence,
    ...investigation.likely_causes.map((cause) => cause.cause),
    ...investigation.confirmed_facts,
  ]
    .join(' ')
    .toLowerCase();

  return (
    text.includes('transient') ||
    text.includes('recovered') ||
    text.includes('steady state') ||
    text.includes('deployment') ||
    text.includes('rollout')
  );
}

function decideInvestigation(investigation: Investigation): IncidentDecision {
  const actions = unresolvedActions(investigation);
  const base = {
    incident_id: investigation.incident_id,
    title: investigation.title,
    severity: investigation.severity,
    affected_services: investigation.affected_services,
    evidence_to_pass: evidenceToPass(investigation),
    evidence_check_plan: fallbackEvidenceCheckPlan(investigation),
  };

  if (
    investigation.investigation_status === 'CONFIRMED_INCIDENT' &&
    !investigation.requires_more_evidence_before_mitigation
  ) {
    return {
      ...base,
      disposition: 'MITIGATE',
      next_stage: 'Mitigate',
      rationale: 'Confirmed incident with enough root-cause evidence to choose a mitigation.',
      follow_up_actions: actions,
    };
  }

  if (investigation.investigation_status === 'CONFIRMED_INCIDENT') {
    return {
      ...base,
      disposition: 'CONTINUE_INVESTIGATION',
      next_stage: 'Investigate',
      rationale: 'Incident is confirmed, but root-cause evidence is not sufficient for mitigation.',
      follow_up_actions: actions,
    };
  }

  if (investigation.investigation_status === 'OBSERVABILITY_GAP') {
    return {
      ...base,
      disposition: 'OPEN_OBSERVABILITY_FOLLOWUP',
      next_stage: 'None',
      rationale: 'Evidence points to an observability gap rather than a remediable service issue.',
      follow_up_actions: actions,
    };
  }

  if (investigation.investigation_status === 'LIKELY_NON_INCIDENT') {
    return {
      ...base,
      disposition: 'CLOSE_NON_INCIDENT',
      next_stage: 'None',
      rationale: 'Investigation downgraded this item and found no actionable incident.',
      follow_up_actions: actions,
    };
  }

  if (investigation.investigation_status === 'INSUFFICIENT_EVIDENCE') {
    return {
      ...base,
      disposition: 'CONTINUE_INVESTIGATION',
      next_stage: 'Investigate',
      rationale: 'The investigation did not gather enough evidence to make a response decision.',
      follow_up_actions: actions,
    };
  }

  if (actions.length > 0 && investigation.unresolved_evidence_requirements.length > 0) {
    return {
      ...base,
      disposition: 'VERIFY',
      next_stage: 'Verify',
      rationale:
        'Possible incident with no confirmed impact; verify current health and requested evidence before mitigation.',
      follow_up_actions: actions,
    };
  }

  if (isTransientCandidate(investigation)) {
    return {
      ...base,
      disposition: 'CLOSE_TRANSIENT',
      next_stage: 'Verify',
      rationale:
        'Evidence suggests a transient event; verify recovery before closing as transient.',
      follow_up_actions: actions,
    };
  }

  return {
    ...base,
    disposition: 'VERIFY',
    next_stage: 'Verify',
    rationale: 'Possible incident without confirmed root cause or user impact; verify before acting.',
    follow_up_actions: actions,
  };
}

export function decide(investigation: InvestigationResult): DecisionResult {
  if (investigation.investigations.length === 0) {
    return {
      summary: 'No investigations require response.',
      overall_next_stage: 'None',
      decisions: [],
      handoff_notes: [],
    };
  }

  const decisions = investigation.investigations.map(decideInvestigation);
  const overallNextStage = highestNextStage(decisions);
  const handoffNotes = decisions
    .filter((decision) => decision.next_stage === overallNextStage)
    .map((decision) => `${decision.incident_id}: ${decision.rationale}`);

  return {
    summary: `Decision stage selected ${overallNextStage} for ${decisions.length} investigation(s).`,
    overall_next_stage: overallNextStage,
    decisions,
    handoff_notes: handoffNotes,
  };
}

export async function run(input: StageInput, investigation: InvestigationResult): Promise<StageResult> {
  return {
    stage: 'Decide',
    status: 'success',
    timestamp: input.timestamp,
    data: decide(investigation),
  };
}
