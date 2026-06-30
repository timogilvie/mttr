import type { ReactElement } from 'react';
import type { AlertSummary, IncidentDetailResponse, TransitionEvent } from './statusTypes.js';
import {
  evidenceList,
  evidenceText,
  semanticSummary,
  transitionType,
  verificationChecks,
} from './evidenceView.js';
import { formatAge } from './statusView.js';

function severityClass(value: string | null): string {
  return `severity severity-${(value ?? 'NONE').toLowerCase()}`;
}

function display(value: string | null | undefined): string {
  return value && value.trim() !== '' ? value : 'none';
}

function stageEvents(events: TransitionEvent[], stage: string): TransitionEvent[] {
  return events.filter((event) => event.stage === stage);
}

function eventMetadata(event: TransitionEvent): string {
  return [
    transitionType(event),
    evidenceText(event, 'status'),
    evidenceText(event, 'classification'),
    evidenceText(event, 'disposition'),
  ]
    .filter(Boolean)
    .join(' · ');
}

function EvidenceBullets({ items }: { items: string[] }): ReactElement | null {
  if (items.length === 0) {
    return null;
  }
  return (
    <ul className="compact-list">
      {items.slice(0, 6).map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function StagePanel({
  title,
  events,
}: {
  title: string;
  events: TransitionEvent[];
}): ReactElement {
  return (
    <section className="panel">
      <div className="panel-title">
        <h2>{title}</h2>
        <span>{events.length}</span>
      </div>
      {events.length === 0 ? (
        <p className="empty">No {title.toLowerCase()} events.</p>
      ) : (
        <ol className="timeline">
          {events.map((event) => (
            <li key={event.id}>
              <div>
                <strong>{event.message}</strong>
                <small>
                  {event.stage} · {formatAge(event.createdAt)} ·{' '}
                  {eventMetadata(event) || 'event'}
                </small>
                <EvidenceBullets
                  items={[
                    ...evidenceList(event, 'evidence'),
                    ...evidenceList(event, 'supporting_evidence'),
                    ...evidenceList(event, 'confirmed_facts'),
                    ...semanticSummary(event),
                  ]}
                />
                {verificationChecks(event).length > 0 ? (
                  <ul className="compact-list">
                    {verificationChecks(event)
                      .slice(0, 4)
                      .map((check) => (
                        <li key={`${String(check['tool'])}:${String(check['target'])}`}>
                          {String(check['status'])}: {String(check['tool'])} {String(check['target'])}
                        </li>
                      ))}
                  </ul>
                ) : null}
              </div>
              <span className={severityClass(event.severity)}>{event.severity ?? 'NONE'}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function AlertHistory({ alerts }: { alerts: AlertSummary[] }): ReactElement {
  return (
    <section className="panel">
      <div className="panel-title">
        <h2>Alert History</h2>
        <span>{alerts.length}</span>
      </div>
      {alerts.length === 0 ? (
        <p className="empty">No alerts sent for this incident.</p>
      ) : (
        <ol className="timeline">
          {alerts.map((alert) => (
            <li key={alert.id}>
              <div>
                <strong>{alert.channel}</strong>
                <small>
                  {formatAge(alert.sentAt)} · {alert.dedupeKey}
                </small>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function IncidentDetail({ data }: { data: IncidentDetailResponse }): ReactElement {
  const { incident, events, alerts } = data;
  const readyForMitigation =
    incident.currentDisposition === 'MITIGATE' || incident.currentNextStage === 'Mitigate';

  return (
    <main className="shell">
      <header className={`status-band ${readyForMitigation ? 'tone-red' : 'tone-yellow'}`}>
        <div>
          <p className="eyebrow">Incident</p>
          <h1>{incident.title}</h1>
        </div>
        <p>
          {incident.incidentId} · {display(incident.service)} · {incident.state}
        </p>
      </header>

      <section className="metrics-grid" aria-label="incident summary">
        <div className="metric">
          <span>Severity</span>
          <strong>{incident.severity}</strong>
          <small>{incident.state}</small>
        </div>
        <div className="metric">
          <span>Disposition</span>
          <strong>{display(incident.currentDisposition)}</strong>
          <small>next {display(incident.currentNextStage)}</small>
        </div>
        <div className={readyForMitigation ? 'metric metric-stale' : 'metric'}>
          <span>Mitigation</span>
          <strong>{readyForMitigation ? 'Ready' : 'Not ready'}</strong>
          <small>opened {formatAge(incident.openedAt)}</small>
        </div>
        <div className="metric">
          <span>Source run</span>
          <strong>
            {incident.lastRunId ? (
              <a href={`/runs/${encodeURIComponent(incident.lastRunId)}`}>
                {incident.lastRunId}
              </a>
            ) : (
              display(incident.lastRunId)
            )}
          </strong>
          <small>closed {formatAge(incident.closedAt)}</small>
        </div>
      </section>

      <section className="content-grid">
        <StagePanel title="Classification" events={stageEvents(events, 'Classify')} />
        <StagePanel title="Investigation" events={stageEvents(events, 'Investigate')} />
        <StagePanel title="Decision" events={stageEvents(events, 'Decide')} />
        <StagePanel title="Verification" events={stageEvents(events, 'Verify')} />
      </section>

      <section className="content-grid">
        <StagePanel title="Timeline" events={events} />
        <AlertHistory alerts={alerts} />
      </section>
    </main>
  );
}
