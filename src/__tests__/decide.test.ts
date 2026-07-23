import { describe, expect, it } from 'vitest';
import { decide, run } from '../stages/decide.js';
import type { Investigation, InvestigationResult, StageInput } from '../types.js';

function investigation(overrides: Partial<Investigation> = {}): Investigation {
  return {
    incident_id: 'INC-001',
    title: 'Auth task health alarm',
    original_classification: 'UNKNOWN',
    investigation_status: 'POSSIBLE_INCIDENT',
    severity: 'HIGH',
    confidence: 0.9,
    affected_services: ['auth-service'],
    confirmed_facts: ['Alarm entered ALARM at 2026-06-17T11:52:55Z.'],
    supporting_evidence: ['Service returned to steady state after deployment.'],
    contradicting_evidence: ['Auth logs showed successful requests.'],
    likely_causes: [
      {
        cause: 'Transient task-health degradation during deployment.',
        confidence: 0.66,
        evidence: ['Deployment overlapped the alarm transition.'],
      },
    ],
    unknowns: ['Client-visible impact is unproven.'],
    additional_data_needed: [
      {
        data: 'ALB request outcome breakdown',
        reason: 'Application logs may miss target failures.',
        suggested_query_or_source: 'Query auth ALB access logs by status code.',
      },
    ],
    unresolved_evidence_requirements: [
      {
        type: 'FIRST_BAD_LOG_TIMESTAMP',
        description: 'Check first client-visible auth failure, if any.',
        tool_hint: 'Use ALB access logs for the alarm window.',
      },
    ],
    recommended_next_investigation_steps: [
      {
        priority: 1,
        action: 'Check whether the task-health alarm is currently OK.',
        expected_signal: 'Confirms whether this is still active.',
      },
    ],
    requires_more_evidence_before_mitigation: true,
    possible_future_remediation: [],
    ...overrides,
  };
}

function result(investigations: Investigation[]): InvestigationResult {
  return {
    summary: 'investigated',
    overall_assessment: 'POSSIBLE_INCIDENT',
    overall_severity: 'HIGH',
    investigations,
    cross_cutting_observations: [],
    priority_order: [],
  };
}

describe('Decide stage', () => {
  it('routes possible transient incidents to Verify instead of Mitigate', () => {
    const decision = decide(result([investigation()]));

    expect(decision.overall_next_stage).toBe('Verify');
    expect(decision.decisions[0]?.disposition).toBe('VERIFY');
    expect(decision.decisions[0]?.follow_up_actions.join(' ')).toContain('ALB access logs');
    expect(decision.decisions[0]?.evidence_to_pass.join(' ')).toContain('steady state');
  });

  it('routes confirmed incidents with root cause evidence to Mitigate', () => {
    const decision = decide(
      result([
        investigation({
          investigation_status: 'CONFIRMED_INCIDENT',
          requires_more_evidence_before_mitigation: false,
          unresolved_evidence_requirements: [],
          additional_data_needed: [],
        }),
      ])
    );

    expect(decision.overall_next_stage).toBe('Mitigate');
    expect(decision.decisions[0]?.disposition).toBe('MITIGATE');
  });

  it('still proposes a mitigation for a confirmed incident that wants more evidence', () => {
    // The gap becomes a label on the proposal, not a reason to withhold it — otherwise the
    // Mitigate gate never opens (no production incident ever cleared the old both-conditions bar).
    const decision = decide(
      result([
        investigation({
          investigation_status: 'CONFIRMED_INCIDENT',
          requires_more_evidence_before_mitigation: true,
        }),
      ])
    );

    expect(decision.overall_next_stage).toBe('Mitigate');
    expect(decision.decisions[0]?.disposition).toBe('MITIGATE');
  });

  it('proposes a mitigation for a possible incident when mitigation_confidence is high', () => {
    const decision = decide(
      result([
        investigation({
          investigation_status: 'POSSIBLE_INCIDENT',
          mitigation_confidence: 'high',
        }),
      ])
    );

    expect(decision.decisions[0]?.disposition).toBe('MITIGATE');
    expect(decision.decisions[0]?.rationale).toContain('mitigation_confidence=high');
  });

  it('does not propose a mitigation for a possible incident with only medium confidence', () => {
    const decision = decide(
      result([
        investigation({
          investigation_status: 'POSSIBLE_INCIDENT',
          mitigation_confidence: 'medium',
        }),
      ])
    );

    expect(decision.decisions[0]?.disposition).not.toBe('MITIGATE');
  });

  it('routes observability gaps to follow-up work without response stages', () => {
    const decision = decide(
      result([
        investigation({
          investigation_status: 'OBSERVABILITY_GAP',
          severity: 'LOW',
        }),
      ])
    );

    expect(decision.overall_next_stage).toBe('None');
    expect(decision.decisions[0]?.disposition).toBe('OPEN_OBSERVABILITY_FOLLOWUP');
  });

  it('returns a StageResult for orchestrator handoff', async () => {
    const input: StageInput = { stage: 'Decide', timestamp: '2026-06-17T12:00:00Z' };

    const stageResult = await run(input, result([]));

    expect(stageResult.stage).toBe('Decide');
    expect(stageResult.status).toBe('success');
    expect(stageResult.timestamp).toBe(input.timestamp);
  });
});
