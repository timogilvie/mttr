import { describe, expect, it } from 'vitest';
import type { Finding, Incident } from '../types.js';
import { deriveSignalKey, normalizeSignalKey } from '../state/signalKey.js';
import { canonicalObservationKey } from '../state/agentState.js';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    title: 'No requests on mlflow service',
    classification: 'TRAFFIC_ANOMALY',
    severity: 'LOW',
    confidence: 0.6,
    affected_services: ['mlflow'],
    evidence: ['0 requests in the window'],
    reason_not_incident: 'No confirmed impact.',
    ...overrides,
  };
}

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    incident_id: 'INC-1',
    title: 'Active alarm for contract-amm-monitoring',
    classification: 'UNKNOWN',
    severity: 'HIGH',
    confidence: 0.95,
    affected_services: ['contract-amm-monitoring'],
    evidence: ['alarm in ALARM state'],
    signals: { alarms: [], metrics: [], logs: [] },
    suspected_causes: [],
    investigation_plan: {
      priority: 1,
      estimated_user_impact: 'PARTIAL',
      first_actions: [],
      questions_to_answer: [],
      suggested_cloudwatch_queries: [],
    },
    recommended_next_stage: 'INVESTIGATE',
    ...overrides,
  };
}

describe('normalizeSignalKey', () => {
  it('drops magnitude qualifiers so one signal keeps one key', () => {
    expect(normalizeSignalKey('mlflow:alb-request-count:low')).toBe('mlflow:alb-request-count');
    expect(normalizeSignalKey('mlflow:alb-request-count')).toBe('mlflow:alb-request-count');
    expect(normalizeSignalKey('mlflow:no-alb-request-count')).toBe('mlflow:alb-request-count');
    expect(normalizeSignalKey('data-pipeline-api:high-alb-4xx')).toBe('data-pipeline-api:alb-4xx');
  });

  it('keeps genuinely different signals apart', () => {
    expect(normalizeSignalKey('mlflow:alb-4xx')).not.toBe(normalizeSignalKey('mlflow:alb-5xx'));
    expect(normalizeSignalKey('mlflow:log-warnings')).not.toBe(
      normalizeSignalKey('mlflow:alb-request-count')
    );
  });

  it('preserves segment structure and drops bare numbers', () => {
    expect(normalizeSignalKey('svc:metric-missing:detector-liveness')).toBe(
      'svc:metric-missing:detector-liveness'
    );
    expect(normalizeSignalKey('svc:log-errors-500')).toBe('svc:log-errors');
  });

  it('never rewrites the interior of an alarm name', () => {
    expect(normalizeSignalKey('alarm:hokusai-low-disk-space-production')).toBe(
      'alarm:hokusai-low-disk-space-production'
    );
  });
});

describe('deriveSignalKey', () => {
  it('prefers the alarm name, service-independently', () => {
    const a = deriveSignalKey(
      incident({
        affected_services: ['contract-amm-monitoring'],
        signals: { alarms: ['hokusai-contract-monitor-heartbeat-missing-production'], metrics: [], logs: [] },
      })
    );
    const b = deriveSignalKey(
      incident({
        affected_services: ['contract-mint-relayer'],
        signals: { alarms: ['hokusai-contract-monitor-heartbeat-missing-production'], metrics: [], logs: [] },
      })
    );

    expect(a).toEqual({
      key: 'alarm:hokusai-contract-monitor-heartbeat-missing-production',
      source: 'alarm',
    });
    // One alarm is one incident, even when the report attributes it to two services.
    expect(b).toEqual(a);
  });

  it('scopes a declared key by service when it does not already carry one', () => {
    expect(deriveSignalKey(finding({ signal_key: 'alb-request-count' }))).toEqual({
      key: 'mlflow:alb-request-count',
      source: 'declared',
    });
    expect(deriveSignalKey(finding({ signal_key: 'mlflow:alb-request-count' }))).toEqual({
      key: 'mlflow:alb-request-count',
      source: 'declared',
    });
  });

  it('returns null when there is nothing stable to key on', () => {
    expect(deriveSignalKey(finding())).toBeNull();
    expect(deriveSignalKey(finding({ signal_key: '   ' }))).toBeNull();
  });
});

describe('canonicalObservationKey', () => {
  /**
   * The exact titles production emitted for one condition over ~3 weeks. Under the old
   * title-hash identity these were seven separate incidents.
   */
  const mlflowTitles = [
    'No requests on mlflow service',
    'mlflow service received no requests',
    'No Requests Detected in mlflow',
    'No requests on mlflow',
    'No Requests to mlflow',
    'Low Traffic in mlflow',
    'Low Request Count in mlflow',
  ];

  it('collapses reworded titles for one signal into one identity', () => {
    const keys = new Set(
      mlflowTitles.map((title) =>
        canonicalObservationKey(
          'finding',
          finding({ title, signal_key: 'mlflow:alb-request-count' })
        )
      )
    );

    expect(keys.size).toBe(1);
  });

  it('is stable when the model re-grades severity, classification, or finding/incident type', () => {
    const asFinding = canonicalObservationKey(
      'finding',
      finding({ signal_key: 'mlflow:alb-request-count', severity: 'LOW' })
    );
    const asReclassified = canonicalObservationKey(
      'finding',
      finding({
        signal_key: 'mlflow:alb-request-count',
        severity: 'HIGH',
        classification: 'OBSERVABILITY_FAILURE',
      })
    );

    expect(asReclassified).toBe(asFinding);
  });

  it('keeps different signals on the same service distinct', () => {
    const requests = canonicalObservationKey(
      'finding',
      finding({ signal_key: 'mlflow:alb-request-count' })
    );
    const fourXx = canonicalObservationKey(
      'finding',
      finding({ title: 'High 4xx Rate in mlflow', signal_key: 'mlflow:alb-4xx' })
    );

    expect(fourXx).not.toBe(requests);
  });

  it('falls back to the legacy title hash when no signal key is available', () => {
    const a = canonicalObservationKey('finding', finding({ title: 'No requests on mlflow' }));
    const b = canonicalObservationKey('finding', finding({ title: 'Low Traffic in mlflow' }));

    expect(a).not.toBe(b);
  });
});
