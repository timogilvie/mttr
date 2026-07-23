import { describe, expect, it } from 'vitest';
import { mitigate, run } from '../stages/mitigate.js';
import type {
  DecisionResult,
  IncidentDecision,
  Investigation,
  InvestigationResult,
  StageInput,
} from '../types.js';

function investigation(overrides: Partial<Investigation> = {}): Investigation {
  return {
    incident_id: 'INC-1',
    title: 'High detector errors in deltaone-anomaly-detection',
    original_classification: 'AUTH_FAILURE',
    investigation_status: 'CONFIRMED_INCIDENT',
    severity: 'HIGH',
    confidence: 0.9,
    affected_services: ['deltaone-anomaly-detection'],
    confirmed_facts: ['670 detector errors reported.'],
    supporting_evidence: ['659 repeated 403 errors then 26 401 errors.'],
    contradicting_evidence: [],
    likely_causes: [
      {
        cause: 'Transient downstream auth failure on the detector RPC call path.',
        confidence: 0.86,
        evidence: [
          'Earliest failure at 2026-07-13T10:00:01Z in _rpc_call on /aws/lambda/hokusai-deltaone-anomaly-detector-development.',
        ],
      },
    ],
    unknowns: [],
    additional_data_needed: [],
    unresolved_evidence_requirements: [
      {
        type: 'LAMBDA_FAILURE_SUMMARY',
        description: 'Need the remote host or credential source.',
        tool_hint: 'query_logs on /aws/lambda/hokusai-deltaone-anomaly-detector-development',
      },
    ],
    recommended_next_investigation_steps: [],
    requires_more_evidence_before_mitigation: false,
    possible_future_remediation: [],
    mitigation_confidence: 'high',
    ...overrides,
  };
}

function decision(overrides: Partial<IncidentDecision> = {}): IncidentDecision {
  return {
    incident_id: 'INC-1',
    title: 'High detector errors in deltaone-anomaly-detection',
    disposition: 'MITIGATE',
    next_stage: 'Mitigate',
    severity: 'HIGH',
    affected_services: ['deltaone-anomaly-detection'],
    rationale: 'Confirmed.',
    evidence_to_pass: ['alarm=hokusai-deltaone-detector-errors-development'],
    follow_up_actions: [],
    ...overrides,
  };
}

function decisionResult(decisions: IncidentDecision[]): DecisionResult {
  return {
    summary: 'decided',
    overall_next_stage: 'Mitigate',
    decisions,
    handoff_notes: [],
  };
}

function investigationResult(investigations: Investigation[]): InvestigationResult {
  return {
    summary: 'investigated',
    overall_assessment: 'ACTIVE_INCIDENT',
    overall_severity: 'HIGH',
    investigations,
    cross_cutting_observations: [],
    priority_order: [],
  };
}

