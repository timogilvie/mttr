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
    expect(decision.decisions[0]?.evidence_check_plan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check_type: 'ALARM_STATE',
          tool: 'find_alarms',
          target: 'hokusai-auth-development-task-health',
        }),
        expect.objectContaining({
          check_type: 'ECS_SERVICE_HEALTH',
          tool: 'get_ecs_service_events',
          target: 'hokusai-auth-development',
        }),
      ])
    );
    expect(decision.decisions[0]?.evidence_check_plan?.map((check) => check.target)).not.toContain('at');
  });

  it('builds exact ALB and log checks for data-pipeline-api 503 investigations', () => {
    const decision = decide(
      result([
        investigation({
          incident_id: 'INC-503',
          title: 'ALB 5xx responses for data-pipeline-api',
          investigation_status: 'CONFIRMED_INCIDENT',
          affected_services: ['data-pipeline-api'],
          confirmed_facts: ['Application logs show auth service request timed out before 503 responses.'],
          supporting_evidence: ['ALB access logs show 11 target-generated 503 responses.'],
        }),
      ])
    );

    expect(decision.decisions[0]?.evidence_check_plan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check_type: 'ALB_ACCESS_LOGS',
          tool: 'query_alb_access_logs',
          target: 'app/hokusai-registry-development/78840d73e3e9652e',
        }),
        expect.objectContaining({
          check_type: 'LOG_QUERY',
          tool: 'query_logs',
          target: '/ecs/hokusai-api-development',
        }),
      ])
    );
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
