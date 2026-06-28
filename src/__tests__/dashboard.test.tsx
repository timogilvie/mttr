import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Dashboard } from '../web/dashboard/App.js';
import type { StatusResponse } from '../web/dashboard/statusTypes.js';
import { summarizeStatus } from '../web/dashboard/statusView.js';

function status(overrides: Partial<StatusResponse> = {}): StatusResponse {
  return {
    status: 'green',
    lastRun: {
      id: 'run-1',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'success',
      healthReportS3Uri: 's3://test/report.md',
      reportHash: 'abc123',
      summary: 'No incidents.',
      overallSeverity: 'NONE',
      errorMessage: null,
    },
    workerHeartbeat: {
      workerId: 'default',
      processName: 'mttr-worker',
      lastSeenAt: new Date().toISOString(),
      metadata: {},
    },
    stale: { worker: false, report: false },
    openIncidentCounts: {},
    openIncidents: [],
    recentTransitions: [],
    ...overrides,
  };
}

describe('dashboard', () => {
  it('renders an empty stale state when no run or heartbeat exists', () => {
    const html = renderToStaticMarkup(
      <Dashboard
        status={status({
          lastRun: null,
          workerHeartbeat: null,
          stale: { worker: true, report: true },
        })}
      />
    );

    expect(html).toContain('Stale');
    expect(html).toContain('missing');
    expect(html).toContain('No open incidents.');
    expect(html).toContain('No recent transitions.');
  });

  it('renders a healthy green state', () => {
    const html = renderToStaticMarkup(<Dashboard status={status()} />);

    expect(html).toContain('Green');
    expect(html).toContain('No open incidents');
    expect(html).toContain('success');
  });

  it('renders a degraded red state with open incidents and transitions', () => {
    const data = status({
      status: 'red',
      openIncidentCounts: { HIGH: 1 },
      openIncidents: [
        {
          incidentId: 'INC-001',
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
      ],
      recentTransitions: [
        {
          id: 'event-1',
          incidentId: 'INC-001',
          runId: 'run-1',
          stage: 'Decide',
          message: 'Ready for mitigation: High 4xx',
          severity: 'HIGH',
          evidence: { transition_type: 'ready_for_mitigation' },
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const html = renderToStaticMarkup(<Dashboard status={data} />);

    expect(html).toContain('Red');
    expect(html).toContain('High 4xx');
    expect(html).toContain('Ready for mitigation');
    expect(html).toContain('data-pipeline-api');
  });

  it('prioritizes stale state over green/yellow/red status', () => {
    const summary = summarizeStatus(
      status({
        status: 'red',
        stale: { worker: true, report: false },
      })
    );

    expect(summary).toMatchObject({
      label: 'Stale',
      tone: 'stale',
    });
  });
});
