import type { ReactElement } from 'react';
import type { RunDetailResponse } from './statusTypes.js';
import { formatAge } from './statusView.js';
import { compactToolTrace, prettyJson } from './jsonView.js';

function severityClass(value: string | null): string {
  return `severity severity-${(value ?? 'NONE').toLowerCase()}`;
}

function display(value: string | null | undefined): string {
  return value && value.trim() !== '' ? value : 'none';
}

function RawStage({
  title,
  value,
}: {
  title: string;
  value: unknown;
}): ReactElement {
  const traces = compactToolTrace(value);
  return (
    <section className="panel">
      <div className="panel-title">
        <h2>{title}</h2>
        <span>{value ? '1' : '0'}</span>
      </div>
      {traces.length > 0 ? (
        <ul className="compact-list">
          {traces.map((trace) => (
            <li key={trace}>{trace}</li>
          ))}
        </ul>
      ) : null}
      <pre className="json-block">{prettyJson(value)}</pre>
    </section>
  );
}

export function RunDetail({ data }: { data: RunDetailResponse }): ReactElement {
  const { run, incidents } = data;
  const partial =
    Boolean(run.raw.classification) &&
    (!run.raw.investigation || !run.raw.decision || run.status === 'error');

  return (
    <main className="shell">
      <header className={run.status === 'error' ? 'status-band tone-red' : 'status-band tone-green'}>
        <div>
          <p className="eyebrow">Run</p>
          <h1>{run.status}</h1>
        </div>
        <p>{run.summary ?? run.errorMessage ?? run.id}</p>
      </header>

      <section className="metrics-grid" aria-label="run summary">
        <div className="metric">
          <span>Started</span>
          <strong>{formatAge(run.startedAt)}</strong>
          <small>{run.startedAt ?? 'unknown'}</small>
        </div>
        <div className="metric">
          <span>Finished</span>
          <strong>{formatAge(run.finishedAt)}</strong>
          <small>{run.finishedAt ?? 'not finished'}</small>
        </div>
        <div className={partial ? 'metric metric-stale' : 'metric'}>
          <span>Stage output</span>
          <strong>{partial ? 'Partial' : 'Complete'}</strong>
          <small>{run.overallSeverity ?? 'NONE'}</small>
        </div>
        <div className="metric">
          <span>Report hash</span>
          <strong>{run.reportHash ? run.reportHash.slice(0, 12) : 'none'}</strong>
          <small>{run.healthReportS3Uri}</small>
        </div>
      </section>

      {run.errorMessage ? (
        <section className="run-strip">
          <div>
            <span>Error</span>
            <strong>{run.errorMessage}</strong>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-title">
          <h2>Affected Incidents</h2>
          <span>{incidents.length}</span>
        </div>
        {incidents.length === 0 ? (
          <p className="empty">No incidents linked to this run.</p>
        ) : (
          <ul className="incident-list">
            {incidents.map((incident) => (
              <li key={incident.incidentId}>
                <div>
                  <strong>
                    <a href={`/incidents/${encodeURIComponent(incident.incidentId)}`}>
                      {incident.title}
                    </a>
                  </strong>
                  <small>
                    {display(incident.service)} · {incident.state} ·{' '}
                    {display(incident.currentDisposition)}
                  </small>
                </div>
                <span className={severityClass(incident.severity)}>{incident.severity}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="content-grid">
        <RawStage title="Classification JSON" value={run.raw.classification} />
        <RawStage title="Investigation JSON" value={run.raw.investigation} />
        <RawStage title="Decision JSON" value={run.raw.decision} />
        <RawStage title="Verification JSON" value={run.raw.verification} />
      </section>
    </main>
  );
}
