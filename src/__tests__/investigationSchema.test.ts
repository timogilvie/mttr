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

function validCausalEvidence(overrides: Record<string, unknown> = {}) {
  return {
    failureConcentration: [
      { dimension: 'endpoint', topValue: '/v1/models/{id}/predict', share: 0.9 },
      { dimension: 'statusCode', topValue: '503', share: 0.9, note: 'Concentrated on target 503s.' },
    ],
    firstBadTimestamp: {
      value: '2026-07-02T10:15:00Z',
      source: 'CloudWatch Logs Insights first-bad-log-timestamp query on /ecs/hokusai-api-development',
      confidence: 'high',
    },
    changeCorrelation: [
      {
        type: 'deploy',
        reference: 'UpdateService for data-pipeline-api at 2026-07-02T10:12:00Z',
        timestamp: '2026-07-02T10:12:00Z',
        correlatesWithFirstBad: true,
      },
    ],
    taskHealth: {
      status: 'degraded',
      detail: 'One task stopped with a failed target-group health check.',
    },
    resourceSaturation: {
      status: 'healthy',
      detail: 'CPU and memory utilization stayed under 40% through the window.',
    },
    dependencyHealth: {
      status: 'unknown',
      detail: 'No downstream dependency was named in Step 1 evidence or suspected_causes.',
    },
    evidenceFound: ['Deploy at 10:12Z correlates with the first 503 at 10:15Z.'],
    evidenceMissing: [],
    highestValueNextQuery: {
      description: 'No further query needed.',
      targetTool: null,
      rationale: 'All causal-evidence dimensions were resolved.',
    },
    mitigationConfidence: 'high',
    mitigationConfidenceRationale:
      'Deploy at 10:12Z correlates with the first 503 at 10:15Z, and 503s concentrate on /v1/models/{id}/predict.',
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
    expect(result.investigations[0]?.semantics).toEqual({
      customer_impact: 'UNKNOWN',
      evidence_role: 'UNKNOWN',
      currentness: 'UNKNOWN',
      upstream_incident_ids: [],
      downstream_incident_ids: [],
      observability_reliability: 'UNKNOWN',
      observability_notes: [],
    });
    expect(result.priority_order[0]?.incident_id).toBe('INC-001');
  });

  it('accepts explicit customer-impact semantics for a confirmed 503 incident', () => {
    const result = parseInvestigation(
      validResult({
        investigations: [
          validInvestigation({
            title: 'data-pipeline-api returned 503s on MLflow endpoints',
            investigation_status: 'CONFIRMED_INCIDENT',
            semantics: {
              customer_impact: 'CONFIRMED_CUSTOMER_IMPACT',
              evidence_role: 'PRIMARY_INCIDENT',
              currentness: 'HISTORICAL',
              duplicate_of: null,
              root_incident_id: 'INC-001',
              upstream_incident_ids: ['finding-0'],
              downstream_incident_ids: [],
              observability_reliability: 'TRUSTED',
              observability_notes: ['ALB access logs and application logs agree on the 11 target 503s.'],
            },
          }),
        ],
      })
    );

    expect(result.investigations[0]?.semantics?.customer_impact).toBe('CONFIRMED_CUSTOMER_IMPACT');
    expect(result.investigations[0]?.semantics?.evidence_role).toBe('PRIMARY_INCIDENT');
    expect(result.investigations[0]?.semantics?.upstream_incident_ids).toEqual(['finding-0']);
  });

  it('accepts unreliable observability semantics for a missing HealthyTaskCount alarm', () => {
    const result = parseInvestigation(
      validResult({
        investigations: [
          validInvestigation({
            title: 'Active alarm for auth-service: hokusai-auth-development-task-health',
            original_classification: 'OBSERVABILITY_FAILURE',
            investigation_status: 'OBSERVABILITY_GAP',
            semantics: {
              customer_impact: 'UNKNOWN',
              evidence_role: 'OBSERVABILITY_FAILURE',
              currentness: 'ACTIVE',
              duplicate_of: null,
              root_incident_id: null,
              upstream_incident_ids: [],
              downstream_incident_ids: ['INC-503'],
              observability_reliability: 'UNRELIABLE',
              observability_notes: [
                'HealthyTaskCount has no datapoints and the alarm treats missing data as breaching.',
              ],
            },
          }),
        ],
      })
    );

    expect(result.investigations[0]?.semantics?.evidence_role).toBe('OBSERVABILITY_FAILURE');
    expect(result.investigations[0]?.semantics?.observability_reliability).toBe('UNRELIABLE');
    expect(result.investigations[0]?.semantics?.customer_impact).toBe('UNKNOWN');
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

  it('rejects invalid semantic enum values', () => {
    const result = validResult({
      investigations: [
        validInvestigation({
          semantics: {
            customer_impact: 'MEDIUM',
            evidence_role: 'PRIMARY_INCIDENT',
            currentness: 'ACTIVE',
            upstream_incident_ids: [],
            downstream_incident_ids: [],
            observability_reliability: 'TRUSTED',
            observability_notes: [],
          },
        }),
      ],
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

  it('accepts an investigation payload without causalEvidence (backwards compatible)', () => {
    const result = parseInvestigation(validResult());

    expect(result.investigations[0]?.causalEvidence).toBeUndefined();
  });

  it('accepts a fully populated causalEvidence payload for a confirmed application-error incident', () => {
    const result = parseInvestigation(
      validResult({
        investigations: [
          validInvestigation({
            title: 'data-pipeline-api returned 503s on /v1/models/{id}/predict',
            original_classification: 'APPLICATION_ERROR',
            investigation_status: 'CONFIRMED_INCIDENT',
            requires_more_evidence_before_mitigation: false,
            causalEvidence: validCausalEvidence(),
          }),
        ],
      })
    );

    const causalEvidence = result.investigations[0]?.causalEvidence;
    expect(causalEvidence).toBeDefined();
    expect(causalEvidence?.failureConcentration).toHaveLength(2);
    expect(causalEvidence?.firstBadTimestamp.value).toBe('2026-07-02T10:15:00Z');
    expect(causalEvidence?.changeCorrelation[0]?.correlatesWithFirstBad).toBe(true);
    expect(causalEvidence?.taskHealth.status).toBe('degraded');
    expect(causalEvidence?.mitigationConfidence).toBe('high');
  });

  it('accepts a causalEvidence payload with empty evidenceFound and populated evidenceMissing', () => {
    const result = parseInvestigation(
      validResult({
        investigations: [
          validInvestigation({
            original_classification: 'APPLICATION_ERROR',
            investigation_status: 'CONFIRMED_INCIDENT',
            causalEvidence: validCausalEvidence({
              failureConcentration: [],
              evidenceFound: [],
              evidenceMissing: [
                'endpoint dimension not present in logs',
                'change correlation unavailable: CloudTrail throttled',
              ],
              mitigationConfidence: 'low',
              mitigationConfidenceRationale:
                'No causal evidence tools returned data; confidence capped at low.',
            }),
          }),
        ],
      })
    );

    const causalEvidence = result.investigations[0]?.causalEvidence;
    expect(causalEvidence?.failureConcentration).toEqual([]);
    expect(causalEvidence?.evidenceFound).toEqual([]);
    expect(causalEvidence?.evidenceMissing).toHaveLength(2);
    expect(causalEvidence?.mitigationConfidence).toBe('low');
  });

  it('rejects an invalid failureConcentration dimension', () => {
    const result = validResult({
      investigations: [
        validInvestigation({
          causalEvidence: validCausalEvidence({
            failureConcentration: [{ dimension: 'ipAddress', topValue: '1.2.3.4', share: 0.5 }],
          }),
        }),
      ],
    });
    expect(() => parseInvestigation(result)).toThrow(InvestigationValidationError);
  });

  it('rejects an invalid firstBadTimestamp confidence', () => {
    const result = validResult({
      investigations: [
        validInvestigation({
          causalEvidence: validCausalEvidence({
            firstBadTimestamp: { value: null, source: null, confidence: 'certain' },
          }),
        }),
      ],
    });
    expect(() => parseInvestigation(result)).toThrow(InvestigationValidationError);
  });

  it('rejects an invalid changeCorrelation type', () => {
    const result = validResult({
      investigations: [
        validInvestigation({
          causalEvidence: validCausalEvidence({
            changeCorrelation: [
              { type: 'schema-migration', reference: 'x', timestamp: null, correlatesWithFirstBad: false },
            ],
          }),
        }),
      ],
    });
    expect(() => parseInvestigation(result)).toThrow(InvestigationValidationError);
  });

  it('rejects an invalid health-assessment status for taskHealth/resourceSaturation/dependencyHealth', () => {
    const result = validResult({
      investigations: [
        validInvestigation({
          causalEvidence: validCausalEvidence({
            resourceSaturation: { status: 'critical', detail: 'x' },
          }),
        }),
      ],
    });
    expect(() => parseInvestigation(result)).toThrow(InvestigationValidationError);
  });

  it('rejects an invalid mitigationConfidence', () => {
    const result = validResult({
      investigations: [
        validInvestigation({
          causalEvidence: validCausalEvidence({ mitigationConfidence: 'maybe' }),
        }),
      ],
    });
    expect(() => parseInvestigation(result)).toThrow(InvestigationValidationError);
  });

  it('rejects a failureConcentration share outside [0, 1]', () => {
    const result = validResult({
      investigations: [
        validInvestigation({
          causalEvidence: validCausalEvidence({
            failureConcentration: [{ dimension: 'statusCode', topValue: '503', share: 1.2 }],
          }),
        }),
      ],
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
