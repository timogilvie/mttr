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

  it('surfaces the first failing path in the error message', () => {
    try {
      parseInvestigation(validResult({ overall_severity: 'INVALID' }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvestigationValidationError);
      expect((error as InvestigationValidationError).message).toContain('overall_severity');
    }
  });

  describe('causal_evidence', () => {
    it('accepts a legacy investigation payload without causal_evidence or mitigation fields', () => {
      const result = parseInvestigation(validResult());

      expect(result.investigations[0]?.causal_evidence).toBeUndefined();
      expect(result.investigations[0]?.mitigation_confidence).toBeUndefined();
      expect(result.investigations[0]?.confidence_justification).toBeUndefined();
    });

    it('accepts a fully populated causal_evidence section distinct from symptom evidence', () => {
      const result = parseInvestigation(
        validResult({
          investigations: [
            validInvestigation({
              original_classification: 'APPLICATION_ERROR',
              investigation_status: 'CONFIRMED_INCIDENT',
              causal_evidence: {
                performed: true,
                failure_concentration: {
                  dimension: 'endpoint',
                  values: [{ value: 'POST /predict', count: 18 }],
                },
                first_bad_timestamp: '2026-07-02T10:15:00Z',
                first_bad_source: 'application logs',
                change_correlation: [
                  {
                    type: 'deploy',
                    timestamp: '2026-07-02T10:14:30Z',
                    description: 'ECS deployment registered a new task definition.',
                  },
                ],
                task_health: {
                  summary: '2 tasks stopped with OOM exit codes.',
                  stopped_task_count: 2,
                  details: ['task abc123 exitCode=137 reason="OutOfMemoryError"'],
                },
                resource_saturation: [
                  { resource: 'ECS service', metric: 'MemoryUtilization', summary: 'Peaked at 97%.' },
                ],
                dependency_health: [
                  { dependency: 'postgres-db', status: 'degraded', summary: 'Connection timeouts observed.' },
                ],
                found: ['Failures concentrate on POST /predict returning 503.'],
                missing: [],
                next_highest_value_query: 'Confirm the deploy is the cause via a canary rollback.',
              },
              mitigation_confidence: 'high',
              confidence_justification:
                'First-bad timestamp correlates within 30s of an ECS deployment, and memory saturation corroborates task instability.',
            }),
          ],
        })
      );

      const investigation = result.investigations[0];
      expect(investigation?.causal_evidence?.performed).toBe(true);
      expect(investigation?.causal_evidence?.failure_concentration?.dimension).toBe('endpoint');
      expect(investigation?.causal_evidence?.change_correlation).toHaveLength(1);
      expect(investigation?.mitigation_confidence).toBe('high');
      expect(investigation?.confidence_justification).toContain('ECS deployment');
      // Symptom evidence and causal evidence are separate keys.
      expect(investigation?.confirmed_facts).not.toEqual(investigation?.causal_evidence?.found);
    });

    it('accepts a partial causal_evidence section with only performed and missing set', () => {
      const result = parseInvestigation(
        validResult({
          investigations: [
            validInvestigation({
              causal_evidence: {
                performed: true,
                missing: ['no error logs found', 'change correlation source unavailable'],
              },
            }),
          ],
        })
      );

      expect(result.investigations[0]?.causal_evidence?.performed).toBe(true);
      expect(result.investigations[0]?.causal_evidence?.missing).toEqual([
        'no error logs found',
        'change correlation source unavailable',
      ]);
      expect(result.investigations[0]?.causal_evidence?.change_correlation).toEqual([]);
      expect(result.investigations[0]?.causal_evidence?.found).toEqual([]);
    });

    it('rejects an invalid failure_concentration dimension enum', () => {
      const result = validResult({
        investigations: [
          validInvestigation({
            causal_evidence: {
              performed: true,
              failure_concentration: { dimension: 'foobar', values: [] },
            },
          }),
        ],
      });

      expect(() => parseInvestigation(result)).toThrow(InvestigationValidationError);
    });

    it('rejects an invalid mitigation_confidence enum value', () => {
      const result = validResult({
        investigations: [validInvestigation({ mitigation_confidence: 'unknown' })],
      });

      expect(() => parseInvestigation(result)).toThrow(InvestigationValidationError);
    });

    it('rejects an invalid change_correlation event type', () => {
      const result = validResult({
        investigations: [
          validInvestigation({
            causal_evidence: {
              performed: true,
              change_correlation: [
                { type: 'not-a-real-type', timestamp: '2026-07-02T10:15:00Z', description: 'x' },
              ],
            },
          }),
        ],
      });

      expect(() => parseInvestigation(result)).toThrow(InvestigationValidationError);
    });

    it('rejects an invalid dependency_health status enum', () => {
      const result = validResult({
        investigations: [
          validInvestigation({
            causal_evidence: {
              performed: true,
              dependency_health: [{ dependency: 'postgres-db', status: 'on-fire', summary: 'x' }],
            },
          }),
        ],
      });

      expect(() => parseInvestigation(result)).toThrow(InvestigationValidationError);
    });
  });

  describe('telemetry gap recovery', () => {
    it('accepts a legacy investigation payload without telemetry fields', () => {
      const result = parseInvestigation(validResult());

      expect(result.investigations[0]?.telemetry_fallbacks).toBeUndefined();
      expect(result.investigations[0]?.telemetry_gap).toBeUndefined();
    });

    it('accepts telemetry_fallbacks recording a resolved fallback with no unresolved gap', () => {
      const result = parseInvestigation(
        validResult({
          investigations: [
            validInvestigation({
              telemetry_fallbacks: [
                {
                  path: 'metric_widened_lookback',
                  query: 'get_metrics_and_alarms(Hokusai/Detectors/DetectorLiveness, 14-day window)',
                  outcome: 'resolved',
                  detail: 'Extended lookback located datapoints outside the report window.',
                  next_source: 'Hokusai/Detectors/DetectorLiveness',
                },
              ],
            }),
          ],
        })
      );

      expect(result.investigations[0]?.telemetry_fallbacks).toHaveLength(1);
      expect(result.investigations[0]?.telemetry_fallbacks?.[0]?.outcome).toBe('resolved');
      expect(result.investigations[0]?.telemetry_gap).toBeUndefined();
    });

    it.each(['instrumentation', 'discovery', 'runtime', 'unknown'] as const)(
      'accepts telemetry_gap.kind = %s',
      (kind) => {
        const result = parseInvestigation(
          validResult({
            investigations: [
              validInvestigation({
                investigation_status: 'OBSERVABILITY_GAP',
                telemetry_gap: {
                  kind,
                  next_telemetry_source: 'Hokusai/Detectors/DetectorLiveness widened to a 30-day window',
                  fallback_attempts: [
                    {
                      path: 'metric_widened_lookback',
                      query: 'get_metrics_and_alarms(...)',
                      outcome: 'empty',
                      detail: 'Still no datapoints after the widened lookback.',
                    },
                  ],
                  reason: 'No corroborating activity was found.',
                },
              }),
            ],
          })
        );

        expect(result.investigations[0]?.telemetry_gap?.kind).toBe(kind);
      }
    );

    it('rejects an invalid telemetry_gap.kind', () => {
      const result = validResult({
        investigations: [
          validInvestigation({
            telemetry_gap: {
              kind: 'not-a-real-kind',
              next_telemetry_source: 'some source',
              fallback_attempts: [],
            },
          }),
        ],
      });

      expect(() => parseInvestigation(result)).toThrow(InvestigationValidationError);
    });

    it('rejects an invalid telemetry_fallbacks[].path', () => {
      const result = validResult({
        investigations: [
          validInvestigation({
            telemetry_fallbacks: [
              {
                path: 'not_a_real_path',
                query: 'x',
                outcome: 'empty',
                detail: 'x',
              },
            ],
          }),
        ],
      });

      expect(() => parseInvestigation(result)).toThrow(InvestigationValidationError);
    });

    it('rejects an invalid telemetry_fallbacks[].outcome', () => {
      const result = validResult({
        investigations: [
          validInvestigation({
            telemetry_fallbacks: [
              {
                path: 'alarm_configuration',
                query: 'x',
                outcome: 'partially-resolved',
                detail: 'x',
              },
            ],
          }),
        ],
      });

      expect(() => parseInvestigation(result)).toThrow(InvestigationValidationError);
    });

    it('rejects an empty next_telemetry_source', () => {
      const result = validResult({
        investigations: [
          validInvestigation({
            telemetry_gap: {
              kind: 'unknown',
              next_telemetry_source: '',
              fallback_attempts: [],
            },
          }),
        ],
      });

      expect(() => parseInvestigation(result)).toThrow(InvestigationValidationError);
    });

    it('rejects a generic "more data is needed" next_telemetry_source', () => {
      const result = validResult({
        investigations: [
          validInvestigation({
            telemetry_gap: {
              kind: 'unknown',
              next_telemetry_source: 'More data is needed',
              fallback_attempts: [],
            },
          }),
        ],
      });

      expect(() => parseInvestigation(result)).toThrow(InvestigationValidationError);
    });
  });
});
