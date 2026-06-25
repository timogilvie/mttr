import { describe, expect, it } from 'vitest';
import { correlateInvestigations } from '../stages/correlate.js';
import type { Investigation, InvestigationResult } from '../types.js';

function investigation(overrides: Partial<Investigation>): Investigation {
  return {
    incident_id: 'incident-1',
    title: 'Incident',
    original_classification: 'APPLICATION_ERROR',
    investigation_status: 'POSSIBLE_INCIDENT',
    severity: 'LOW',
    confidence: 0.7,
    affected_services: ['data-pipeline-api'],
    confirmed_facts: [],
    supporting_evidence: [],
    contradicting_evidence: [],
    likely_causes: [],
    unknowns: [],
    additional_data_needed: [],
    unresolved_evidence_requirements: [],
    recommended_next_investigation_steps: [],
    requires_more_evidence_before_mitigation: true,
    possible_future_remediation: [],
    ...overrides,
  };
}

function result(investigations: Investigation[]): InvestigationResult {
  return {
    summary: 'Investigation completed.',
    overall_assessment: 'ACTIVE_INCIDENT',
    overall_severity: 'HIGH',
    investigations,
    cross_cutting_observations: [],
    priority_order: investigations.map((item, index) => ({
      rank: index + 1,
      incident_id: item.incident_id,
      title: item.title,
      reason: 'initial order',
    })),
  };
}

describe('correlateInvestigations', () => {
  it('marks duplicate data-pipeline 5xx evidence and links auth-service as upstream suspect', () => {
    const canonical = investigation({
      incident_id: 'mandatory-alb-5xx-data-pipeline-api',
      title: 'ALB 5xx responses for data-pipeline-api',
      investigation_status: 'CONFIRMED_INCIDENT',
      severity: 'HIGH',
      confirmed_facts: [
        'ALB access-log breakdown shows all 11 failures were 503 target-generated responses.',
        'Application logs show "Auth service request timed out" before the 503 responses.',
      ],
      supporting_evidence: ['ALB and app logs agree on endpoint and status code.'],
    });

    const duplicate = investigation({
      incident_id: 'finding-1',
      title: 'Errors in data-pipeline-api',
      investigation_status: 'CONFIRMED_INCIDENT',
      confirmed_facts: ['Errors count: 11 and recent error samples indicate auth service request timeouts.'],
      supporting_evidence: ['This finding is the same underlying issue as the confirmed ALB 5xx incident.'],
    });

    const authUpstream = investigation({
      incident_id: 'finding-0',
      title: 'High number of warnings in auth-service',
      original_classification: 'OBSERVABILITY_FAILURE',
      affected_services: ['auth-service'],
      confirmed_facts: ['Auth-service logs show 1320 bad events during the data-pipeline timeout window.'],
      supporting_evidence: ['Warnings include auth_call_failed and Slow API operation.'],
    });

    const mlflowNoise = investigation({
      incident_id: 'finding-3',
      title: 'Customer 4xx errors in mlflow',
      affected_services: ['mlflow'],
      investigation_status: 'LIKELY_NON_INCIDENT',
      confirmed_facts: ['Only low-volume mixed 400/404 responses were found.'],
    });

    const correlated = correlateInvestigations(result([canonical, duplicate, authUpstream, mlflowNoise]));
    const correlatedCanonical = correlated.investigations.find(
      (item) => item.incident_id === canonical.incident_id
    );
    const correlatedDuplicate = correlated.investigations.find(
      (item) => item.incident_id === duplicate.incident_id
    );
    const correlatedAuth = correlated.investigations.find(
      (item) => item.incident_id === authUpstream.incident_id
    );
    const correlatedMlflow = correlated.investigations.find(
      (item) => item.incident_id === mlflowNoise.incident_id
    );

    expect(correlatedCanonical?.semantics?.customer_impact).toBe('CONFIRMED_CUSTOMER_IMPACT');
    expect(correlatedCanonical?.semantics?.evidence_role).toBe('PRIMARY_INCIDENT');
    expect(correlatedCanonical?.semantics?.upstream_incident_ids).toEqual(['finding-0']);
    expect(correlatedCanonical?.supporting_evidence.join(' ')).toContain('Correlated duplicate evidence from finding-1');
    expect(correlatedCanonical?.supporting_evidence.join(' ')).toContain('Correlated upstream suspect finding-0');

    expect(correlatedDuplicate?.semantics?.evidence_role).toBe('DUPLICATE_EVIDENCE');
    expect(correlatedDuplicate?.semantics?.duplicate_of).toBe(canonical.incident_id);
    expect(correlatedDuplicate?.semantics?.root_incident_id).toBe(canonical.incident_id);

    expect(correlatedAuth?.semantics?.evidence_role).toBe('UPSTREAM_SUSPECT');
    expect(correlatedAuth?.semantics?.downstream_incident_ids).toEqual([canonical.incident_id]);

    expect(correlatedMlflow?.semantics?.evidence_role).toBe('NOISE_OR_NON_INCIDENT');
    expect(correlated.priority_order.map((item) => item.incident_id)).not.toContain('finding-1');
    expect(correlated.cross_cutting_observations[0]).toContain('linked 1 duplicate evidence item');
  });

  it('defaults semantics without changing results when no canonical customer-impact incident exists', () => {
    const inconclusive = investigation({
      incident_id: 'finding-2',
      title: 'Mixed 4xx responses',
      investigation_status: 'POSSIBLE_INCIDENT',
      confirmed_facts: ['No concentrated 5xx evidence.'],
    });

    const correlated = correlateInvestigations(result([inconclusive]));

    expect(correlated.investigations[0]?.semantics).toEqual({
      customer_impact: 'UNKNOWN',
      evidence_role: 'UNKNOWN',
      currentness: 'UNKNOWN',
      duplicate_of: null,
      root_incident_id: null,
      upstream_incident_ids: [],
      downstream_incident_ids: [],
      observability_reliability: 'UNKNOWN',
      observability_notes: [],
    });
    expect(correlated.priority_order).toHaveLength(1);
  });
});
