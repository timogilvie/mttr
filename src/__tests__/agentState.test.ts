import { describe, it, expect } from 'vitest';
import type { ClassificationResult } from '../types.js';
import {
  hashReportContent,
  hasProcessedReport,
  reconcileObservations,
  recordProcessedReport,
  type AgentState,
} from '../state/agentState.js';

function emptyState(): AgentState {
  return { version: 1, observations: {} };
}

function classification(evidence = ['105 4xx errors']): ClassificationResult {
  return {
    summary: 'finding',
    overall_severity: 'MEDIUM',
    incidents: [],
    findings: [
      {
        title: 'High 4xx Error Rate in data-pipeline-api',
        classification: 'AUTH_FAILURE',
        severity: 'MEDIUM',
        confidence: 0.7,
        affected_services: ['data-pipeline-api'],
        evidence,
        reason_not_incident: 'No supporting logs.',
      },
    ],
  };
}

describe('agent state', () => {
  it('detects a previously processed report fingerprint', () => {
    const state = emptyState();
    const fingerprint = hashReportContent('# report');

    expect(hasProcessedReport(state, 's3://bucket/report.md', fingerprint)).toBe(false);

    recordProcessedReport(state, 's3://bucket/report.md', fingerprint, '2026-06-08T10:00:00Z');

    expect(hasProcessedReport(state, 's3://bucket/report.md', fingerprint)).toBe(true);
    expect(hasProcessedReport(state, 's3://bucket/other.md', fingerprint)).toBe(false);
  });

  it('marks first-seen observations as investigation-worthy', () => {
    const state = emptyState();
    const result = reconcileObservations(state, classification(), '2026-06-08T10:00:00Z');

    expect(result.newObservations).toHaveLength(1);
    expect(result.recurringObservations).toHaveLength(0);
    expect(result.shouldInvestigate).toBe(true);
  });

  it('marks unchanged repeated observations as recurring', () => {
    const state = emptyState();
    reconcileObservations(state, classification(), '2026-06-08T10:00:00Z');

    const result = reconcileObservations(state, classification(), '2026-06-08T10:05:00Z');

    expect(result.newObservations).toHaveLength(0);
    expect(result.changedObservations).toHaveLength(0);
    expect(result.recurringObservations).toHaveLength(1);
    expect(result.recurringObservations[0]?.occurrences).toBe(2);
    expect(result.shouldInvestigate).toBe(false);
  });

  it('marks changed evidence as investigation-worthy', () => {
    const state = emptyState();
    reconcileObservations(state, classification(), '2026-06-08T10:00:00Z');

    const result = reconcileObservations(
      state,
      classification(['200 4xx errors']),
      '2026-06-08T10:05:00Z'
    );

    expect(result.changedObservations).toHaveLength(1);
    expect(result.shouldInvestigate).toBe(true);
  });

  it('marks missing previous observations as resolved', () => {
    const state = emptyState();
    reconcileObservations(state, classification(), '2026-06-08T10:00:00Z');

    const result = reconcileObservations(
      state,
      { summary: 'clear', overall_severity: 'NONE', incidents: [], findings: [] },
      '2026-06-08T10:05:00Z'
    );

    expect(result.resolvedObservations).toHaveLength(1);
    expect(result.shouldInvestigate).toBe(false);
  });
});