describe('Mitigate stage', () => {
  it('builds a human-approval proposal from the top likely cause', () => {
    const result = mitigate(
      decisionResult([decision()]),
      investigationResult([investigation()])
    );

    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0]!;
    expect(proposal.requires_human_approval).toBe(true);
    expect(proposal.addresses_cause).toContain('downstream auth failure');
    expect(proposal.cause_confidence).toBe(0.86);
  });

  it('classifies an auth-failure incident as a credential rotation on the named Lambda', () => {
    const proposal = mitigate(
      decisionResult([decision()]),
      investigationResult([investigation()])
    ).proposals[0]!;

    expect(proposal.action_kind).toBe('credential_rotation');
    expect(proposal.target).toMatchObject({
      kind: 'lambda_function',
      identifier: 'hokusai-deltaone-anomaly-detector-development',
    });
  });

  it('prefers a rollback when the investigation correlates a deploy', () => {
    const proposal = mitigate(
      decisionResult([decision()]),
      investigationResult([
        investigation({
          original_classification: 'DEPLOYMENT_REGRESSION',
          causal_evidence: {
            performed: true,
            change_correlation: [
              { type: 'deploy', timestamp: '2026-07-13T09:55:00Z', description: 'release 1.4.0' },
            ],
            resource_saturation: [],
            dependency_health: [],
            found: [],
            missing: [],
            next_highest_value_query: '',
          },
        }),
      ])
    ).proposals[0]!;

    expect(proposal.action_kind).toBe('rollback');
    expect(proposal.reversibility).toBe('manual');
    expect(proposal.rollback_plan.join(' ')).toContain('release');
  });

  it('carries evidence gaps onto the proposal rather than suppressing it', () => {
    const proposal = mitigate(
      decisionResult([decision()]),
      investigationResult([investigation({ requires_more_evidence_before_mitigation: true })])
    ).proposals[0]!;

    expect(proposal.evidence_gaps.join(' ')).toContain('remote host or credential source');
    expect(proposal.preconditions.join(' ')).toContain('more evidence');
  });

  it('names the alarm and service checks that would confirm success', () => {
    const proposal = mitigate(
      decisionResult([decision()]),
      investigationResult([investigation()])
    ).proposals[0]!;

    expect(proposal.success_signal.checks).toEqual(
      expect.arrayContaining([
        { tool: 'find_alarms', target: 'hokusai-deltaone-detector-errors-development' },
        { tool: 'get_ecs_service_events', target: 'deltaone-anomaly-detection' },
      ])
    );
  });

  it('flags an unresolvable target as a precondition instead of guessing', () => {
    const proposal = mitigate(
      decisionResult([decision({ evidence_to_pass: [] })]),
      investigationResult([
        investigation({
          confirmed_facts: ['Errors observed.'],
          supporting_evidence: [],
          likely_causes: [{ cause: 'Something broke.', confidence: 0.9, evidence: [] }],
          original_classification: 'APPLICATION_ERROR',
        }),
      ])
    ).proposals[0]!;

    expect(proposal.target.kind).toBe('unknown');
    expect(proposal.preconditions.join(' ')).toContain('Identify the concrete runtime resource');
  });

  it('recommends no action for a downgraded non-incident', () => {
    const proposal = mitigate(
      decisionResult([decision()]),
      investigationResult([
        investigation({ investigation_status: 'LIKELY_NON_INCIDENT', likely_causes: [] }),
      ])
    ).proposals[0]!;

    expect(proposal.action_kind).toBe('no_action');
    expect(proposal.reversibility).toBe('trivial');
  });

  it('scopes proposals to the given incident ids for the post-Verify path', () => {
    const result = mitigate(
      decisionResult([
        decision(),
        decision({ incident_id: 'INC-2', title: 'Other', next_stage: 'Verify' }),
      ]),
      investigationResult([investigation(), investigation({ incident_id: 'INC-2' })]),
      { incidentIds: ['INC-2'] }
    );

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.incident_id).toBe('INC-2');
  });

  it('skips an incident with no matching investigation rather than inventing one', () => {
    const result = mitigate(
      decisionResult([decision({ incident_id: 'INC-missing' })]),
      investigationResult([investigation()])
    );

    expect(result.proposals).toHaveLength(0);
  });

  it('prefers the investigation possible_future_remediation prose for the action text', () => {
    const proposal = mitigate(
      decisionResult([decision()]),
      investigationResult([
        investigation({
          possible_future_remediation: ['Rotate the deltaone RPC API key and redeploy.'],
        }),
      ])
    ).proposals[0]!;

    expect(proposal.action).toBe('Rotate the deltaone RPC API key and redeploy.');
  });

  it('returns a StageResult for orchestrator handoff', async () => {
    const input: StageInput = { stage: 'Mitigate', timestamp: '2026-07-23T12:00:00Z' };
    const stageResult = await run(
      input,
      decisionResult([decision()]),
      investigationResult([investigation()])
    );

    expect(stageResult.stage).toBe('Mitigate');
    expect(stageResult.status).toBe('success');
    expect(stageResult.timestamp).toBe(input.timestamp);
  });
});
