import { describe, expect, it } from 'vitest';
import type { ClassificationResult, Finding, Incident } from '../types.js';
import {
  collapseExactCloudWatchDuplicates,
  exactCloudWatchIdentities,
} from '../state/correlation.js';

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    incident_id: 'INC-1',
    title: 'Heartbeat alarm',
    classification: 'OBSERVABILITY_FAILURE',
    severity: 'HIGH',
    confidence: 0.9,
    affected_services: ['contract-mint-relayer'],
    evidence: ['Alarm is ALARM.'],
    signals: { alarms: ['shared-heartbeat-alarm'], metrics: [], logs: [] },
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

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    title: 'Heartbeat missing for contract-amm-monitoring',
    classification: 'OBSERVABILITY_FAILURE',
    severity: 'HIGH',
    confidence: 0.8,
    affected_services: ['contract-amm-monitoring'],
    evidence: ['Same alarm is ALARM.'],
    signals: { alarms: ['shared-heartbeat-alarm'], metrics: [], logs: [] },
    reason_not_incident: 'Needs confirmation.',
    ...overrides,
  };
}

function classification(overrides: Partial<ClassificationResult> = {}): ClassificationResult {
  return {
    summary: 'test',
    overall_severity: 'HIGH',
    incidents: [],
    findings: [],
    ...overrides,
  };
}

describe('exact CloudWatch correlation', () => {
  it('uses an exact alarm identity independently of service attribution', () => {
    expect(exactCloudWatchIdentities(incident())).toEqual(['alarm:shared-heartbeat-alarm']);
    expect(exactCloudWatchIdentities(finding())).toEqual(['alarm:shared-heartbeat-alarm']);
  });

  it('collapses an incident and finding for the same alarm into one actionable investigation input', () => {
    const result = collapseExactCloudWatchDuplicates(
      classification({ incidents: [incident()], findings: [finding()] })
    );

    expect(result.incidents).toHaveLength(1);
    expect(result.findings).toHaveLength(0);
    expect(result.incidents[0]).toMatchObject({
      affected_services: ['contract-mint-relayer', 'contract-amm-monitoring'],
      signals: { alarms: ['shared-heartbeat-alarm'] },
    });
    expect(result.incidents[0]?.evidence).toContain(
      'Correlated observation: Heartbeat missing for contract-amm-monitoring.'
    );
  });

  it('collapses an exact fully-qualified CloudWatch metric, including matching dimensions', () => {
    const metric = {
      namespace: 'Hokusai/ContractMonitoring',
      metric_name: 'Heartbeat',
      dimensions: [{ name: 'Environment', value: 'development' }],
    };
    const result = collapseExactCloudWatchDuplicates(
      classification({
        incidents: [incident({ signals: { alarms: [], metrics: [], logs: [], cloudwatch_metrics: [metric] } })],
        findings: [
          finding({
            signals: { alarms: [], metrics: [], logs: [], cloudwatch_metrics: [metric] },
          }),
        ],
      })
    );
    expect(result.incidents).toHaveLength(1);
    expect(result.findings).toHaveLength(0);
  });

  it('does not correlate metrics with different dimensions or service-only signal keys', () => {
    const result = collapseExactCloudWatchDuplicates(
      classification({
        incidents: [
          incident({
            signals: {
              alarms: [],
              metrics: [],
              logs: [],
              cloudwatch_metrics: [
                {
                  namespace: 'Hokusai/ContractMonitoring',
                  metric_name: 'Heartbeat',
                  dimensions: [{ name: 'Environment', value: 'development' }],
                },
              ],
            },
          }),
        ],
        findings: [
          finding({
            signal_key: 'contract-amm-monitoring:metric-missing:detector-liveness',
            signals: {
              alarms: [],
              metrics: [],
              logs: [],
              cloudwatch_metrics: [
                {
                  namespace: 'Hokusai/ContractMonitoring',
                  metric_name: 'Heartbeat',
                  dimensions: [{ name: 'Environment', value: 'production' }],
                },
              ],
            },
          }),
        ],
      })
    );
    expect(result.incidents).toHaveLength(1);
    expect(result.findings).toHaveLength(1);
  });
});
