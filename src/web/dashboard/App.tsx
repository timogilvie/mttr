import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { IncidentDetailResponse, RunDetailResponse, StatusResponse } from './statusTypes.js';
import { formatAge, severityTotal, summarizeStatus } from './statusView.js';
import { IncidentDetail } from './IncidentDetail.js';
import { RunDetail } from './RunDetail.js';
import './styles.css';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: StatusResponse }
  | { status: 'incident'; data: IncidentDetailResponse }
  | { status: 'run'; data: RunDetailResponse }
  | { status: 'error'; message: string };

const EMPTY_STATUS: StatusResponse = {
  status: 'green',
  lastRun: null,
  workerHeartbeat: null,
  stale: { worker: true, report: true },
  openIncidentCounts: {},
  openIncidents: [],
  recentTransitions: [],
};

function severityClass(value: string | null): string {
  return `severity severity-${(value ?? 'NONE').toLowerCase()}`;
}

function display(value: string | null | undefined): string {
  return value && value.trim() !== '' ? value : 'none';
}

export function Dashboard({ status }: { status: StatusResponse }): ReactElement {
  const summary = summarizeStatus(status);
  const latestTransition = status.recentTransitions[0] ?? null;
  const lastRunAge = formatAge(status.lastRun?.startedAt ?? null);
  const heartbeatAge = formatAge(status.workerHeartbeat?.lastSeenAt ?? null);

  return (
    <main className="shell">
      <header className={`status-band tone-${summary.tone}`}>
        <div>
          <p className="eyebrow">Current Status</p>
          <h1>{summary.label}</h1>
        </div>
        <p>{summary.detail}</p>
      </header>

      <section className="metrics-grid" aria-label="monitor summary">
        <div className="metric">
          <span>Last run</span>
          <strong>{status.lastRun ? lastRunAge : 'none'}</strong>
          <small>{status.lastRun?.status ?? 'no run recorded'}</small>
        </div>
        <div className={`metric ${status.stale.worker ? 'metric-stale' : ''}`}>
          <span>Worker</span>
          <strong>{status.workerHeartbeat ? heartbeatAge : 'missing'}</strong>
          <small>{status.workerHeartbeat?.processName ?? 'no heartbeat'}</small>
        </div>
        <div className="metric">
          <span>Open incidents</span>
          <strong>{severityTotal(status)}</strong>
          <small>
            H {status.openIncidentCounts.HIGH ?? 0} / C{' '}
            {status.openIncidentCounts.CRITICAL ?? 0}
          </small>
        </div>
        <div className="metric">
          <span>Latest transition</span>
          <strong>{latestTransition?.severity ?? 'none'}</strong>
          <small>{latestTransition?.message ?? 'no transitions'}</small>
        </div>
      </section>

      <section className="content-grid">
        <section className="panel">
          <div className="panel-title">
            <h2>Open Incidents</h2>
            <span>{status.openIncidents.length}</span>
          </div>
          {status.openIncidents.length === 0 ? (
            <p className="empty">No open incidents.</p>
          ) : (
            <ul className="incident-list">
              {status.openIncidents.map((incident) => (
                <li key={incident.incidentId}>
                  <div>
                    <strong>{incident.title}</strong>
                    <small>
                      {display(incident.service)} · {incident.state} ·{' '}
                      {display(incident.currentNextStage)}
                    </small>
                  </div>
                  <span className={severityClass(incident.severity)}>{incident.severity}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>Recent Transitions</h2>
            <span>{status.recentTransitions.length}</span>
          </div>
          {status.recentTransitions.length === 0 ? (
            <p className="empty">No recent transitions.</p>
          ) : (
            <ol className="timeline">
              {status.recentTransitions.map((event) => (
                <li key={event.id}>
                  <div>
                    <strong>{event.message}</strong>
                    <small>
                      {event.stage} · {event.incidentId} · {formatAge(event.createdAt)}
                    </small>
                  </div>
                  <span className={severityClass(event.severity)}>{event.severity ?? 'NONE'}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </section>

      <section className="run-strip">
        <div>
          <span>Report</span>
          <strong>{status.lastRun?.healthReportS3Uri ?? 'not configured'}</strong>
        </div>
        <div>
          <span>Hash</span>
          <strong>{status.lastRun?.reportHash ?? 'none'}</strong>
        </div>
        <div>
          <span>Summary</span>
          <strong>{status.lastRun?.summary ?? 'none'}</strong>
        </div>
      </section>
    </main>
  );
}

export function App(): ReactElement {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    const path = window.location.pathname;
    const incidentMatch = path.match(/^\/incidents\/([^/]+)$/);
    const runMatch = path.match(/^\/runs\/([^/]+)$/);
    const url = incidentMatch
      ? `/api/incidents/${encodeURIComponent(decodeURIComponent(incidentMatch[1] ?? ''))}`
      : runMatch
        ? `/api/runs/${encodeURIComponent(decodeURIComponent(runMatch[1] ?? ''))}`
        : '/api/status';

    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Status API returned ${response.status}`);
        }
        return await response.json();
      })
      .then((data: unknown) => {
        if (incidentMatch) {
          setState({ status: 'incident', data: data as IncidentDetailResponse });
        } else if (runMatch) {
          setState({ status: 'run', data: data as RunDetailResponse });
        } else {
          setState({ status: 'ready', data: data as StatusResponse });
        }
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => controller.abort();
  }, []);

  if (state.status === 'loading') {
    return <Dashboard status={EMPTY_STATUS} />;
  }

  if (state.status === 'error') {
    return (
      <main className="shell">
        <header className="status-band tone-stale">
          <div>
            <p className="eyebrow">Current Status</p>
            <h1>Unavailable</h1>
          </div>
          <p>{state.message}</p>
        </header>
      </main>
    );
  }

  if (state.status === 'incident') {
    return <IncidentDetail data={state.data} />;
  }

  if (state.status === 'run') {
    return <RunDetail data={state.data} />;
  }

  return <Dashboard status={state.data} />;
}
