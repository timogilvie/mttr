import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { IncidentDetail } from '../web/dashboard/IncidentDetail.js';
import type { IncidentDetailResponse } from '../web/dashboard/statusTypes.js';

function detail(overrides: Partial<IncidentDetailResponse> = {}): IncidentDetailResponse {
  return {
    incident: {
      incidentId: 'finding-abc123',
      title: 'High 4xx',
      service: 'data-pipeline-api',
      severity: 'HIGH',
      state: 'decision',
      openedAt: new Date().toISOString(),
      closedAt: null,
      currentDisposition: 'MITIGATE',
      currentNextStage: 'Mitigate',
      lastRunId: 'run-1',
    },
    events: [
      {
        id: 'classify-1',
        incidentId: 'finding-abc123',
        runId: 'run-1',
        stage: 'Classify',
        message: 'APPLICATION_ERROR: High 4xx',
        severity: 'HIGH',
        evidence: {
          classification: 'APPLICATION_ERROR',
          evidence: ['4xx spike'],
          semantics: {
            upstream_of: ['auth-service'],
            duplicate_of: 'INC-000',
          },
        },
        createdAt: new Date().toISOString(),
      },
      {
        id: 'investigate-1',
        incidentId: 'finding-abc123',
        runId: 'run-1',
        stage: 'Investigate',
        message: 'POSSIBLE_INCIDENT: High 4xx',
        severity: 'HIGH',
        evidence: { supporting_evidence: ['ALB access logs show 502s'] },
        createdAt: new Date().toISOString(),
      },
      {
        id: 'decide-1',
        incidentId: 'finding-abc123',
        runId: 'run-1',
        stage: 'Decide',
        message: 'Ready for mitigation: High 4xx',
        severity: 'HIGH',
        evidence: { transition_type: 'ready_for_mitigation', disposition: 'MITIGATE' },
        createdAt: new Date().toISOString(),
      },
      {
        id: 'verify-1',
        incidentId: 'finding-abc123',
        runId: 'run-1',
        stage: 'Verify',
        message: 'VERIFIED_ACTIVE_INCIDENT: next=Mitigate',
        severity: 'HIGH',
        evidence: {
          status: 'VERIFIED_ACTIVE_INCIDENT',
          checks: [{ tool: 'find_alarms', target: 'api', status: 'failed' }],
        },
        createdAt: new Date().toISOString(),
      },
    ],
    alerts: [
      {
        id: 'alert-1',
        incidentId: 'finding-abc123',
        runId: 'run-1',
        channel: 'slack',
        sentAt: new Date().toISOString(),
        dedupeKey: 'slack:finding-abc123:ready_for_mitigation:HIGH:MITIGATE',
        payload: { text: 'Ready for mitigation' },
      },
    ],
    ...overrides,
  };
}

describe('incident detail', () => {
  it('renders an active ready-for-mitigation incident timeline', () => {
    const html = renderToStaticMarkup(<IncidentDetail data={detail()} />);

    expect(html).toContain('finding-abc123');
    expect(html).toContain('Ready');
    expect(html).toContain('4xx spike');
    expect(html).toContain('upstream_of: auth-service');
    expect(html).toContain('duplicate_of: INC-000');
    expect(html).toContain('find_alarms api');
    expect(html).toContain('slack:finding-abc123');
    expect(html).toContain('href="/runs/run-1"');
  });

  it('renders a recovered timeline', () => {
    const html = renderToStaticMarkup(
      <IncidentDetail
        data={detail({
          incident: {
            ...detail().incident,
            severity: 'LOW',
            state: 'resolved',
            currentDisposition: 'CLOSE_TRANSIENT',
            currentNextStage: 'None',
            closedAt: new Date().toISOString(),
          },
          events: [
            {
              id: 'recover-1',
              incidentId: 'finding-abc123',
              runId: 'run-2',
              stage: 'Verify',
              message: 'Recovered transient incident: High 4xx',
              severity: 'LOW',
              evidence: { transition_type: 'recovered' },
              createdAt: new Date().toISOString(),
            },
          ],
        })}
      />
    );

    expect(html).toContain('resolved');
    expect(html).toContain('Recovered transient incident');
  });

  it('renders an observability-gap timeline', () => {
    const html = renderToStaticMarkup(
      <IncidentDetail
        data={detail({
          incident: {
            ...detail().incident,
            title: 'Missing detector liveness metric',
            severity: 'MEDIUM',
            currentDisposition: 'OPEN_OBSERVABILITY_FOLLOWUP',
            currentNextStage: 'None',
          },
          events: [
            {
              id: 'obs-1',
              incidentId: 'finding-abc123',
              runId: 'run-3',
              stage: 'Verify',
              message: 'Closed after verification: Missing detector liveness metric',
              severity: 'MEDIUM',
              evidence: { status: 'VERIFIED_OBSERVABILITY_ISSUE', transition_type: 'closed' },
              createdAt: new Date().toISOString(),
            },
          ],
        })}
      />
    );

    expect(html).toContain('Missing detector liveness metric');
    expect(html).toContain('OPEN_OBSERVABILITY_FOLLOWUP');
    expect(html).toContain('VERIFIED_OBSERVABILITY_ISSUE');
  });

  it('renders a non-incident closed timeline', () => {
    const html = renderToStaticMarkup(
      <IncidentDetail
        data={detail({
          incident: {
            ...detail().incident,
            title: 'Expected deploy noise',
            severity: 'NONE',
            state: 'resolved',
            currentDisposition: 'CLOSE_NON_INCIDENT',
            currentNextStage: 'None',
          },
          events: [
            {
              id: 'non-incident-1',
              incidentId: 'finding-abc123',
              runId: 'run-4',
              stage: 'Decide',
              message: 'Closed non-incident: Expected deploy noise',
              severity: 'NONE',
              evidence: { transition_type: 'closed', disposition: 'CLOSE_NON_INCIDENT' },
              createdAt: new Date().toISOString(),
            },
          ],
        })}
      />
    );

    expect(html).toContain('Expected deploy noise');
    expect(html).toContain('CLOSE_NON_INCIDENT');
    expect(html).toContain('Closed non-incident');
  });
});
