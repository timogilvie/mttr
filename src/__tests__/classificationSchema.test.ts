import { describe, it, expect } from 'vitest';
import { parseClassification, ClassificationValidationError } from '../validation/classificationSchema.js';

describe('classificationSchema', () => {
  it('accepts valid no-incident payload', () => {
    const valid = {
      summary: 'No actionable incidents detected.',
      overall_severity: 'NONE',
      incidents: [],
      findings: [],
    };

    const result = parseClassification(valid);

    expect(result.summary).toBe('No actionable incidents detected.');
    expect(result.overall_severity).toBe('NONE');
    expect(result.incidents).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it('accepts valid incident payload', () => {
    const valid = {
      summary: 'High 4xx rate detected',
      overall_severity: 'LOW',
      incidents: [
        {
          incident_id: 'INC-001',
          title: 'High 4xx rate',
          classification: 'TRAFFIC_ANOMALY',
          severity: 'LOW',
          confidence: 0.75,
          affected_services: ['auth-service'],
          evidence: ['High 4xx count'],
          signals: {
            alarms: [],
            metrics: ['4xx-count'],
            logs: [],
          },
          suspected_causes: ['Client misconfiguration'],
          investigation_plan: {
            priority: 2,
            estimated_user_impact: 'MINIMAL',
            first_actions: ['Check logs'],
            questions_to_answer: ['What is causing 4xx?'],
            suggested_cloudwatch_queries: ['fields @message'],
          },
          recommended_next_stage: 'INVESTIGATE',
        },
      ],
      findings: [],
    };

    const result = parseClassification(valid);

    expect(result.incidents).toHaveLength(1);
    expect(result.incidents[0]?.classification).toBe('TRAFFIC_ANOMALY');
  });

  it('accepts optional incident semantics on classification output', () => {
    const valid = {
      summary: 'ALB 5xx detected',
      overall_severity: 'HIGH',
      incidents: [
        {
          incident_id: 'INC-503',
          title: 'ALB 5xx responses for data-pipeline-api',
          classification: 'APPLICATION_ERROR',
          severity: 'HIGH',
          confidence: 0.9,
          affected_services: ['data-pipeline-api'],
          evidence: ['11 target 503 responses.'],
          signals: {
            alarms: [],
            metrics: ['ALB 5xx responses: 11'],
            logs: [],
          },
          semantics: {
            customer_impact: 'CONFIRMED_CUSTOMER_IMPACT',
            evidence_role: 'PRIMARY_INCIDENT',
            currentness: 'HISTORICAL',
            duplicate_of: null,
            root_incident_id: 'INC-503',
            upstream_incident_ids: ['AUTH-001'],
            downstream_incident_ids: [],
            observability_reliability: 'TRUSTED',
            observability_notes: ['ALB target 5xx metric came from the health report.'],
          },
          suspected_causes: ['Application returned server errors.'],
          investigation_plan: {
            priority: 1,
            estimated_user_impact: 'PARTIAL',
            first_actions: ['Check ALB access logs.'],
            questions_to_answer: ['Which endpoint returned 503?'],
            suggested_cloudwatch_queries: ['Query ALB logs.'],
          },
          recommended_next_stage: 'INVESTIGATE',
        },
      ],
      findings: [],
    };

    const result = parseClassification(valid);

    expect(result.incidents[0]?.semantics?.customer_impact).toBe('CONFIRMED_CUSTOMER_IMPACT');
    expect(result.incidents[0]?.semantics?.upstream_incident_ids).toEqual(['AUTH-001']);
  });

  it('rejects invalid optional classification semantics', () => {
    const invalid = {
      summary: 'Test',
      overall_severity: 'LOW',
      incidents: [],
      findings: [
        {
          title: 'Noisy warning count',
          classification: 'OBSERVABILITY_FAILURE',
          severity: 'LOW',
          confidence: 0.7,
          affected_services: ['auth-service'],
          evidence: ['Warnings count: 618'],
          semantics: {
            customer_impact: 'NONE',
            evidence_role: 'BENIGN',
            currentness: 'ACTIVE',
            upstream_incident_ids: [],
            downstream_incident_ids: [],
            observability_reliability: 'PARTIAL',
            observability_notes: [],
          },
          reason_not_incident: 'No confirmed impact.',
        },
      ],
    };

    expect(() => parseClassification(invalid)).toThrow(ClassificationValidationError);
  });

  it('rejects invalid severity', () => {
    const invalid = {
      summary: 'Test',
      overall_severity: 'INVALID',
      incidents: [],
      findings: [],
    };

    expect(() => parseClassification(invalid)).toThrow(ClassificationValidationError);
  });

  it('rejects invalid classification', () => {
    const invalid = {
      summary: 'Test',
      overall_severity: 'NONE',
      incidents: [
        {
          incident_id: 'INC-001',
          title: 'Test',
          classification: 'INVALID_TYPE',
          severity: 'LOW',
          confidence: 0.5,
          affected_services: [],
          evidence: [],
          signals: { alarms: [], metrics: [], logs: [] },
          suspected_causes: [],
          investigation_plan: {
            priority: 1,
            estimated_user_impact: 'NONE',
            first_actions: [],
            questions_to_answer: [],
            suggested_cloudwatch_queries: [],
          },
          recommended_next_stage: 'INVESTIGATE',
        },
      ],
      findings: [],
    };

    expect(() => parseClassification(invalid)).toThrow(ClassificationValidationError);
  });

  it('rejects missing required fields', () => {
    const invalid = {
      summary: 'Test',
      overall_severity: 'NONE',
    };

    expect(() => parseClassification(invalid)).toThrow(ClassificationValidationError);
  });

  it('rejects confidence outside [0, 1]', () => {
    const invalid = {
      summary: 'Test',
      overall_severity: 'NONE',
      incidents: [
        {
          incident_id: 'INC-001',
          title: 'Test',
          classification: 'UNKNOWN',
          severity: 'LOW',
          confidence: 1.5,
          affected_services: [],
          evidence: [],
          signals: { alarms: [], metrics: [], logs: [] },
          suspected_causes: [],
          investigation_plan: {
            priority: 1,
            estimated_user_impact: 'NONE',
            first_actions: [],
            questions_to_answer: [],
            suggested_cloudwatch_queries: [],
          },
          recommended_next_stage: 'INVESTIGATE',
        },
      ],
      findings: [],
    };

    expect(() => parseClassification(invalid)).toThrow(ClassificationValidationError);
  });
});
