import { describe, it, expect } from 'vitest';
import { parseInvestigation, InvestigationValidationError } from '../validation/investigationSchema.js';

function validInvestigation(overrides: Record<string, unknown> = {}) {
  return {
    incident_id: 'INC-001',
    title: 'High 4xx Error Rate in data-pipeline-api',
    original_classification: 'AUTH_FAILURE',
    investigation_status: 'POSSIBLE_INCIDENT',
    severity: 'MEDIUM',
    confidence: 0.7,
    affected_services: ['data-pipeline-api'],
    confirmed_facts: ['ALB metrics recorded 60 4xx errors.'],
    supporting_evidence: ['The errors are client-visible HTTP failures.'],
    contradicting_evidence: ['No supporting logs identify auth failures.'],
    likely_causes: [
      {
        cause: 'Authentication or authorization failures from clients',
        confidence: 0.5,
        evidence: ['The original classification was AUTH_FAILURE.'],
      },
    ],
    unknowns: ['Which HTTP status codes make up the 4xx total.'],
    additional_data_needed: [
      {
        data: 'ALB access logs grouped by status code',
        reason: 'To determine whether the 4xx are expected client behavior.',
        suggested_query_or_source: 'Query ALB access logs for data-pipeline-api.',
      },
    ],
    recommended_next_investigation_steps: [
      {
        priority: 1,
        action: 'Break down the 60 4xx responses by exact status code.',
        expected_signal: '401/403 would support auth failure.',
      },
    ],
    requires_more_evidence_before_mitigation: true,
    possible_future_remediation: [],
    ...overrides,
  };
}

function validResult(overrides: Record<string, unknown> = {}) {
  return {
    summary: 'Two potential issues require investigation.',
    overall_assessment: 'POSSIBLE_INCIDENT',
    overall_severity: 'MEDIUM',
    investigations: [validInvestigation()],
    cross_cutting_observations: ['Insufficient alarm data may limit confidence.'],
    priority_order: [
      {
        rank: 1,
        incident_id: 'INC-001',
        title: 'High 4xx Error Rate in data-pipeline-api',
        reason: 'Medium severity and client-visible errors.',
      },
    ],
    ...overrides,
  };
}

describe('investigationSchema', () => {
  it('accepts valid no-actionable payload', () => {
    const valid = {
      summary: 'No actionable incidents detected.',
      overall_assessment: 'NO_ACTIONABLE_INCIDENT',
      overall_severity: 'NONE',
      investigations: [],
      cross_cutting_observations: [],
      priority_order: [],
    };

    const result = parseInvestigation(valid);

    expect(result.overall_assessment).toBe('NO_ACTIONABLE_INCIDENT');
    expect(result.overall_severity).toBe('NONE');
    expect(result.investigations).toEqual([]);
    expect(result.priority_order).toEqual([]);
  });

  it('accepts a fully populated investigation payload', () => {
    const result = parseInvestigation(validResult());

    expect(result.investigations).toHaveLength(1);
    expect(result.investigations[0]?.incident_id).toBe('INC-001');
    expect(result.investigations[0]?.original_classification).toBe('AUTH_FAILURE');
    expect(result.investigations[0]?.requires_more_evidence_before_mitigation).toBe(true);
    expect(result.priority_order[0]?.incident_id).toBe('INC-001');
  });

  it('rejects invalid overall_severity', () => {
    expect(() => parseInvestigation(validResult({ overall_severity: 'INVALID' }))).toThrow(
      InvestigationValidationError
    );
  });

  it('rejects invalid overall_assessment', () => {
    expect(() => parseInvestigation(validResult({ overall_assessment: 'MAYBE' }))).toThrow(
      InvestigationValidationError
    );
  });

  it('rejects invalid investigation_status', () => {
    const result = validResult({
      investigations: [validInvestigation({ investigation_status: 'TOTALLY_BROKEN' })],
    });
    expect(() => parseInvestigation(result)).toThrow(InvestigationValidationError);
  });

  it('rejects invalid original_classification', () => {
    const result = validResult({
      investigations: [validInvestigation({ original_classification: 'NOT_A_REAL_TYPE' })],
    });
    expect(() => parseInvestigation(result)).toThrow(InvestigationValidationError);
  });

  it('rejects confidence outside [0, 1]', () => {
    const result = validResult({
      investigations: [validInvestigation({ confidence: 1.5 })],
    });
    expect(() => parseInvestigation(result)).toThrow(InvestigationValidationError);
  });

  it('rejects likely_cause confidence outside [0, 1]', () => {
    const result = validResult({
      investigations: [
        validInvestigation({
          likely_causes: [{ cause: 'x', confidence: -0.2, evidence: [] }],
        }),
      ],
    });
    expect(() => parseInvestigation(result)).toThrow(InvestigationValidationError);
  });

  it('rejects missing required top-level fields', () => {
    const invalid = {
      summary: 'Test',
      overall_assessment: 'POSSIBLE_INCIDENT',
    };
    expect(() => parseInvestigation(invalid)).toThrow(InvestigationValidationError);
  });

  it('rejects non-boolean requires_more_evidence_before_mitigation', () => {
    const result = validResult({
      investigations: [validInvestigation({ requires_more_evidence_before_mitigation: 'yes' })],
    });
    expect(() => parseInvestigation(result)).toThrow(InvestigationValidationError);
  });

  it('surfaces the first failing path in the error message', () => {
    try {
      parseInvestigation(validResult({ overall_severity: 'INVALID' }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvestigationValidationError);
      expect((error as InvestigationValidationError).message).toContain('overall_severity');
    }
  });
});
