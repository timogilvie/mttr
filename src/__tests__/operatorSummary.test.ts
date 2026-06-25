import { describe, expect, it } from 'vitest';
import { renderOperatorSummary } from '../report/operatorSummary.js';
import type { DecisionResult, InvestigationResult } from '../types.js';

describe('operator summary', () => {
  it('renders an operator-first summary for the auth-timeout 503 incident', () => {
    const investigation: InvestigationResult = {
      summary: 'Investigation found one confirmed customer-facing incident.',
      overall_assessment: 'ACTIVE_INCIDENT',
      overall_severity: 'CRITICAL',
      investigations: [
        {
          incident_id: 'auth-alarm',
          title: 'Active alarm for auth-service: hokusai-auth-development-task-health',
          original_classification: 'UNKNOWN',
          investigation_status: 'POSSIBLE_INCIDENT',
          severity: 'HIGH',
          confidence: 0.95,
          affected_services: ['auth-service'],
          confirmed_facts: [
            'HealthyTaskCount had no datapoints across the queried lookback.',
            'The task-health alarm treats missing data as breaching.',
          ],
          supporting_evidence: [
            'Auth-service logs show substantial bad-event bursts during the downstream timeout window.',
          ],
          contradicting_evidence: ['ECS service status remained ACTIVE with running=1.'],
          semantics: {
            customer_impact: 'POSSIBLE_CUSTOMER_IMPACT',
            evidence_role: 'UPSTREAM_SUSPECT',
            currentness: 'ACTIVE',
            duplicate_of: null,
            root_incident_id: null,
            upstream_incident_ids: [],
            downstream_incident_ids: ['data-503'],
            observability_reliability: 'UNRELIABLE',
            observability_notes: [
              'The task-health alarm is driven by missing HealthyTaskCount telemetry.',
            ],
          },
          likely_causes: [
            {
              cause: 'Auth-service degradation caused dependency calls to time out.',
              confidence: 0.72,
              evidence: ['Auth bad-event bursts overlap the data-pipeline-api 503 window.'],
            },
          ],
          unknowns: ['The exact auth-side trigger remains unresolved.'],
          additional_data_needed: [],
          unresolved_evidence_requirements: [],
          recommended_next_investigation_steps: [
            {
              priority: 1,
              action: 'Inspect detailed auth-service logs from 2026-06-24T20:20Z..21:05Z.',
              expected_signal: 'Specific auth-side dependency or resource bottleneck.',
            },
          ],
          requires_more_evidence_before_mitigation: true,
          possible_future_remediation: [],
        },
        {
          incident_id: 'data-503',
          title: 'ALB 5xx responses for data-pipeline-api',
          original_classification: 'APPLICATION_ERROR',
          investigation_status: 'CONFIRMED_INCIDENT',
          severity: 'HIGH',
          confidence: 0.97,
          affected_services: ['data-pipeline-api'],
          confirmed_facts: [
            'ALB access logs found 11 target-generated 503 requests on two MLflow endpoints.',
          ],
          supporting_evidence: [
            'Application logs show "Auth service request timed out" immediately before each 503 response.',
            'HTTPCode_ELB_5XX_Count had no datapoints, so the load balancer did not generate the 5xxs.',
          ],
          contradicting_evidence: [
            'ECS showed data-pipeline-api remained desired=1 running=1 with no stopped tasks and no overlapping deployment.',
          ],
          semantics: {
            customer_impact: 'CONFIRMED_CUSTOMER_IMPACT',
            evidence_role: 'PRIMARY_INCIDENT',
            currentness: 'RECOVERED_TRANSIENT',
            duplicate_of: null,
            root_incident_id: 'data-503',
            upstream_incident_ids: ['auth-alarm'],
            downstream_incident_ids: [],
            observability_reliability: 'TRUSTED',
            observability_notes: [],
          },
          likely_causes: [
            {
              cause: 'data-pipeline-api returned 503 because auth service calls timed out.',
              confidence: 0.97,
              evidence: ['Auth timeout logs precede each 503.'],
            },
          ],
          unknowns: ['The exact auth-side trigger remains unresolved.'],
          additional_data_needed: [],
          unresolved_evidence_requirements: [],
          recommended_next_investigation_steps: [
            {
              priority: 1,
              action: 'Inspect detailed auth-service logs from 2026-06-24T20:20Z..21:05Z.',
              expected_signal: 'Specific auth-side dependency or resource bottleneck.',
            },
          ],
          requires_more_evidence_before_mitigation: true,
          possible_future_remediation: [],
        },
      ],
      cross_cutting_observations: [],
      priority_order: [],
    };

    const decision: DecisionResult = {
      summary: 'Decision selected Investigate.',
      overall_next_stage: 'Investigate',
      decisions: [
        {
          incident_id: 'data-503',
          title: 'ALB 5xx responses for data-pipeline-api',
          severity: 'HIGH',
          affected_services: ['data-pipeline-api'],
          disposition: 'CONTINUE_INVESTIGATION',
          next_stage: 'Investigate',
          rationale: 'Root-cause closure gate blocked mitigation.',
          evidence_to_pass: [],
          follow_up_actions: [
            'Inspect detailed auth-service log messages during 2026-06-24T20:20Z..21:05Z.',
          ],
        },
      ],
      handoff_notes: [],
    };

    expect(renderOperatorSummary({ investigation, decision })).toMatchInlineSnapshot(`
      "[Operator Summary]
      Status: ACTIVE_INCIDENT severity CRITICAL.
      Confirmed impact: ALB access logs found 11 target-generated 503 requests on two MLflow endpoints.
      Likely root area: Active alarm for auth-service: hokusai-auth-development-task-health: Auth-service degradation caused dependency calls to time out.
      Ruled out: ECS showed data-pipeline-api remained desired=1 running=1 with no stopped tasks and no overlapping deployment.
      Observability caveat: The task-health alarm is driven by missing HealthyTaskCount telemetry.
      Next action: Inspect detailed auth-service log messages during 2026-06-24T20:20Z..21:05Z."
    `);
  });
});
