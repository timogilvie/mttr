import { describe, it, expect } from 'vitest';
import { buildMitigationResult, mitigateStage, restoreStage } from '../stages/stubs.js';
import type { DecisionResult, MitigationResult, StageInput } from '../types.js';

const mockInput: StageInput = {
  stage: 'Mitigate',
  timestamp: '2026-06-06T12:00:00Z',
};

describe('stage stubs', () => {
  it('Mitigate returns a no-candidate success when no decision is approved', async () => {
    const result = await mitigateStage(mockInput);

    expect(result.stage).toBe('Mitigate');
    expect(result.status).toBe('success');
    expect((result.data as MitigationResult).overall_status).toBe('NO_MITIGATION_CANDIDATES');
  });

  it('builds a manual mitigation handoff for approved mitigation decisions', () => {
    const decision: DecisionResult = {
      summary: 'Decision selected Mitigate.',
      overall_next_stage: 'Mitigate',
      decisions: [
        {
          incident_id: 'INC-DEPLOY',
          title: 'Deployment regression caused API 503s',
          disposition: 'MITIGATE',
          next_stage: 'Mitigate',
          severity: 'HIGH',
          affected_services: ['data-pipeline-api'],
          rationale: 'Confirmed incident with enough root-cause evidence to choose a mitigation.',
          evidence_to_pass: [
            'Customer 5xx impact was confirmed.',
            'Deployment config change triggered all observed 503s.',
          ],
          evidence_check_plan: [
            {
              check_id: 'INC-DEPLOY:alb',
              incident_id: 'INC-DEPLOY',
              check_type: 'ALB_ACCESS_LOGS',
              tool: 'query_alb_access_logs',
              target: 'app/hokusai-registry-development/78840d73e3e9652e',
              args: { load_balancer: 'app/hokusai-registry-development/78840d73e3e9652e' },
              expected_signal: 'No fresh 503s after mitigation.',
              pass_criteria: 'No target-generated 5xxs remain.',
              fail_criteria: 'Fresh target-generated 5xxs continue.',
            },
          ],
          follow_up_actions: [],
        },
      ],
      handoff_notes: [],
    };

    const result = buildMitigationResult(decision);

    expect(result.overall_status).toBe('READY_FOR_MANUAL_MITIGATION');
    expect(result.handoffs).toEqual([
      expect.objectContaining({
        incident_id: 'INC-DEPLOY',
        manual_confirmation_required: true,
        proposed_actions: [
          'Operator action: prepare a rollback or revert for the implicated deployment after confirming current impact.',
        ],
        verification_checks: [
          'query_alb_access_logs on app/hokusai-registry-development/78840d73e3e9652e: No target-generated 5xxs remain.',
        ],
      }),
    ]);
    expect(result.handoffs[0]?.guardrails.join(' ')).toContain('Do not execute remediation');
  });

  it('Restore returns not_implemented', async () => {
    const result = await restoreStage(mockInput);

    expect(result.stage).toBe('Restore');
    expect(result.status).toBe('not_implemented');
  });

});
