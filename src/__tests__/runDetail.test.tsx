import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunDetail } from '../web/dashboard/RunDetail.js';
import type { RunDetailResponse } from '../web/dashboard/statusTypes.js';

function detail(overrides: Partial<RunDetailResponse> = {}): RunDetailResponse {
  return {
    run: {
      id: 'run-1',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'success',
      healthReportS3Uri: 's3://test/report.md',
      reportHash: 'abc123456789',
      summary: 'High 4xx handled.',
      overallSeverity: 'HIGH',
      errorMessage: null,
      raw: {
        classification: { summary: 'classified', apiKey: 'secret' },
        investigation: {
          summary: 'investigated',
          tool: 'query_cloudwatch_logs',
          authorization: 'Bearer abc.def',
        },
        decision: { summary: 'decided', overall_next_stage: 'Mitigate' },
        verification: { summary: 'verified' },
      },
    },
    incidents: [
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
    ...overrides,
  };
}

describe('run detail', () => {
  it('renders a successful run with raw stage JSON and linked incidents', () => {
    const html = renderToStaticMarkup(<RunDetail data={detail()} />);

    expect(html).toContain('success');
    expect(html).toContain('High 4xx handled.');
    expect(html).toContain('/incidents/INC-001');
    expect(html).toContain('Classification JSON');
    expect(html).toContain('query_cloudwatch_logs');
    expect(html).toContain('[REDACTED]');
    expect(html).not.toContain('Bearer abc.def');
  });

  it('renders a skipped run', () => {
    const html = renderToStaticMarkup(
      <RunDetail
        data={detail({
          run: {
            ...detail().run,
            status: 'skipped',
            summary: 'Report unchanged; skipped Classify and Investigate.',
            overallSeverity: null,
            raw: {
              classification: null,
              investigation: null,
              decision: null,
              verification: null,
            },
          },
          incidents: [],
        })}
      />
    );

    expect(html).toContain('skipped');
    expect(html).toContain('Report unchanged');
    expect(html).toContain('No incidents linked to this run.');
  });

  it('renders a failed run with error message', () => {
    const html = renderToStaticMarkup(
      <RunDetail
        data={detail({
          run: {
            ...detail().run,
            status: 'error',
            summary: null,
            errorMessage: 'Investigate stage failed',
          },
        })}
      />
    );

    expect(html).toContain('error');
    expect(html).toContain('Investigate stage failed');
  });

  it('renders a partial run when downstream raw output is missing', () => {
    const html = renderToStaticMarkup(
      <RunDetail
        data={detail({
          run: {
            ...detail().run,
            status: 'error',
            raw: {
              classification: { summary: 'classified' },
              investigation: null,
              decision: null,
              verification: null,
            },
          },
        })}
      />
    );

    expect(html).toContain('Partial');
    expect(html).toContain('Classification JSON');
    expect(html).toContain('Investigation JSON');
  });
});
