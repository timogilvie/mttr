import type {
  DecisionResult,
  IncidentDecision,
  MitigationHandoff,
  MitigationResult,
  StageInput,
  StageResult,
} from '../types.js';

function mitigationCandidates(decision: DecisionResult | undefined): IncidentDecision[] {
  return (
    decision?.decisions.filter(
      (candidate) => candidate.disposition === 'MITIGATE' || candidate.next_stage === 'Mitigate'
    ) ?? []
  );
}

function proposedActions(decision: IncidentDecision): string[] {
  if (decision.follow_up_actions.length > 0) {
    return decision.follow_up_actions.map((action) => `Operator action: ${action}`);
  }

  const text = [...decision.evidence_to_pass, decision.rationale, decision.title].join('\n').toLowerCase();

  if (text.includes('deployment') || text.includes('rollback')) {
    return [
      'Operator action: prepare a rollback or revert for the implicated deployment after confirming current impact.',
    ];
  }

  if (text.includes('cpu') || text.includes('memory') || text.includes('capacity')) {
    return [
      'Operator action: prepare a reversible capacity increase for the affected service after confirming saturation is current.',
    ];
  }

  if (text.includes('configuration') || text.includes('config')) {
    return [
      'Operator action: prepare a revert for the implicated configuration change after confirming ownership and blast radius.',
    ];
  }

  return [
    'Operator action: choose the lowest-risk reversible mitigation for the confirmed root cause and affected service.',
  ];
}

function guardrails(decision: IncidentDecision): string[] {
  return [
    'Do not execute remediation solely from this agent output; an operator must confirm the action and blast radius.',
    'Confirm the incident is still active or still needs customer-impact remediation before changing production state.',
    'Prefer reversible mitigations and capture before/after evidence for the same checks used to justify mitigation.',
    `Scope changes to affected services: ${decision.affected_services.join(', ') || 'unknown'}.`,
  ];
}

function verificationChecks(decision: IncidentDecision): string[] {
  const checks = decision.evidence_check_plan ?? [];
  if (checks.length > 0) {
    return checks
      .slice(0, 6)
      .map(
        (check) =>
          `${check.tool} on ${check.target}: ${check.pass_criteria || check.expected_signal}`
      );
  }

  return decision.evidence_to_pass
    .filter((evidence) => /\b(alarm|metric|log|5xx|503|health|task|latency)\b/i.test(evidence))
    .slice(0, 4);
}

function buildHandoff(decision: IncidentDecision): MitigationHandoff {
  return {
    incident_id: decision.incident_id,
    title: decision.title,
    severity: decision.severity,
    affected_services: decision.affected_services,
    rationale: decision.rationale,
    manual_confirmation_required: true,
    evidence_to_review: decision.evidence_to_pass.slice(0, 12),
    proposed_actions: proposedActions(decision),
    guardrails: guardrails(decision),
    verification_checks: verificationChecks(decision),
  };
}

export function buildMitigationResult(decision?: DecisionResult): MitigationResult {
  const handoffs = mitigationCandidates(decision).map(buildHandoff);
  if (handoffs.length === 0) {
    return {
      summary: 'Mitigate stage found no decisions approved for mitigation.',
      overall_status: 'NO_MITIGATION_CANDIDATES',
      handoffs: [],
    };
  }

  return {
    summary: `Mitigate stage prepared ${handoffs.length} manual mitigation handoff(s).`,
    overall_status: 'READY_FOR_MANUAL_MITIGATION',
    handoffs,
  };
}

export async function mitigateStage(
  _input: StageInput,
  decision?: DecisionResult
): Promise<StageResult> {
  return {
    stage: 'Mitigate',
    status: 'success',
    timestamp: new Date().toISOString(),
    data: buildMitigationResult(decision),
  };
}

export async function restoreStage(
  _input: StageInput,
  _decision?: DecisionResult
): Promise<StageResult> {
  return {
    stage: 'Restore',
    status: 'not_implemented',
    timestamp: new Date().toISOString(),
    data: { message: 'Restore stage is not implemented.' },
  };
}
