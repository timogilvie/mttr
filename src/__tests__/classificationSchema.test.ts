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
