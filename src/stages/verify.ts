import type { Config } from '../config.js';
import type {
  DecisionResult,
  EvidenceCheckPlan,
  IncidentDecision,
  IncidentVerification,
  StageInput,
  StageResult,
  VerificationCheck,
  VerificationResult,
  VerificationStatus,
} from '../types.js';
import { dispatchToolCall } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';

const VERIFY_LOOKBACK_MINUTES = 60;
const MAX_CHECKS_PER_DECISION = 6;

const STATUS_PRIORITY: Record<VerificationStatus, number> = {
  VERIFIED_ACTIVE_INCIDENT: 5,
  STILL_INCONCLUSIVE: 4,
  VERIFIED_OBSERVABILITY_ISSUE: 3,
  VERIFIED_RECOVERED_TRANSIENT: 2,
  VERIFIED_NON_INCIDENT: 1,
};

function buildToolContext(config: Config): ToolContext {
  return {
    region: config.aws.region,
    maxAttempts: config.aws.maxAttempts,
    timeoutMs: config.tools.timeoutMs,
    maxResultChars: config.tools.resultMaxChars,
    defaultLookbackMinutes: Math.min(VERIFY_LOOKBACK_MINUTES, config.tools.maxLookbackMinutes),
    maxLookbackMinutes: config.tools.maxLookbackMinutes,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))];
}

export function extractAlarmNames(decision: IncidentDecision): string[] {
  const text = [decision.title, ...decision.evidence_to_pass, ...decision.follow_up_actions].join('\n');
  const names: string[] = [];
  const patterns = [
    /\balarm=([A-Za-z0-9_.:/-]+)/gi,
    /\balarm\s+(?!for\b|state\b)([A-Za-z0-9_.:/-]+)/gi,
    /\bfor\s+([A-Za-z0-9][A-Za-z0-9_.:/-]*alarm[A-Za-z0-9_.:/-]*)/gi,
    /\b([A-Za-z0-9][A-Za-z0-9_.:/-]*-[A-Za-z0-9_.:/-]*alarm[A-Za-z0-9_.:/-]*)\b/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1]?.replace(/[.,;:)]+$/g, '');
      if (candidate && !candidate.toLowerCase().includes('state')) {
        names.push(candidate);
      }
    }
  }

  return unique(names);
}

function wantsAlbCheck(decision: IncidentDecision): boolean {
  const text = [decision.title, decision.rationale, ...decision.evidence_to_pass, ...decision.follow_up_actions]
    .join(' ')
    .toLowerCase();
  return (
    text.includes('alb') ||
    text.includes('load balancer') ||
    text.includes('5xx') ||
    text.includes('client-visible') ||
    text.includes('access log')
  );
}

function classifyAlarmEvidence(evidence: string): VerificationCheck['status'] {
  if (/state=ALARM\b/.test(evidence)) {
    return 'failed';
  }
  if (/state=OK\b/.test(evidence)) {
    return 'passed';
  }
  if (/Error:|No alarms found/i.test(evidence)) {
    return 'inconclusive';
  }
  return 'warning';
}

function classifyEcsEvidence(evidence: string): VerificationCheck['status'] {
  if (/running=0\b|failed=[1-9]\d*\b|rolloutState=FAILED/i.test(evidence)) {
    return 'failed';
  }
  if (/running=[1-9]\d*\b|steady state/i.test(evidence)) {
    return 'passed';
  }
  if (/Error:|No matching ECS services/i.test(evidence)) {
    return 'inconclusive';
  }
  return 'warning';
}

function classifyAlbEvidence(evidence: string): VerificationCheck['status'] {
  if (/Access logging is DISABLED|observability gap/i.test(evidence)) {
    return 'warning';
  }
  if (/\b[1-9]\d* matching the status filter\b/i.test(evidence)) {
    return 'failed';
  }
  if (/0 matching the status filter|No requests matched the status filter/i.test(evidence)) {
    return 'passed';
  }
  if (/Error:|No load balancer found|No access log files found/i.test(evidence)) {
    return 'inconclusive';
  }
  return 'warning';
}

function classifyMetricEvidence(evidence: string): VerificationCheck['status'] {
  if (/No datapoints|no metric datapoints|returned no metric datapoints|0 datapoints/i.test(evidence)) {
    return 'warning';
  }
  if (/Error:|No metrics found|not found/i.test(evidence)) {
    return 'inconclusive';
  }
  if (/state=ALARM\b/i.test(evidence)) {
    return 'failed';
  }
  return 'passed';
}

function classifyLogEvidence(evidence: string): VerificationCheck['status'] {
  if (/Query returned\s+[1-9]\d*\s+row/i.test(evidence)) {
    return 'failed';
  }
  if (/0 matching rows|Query completed with 0 matching rows/i.test(evidence)) {
    return 'passed';
  }
  if (/Error:/i.test(evidence)) {
    return 'inconclusive';
  }
  return 'warning';
}

function classifierForPlan(check: EvidenceCheckPlan): (evidence: string) => VerificationCheck['status'] {
  switch (check.check_type) {
    case 'ALARM_STATE':
      return classifyAlarmEvidence;
    case 'ECS_SERVICE_HEALTH':
      return classifyEcsEvidence;
    case 'ALB_ACCESS_LOGS':
      return classifyAlbEvidence;
    case 'METRIC_DATA':
      return classifyMetricEvidence;
    case 'LOG_QUERY':
      return classifyLogEvidence;
    case 'RESOURCE_LOOKUP':
      return (evidence) => (/Error:|No .*found/i.test(evidence) ? 'inconclusive' : 'passed');
  }
}

async function callTool(
  tool: string,
  target: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  classifier: (evidence: string) => VerificationCheck['status']
): Promise<VerificationCheck> {
  const evidence = await dispatchToolCall(tool, JSON.stringify(args), ctx);
  return {
    tool,
    target,
    status: classifier(evidence),
    evidence,
  };
}

async function buildChecks(
  decision: IncidentDecision,
  ctx: ToolContext
): Promise<VerificationCheck[]> {
  if (decision.evidence_check_plan && decision.evidence_check_plan.length > 0) {
    const plannedChecks: VerificationCheck[] = [];
    for (const check of decision.evidence_check_plan.slice(0, MAX_CHECKS_PER_DECISION)) {
      plannedChecks.push(
        await callTool(check.tool, check.target, check.args, ctx, classifierForPlan(check))
      );
    }
    return plannedChecks;
  }

  const checks: VerificationCheck[] = [];
  const alarmNames = extractAlarmNames(decision);

  for (const alarmName of alarmNames) {
    if (checks.length >= MAX_CHECKS_PER_DECISION) {
      return checks;
    }
    checks.push(
      await callTool(
        'find_alarms',
        alarmName,
        { search: alarmName },
        ctx,
        classifyAlarmEvidence
      )
    );
  }

  for (const service of decision.affected_services) {
    if (checks.length >= MAX_CHECKS_PER_DECISION) {
      return checks;
    }
    checks.push(
      await callTool(
        'get_ecs_service_events',
        service,
        { service_name: service, lookback_minutes: VERIFY_LOOKBACK_MINUTES },
        ctx,
        classifyEcsEvidence
      )
    );
  }

  if (wantsAlbCheck(decision)) {
    for (const service of decision.affected_services) {
      if (checks.length >= MAX_CHECKS_PER_DECISION) {
        return checks;
      }
      checks.push(
        await callTool(
          'query_alb_access_logs',
          service,
          {
            load_balancer: service,
            status_class: 'errors',
            lookback_minutes: VERIFY_LOOKBACK_MINUTES,
            sample_limit: 5,
          },
          ctx,
          classifyAlbEvidence
        )
      );
    }
  }

  return checks;
}

function statusFromChecks(
  decision: IncidentDecision,
  checks: VerificationCheck[]
): { status: VerificationStatus; nextStage: 'Mitigate' | 'None' | 'Investigate'; rationale: string } {
  const hasMetricObservabilityGap = checks.some(
    (check) => check.tool === 'get_metrics_and_alarms' && check.status === 'warning'
  );
  const hasPassingServiceHealth = checks.some(
    (check) => check.tool === 'get_ecs_service_events' && check.status === 'passed'
  );
  if (hasMetricObservabilityGap && hasPassingServiceHealth) {
    return {
      status: 'VERIFIED_OBSERVABILITY_ISSUE',
      nextStage: 'None',
      rationale:
        'Verification found missing or unreliable telemetry while current service-health checks passed.',
    };
  }

  if (checks.some((check) => check.status === 'failed')) {
    return {
      status: 'VERIFIED_ACTIVE_INCIDENT',
      nextStage: 'Mitigate',
      rationale: 'Verification found a current failing health signal.',
    };
  }

  if (checks.some((check) => check.status === 'inconclusive')) {
    return {
      status: 'STILL_INCONCLUSIVE',
      nextStage: 'Investigate',
      rationale: 'Verification could not prove recovery or current impact from available checks.',
    };
  }

  if (checks.some((check) => check.status === 'warning')) {
    return {
      status: 'VERIFIED_OBSERVABILITY_ISSUE',
      nextStage: 'None',
      rationale: 'Verification found an observability gap rather than a current failing service signal.',
    };
  }

  if (decision.disposition === 'CLOSE_NON_INCIDENT') {
    return {
      status: 'VERIFIED_NON_INCIDENT',
      nextStage: 'None',
      rationale: 'Verification found no current failing signal for a downgraded finding.',
    };
  }

  return {
    status: 'VERIFIED_RECOVERED_TRANSIENT',
    nextStage: 'None',
    rationale: 'Verification checks passed; close or downgrade as a recovered transient event.',
  };
}

async function verifyDecision(
  decision: IncidentDecision,
  ctx: ToolContext
): Promise<IncidentVerification> {
  const checks = await buildChecks(decision, ctx);
  const outcome = statusFromChecks(decision, checks);

  return {
    incident_id: decision.incident_id,
    title: decision.title,
    status: outcome.status,
    severity: decision.severity,
    rationale: outcome.rationale,
    checks,
    recommended_next_stage: outcome.nextStage,
  };
}

function overallStatus(verifications: IncidentVerification[]): VerificationStatus {
  return verifications.reduce<VerificationStatus>((highest, verification) => {
    return STATUS_PRIORITY[verification.status] > STATUS_PRIORITY[highest]
      ? verification.status
      : highest;
  }, 'VERIFIED_NON_INCIDENT');
}

function overallNextStage(status: VerificationStatus): 'Mitigate' | 'Investigate' | 'None' {
  if (status === 'VERIFIED_ACTIVE_INCIDENT') {
    return 'Mitigate';
  }
  if (status === 'STILL_INCONCLUSIVE') {
    return 'Investigate';
  }
  return 'None';
}

export async function verify(config: Config, decision: DecisionResult): Promise<VerificationResult> {
  const ctx = buildToolContext(config);
  const candidates = decision.decisions.filter((item) => item.next_stage === 'Verify');
  const verifications = await Promise.all(
    candidates.map((item) => verifyDecision(item, ctx))
  );
  const status = verifications.length === 0 ? 'VERIFIED_NON_INCIDENT' : overallStatus(verifications);
  const nextStage = overallNextStage(status);

  return {
    summary: `Verify stage completed with ${status}; next=${nextStage}.`,
    overall_status: status,
    overall_next_stage: nextStage,
    verifications,
  };
}

export async function run(
  input: StageInput,
  config: Config,
  decision: DecisionResult
): Promise<StageResult> {
  return {
    stage: 'Verify',
    status: 'success',
    timestamp: input.timestamp,
    data: await verify(config, decision),
  };
}
