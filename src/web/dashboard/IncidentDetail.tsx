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

function latestStageEvent(events: TransitionEvent[], stage: string): TransitionEvent | null {
  return [...events].reverse().find((event) => event.stage === stage) ?? null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function evidenceRecord(event: TransitionEvent | null): Record<string, unknown> {
  return event?.evidence ?? {};
}

function compactText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function objectSummary(value: Record<string, unknown>): string | null {
  const parts = [
    compactText(value['action']),
    compactText(value['description']),
    compactText(value['data']),
    compactText(value['reason']),
    compactText(value['tool_hint']),
    compactText(value['suggested_query_or_source']),
    compactText(value['cause']),
    compactText(value['expected_signal']),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' — ') : null;
}

function evidenceRows(event: TransitionEvent | null, keys: string[]): string[] {
  const rows: string[] = [];
  const evidence = evidenceRecord(event);

  for (const key of keys) {
    const value = evidence[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        const text = compactText(item) ?? (isRecord(item) ? objectSummary(item) : null);
        if (text) {
          rows.push(text);
        }
      }
    } else {
      const text = compactText(value);
      if (text) {
        rows.push(text);
      }
    }
  }

  return [...new Set(rows)];
}

function evidenceField(event: TransitionEvent | null, key: string): string | null {
  return compactText(evidenceRecord(event)[key]);
}

function checkRows(event: TransitionEvent | null): string[] {
  if (!event) {
    return [];
  }
  return verificationChecks(event).map((check) => {
    const status = compactText(check['status']) ?? 'unknown';
    const tool = compactText(check['tool']) ?? 'check';
    const target = compactText(check['target']) ?? 'target';
    return `${status}: ${tool} ${target}`;
  });
}

function currentness(events: TransitionEvent[]): string | null {
  for (const event of [...events].reverse()) {
    const semantics = event.evidence?.['semantics'];
    if (isRecord(semantics)) {
      const value = compactText(semantics['currentness']);
      if (value) {
        return value;
      }
    }
  }
  return null;
}

interface OperatorReadout {
  tone: 'green' | 'yellow' | 'red' | 'stale';
  headline: string;
  why: string;
  closeGate: string;
  nextActions: string[];
  evidence: string[];
}

function deriveOperatorReadout(
  incident: IncidentDetailResponse['incident'],
  events: TransitionEvent[]
): OperatorReadout {
  const latestInvestigation = latestStageEvent(events, 'Investigate');
  const latestDecision = latestStageEvent(events, 'Decide');
  const latestVerification = latestStageEvent(events, 'Verify');
  const latestStatus = evidenceField(latestVerification, 'status');
  const latestDisposition =
    incident.currentDisposition ?? evidenceField(latestDecision, 'disposition');
  const latestNextStage =
    incident.currentNextStage ?? evidenceField(latestDecision, 'next_stage');
  const closed = Boolean(incident.closedAt) || incident.state === 'resolved' || incident.state === 'closed';
  const readyForMitigation =
    latestDisposition === 'MITIGATE' ||
    latestNextStage === 'Mitigate' ||
    latestStatus === 'VERIFIED_ACTIVE_INCIDENT';
  const current = currentness(events);
  const rationale =
    evidenceField(latestVerification, 'rationale') ??
    evidenceField(latestDecision, 'rationale') ??
    latestInvestigation?.message ??
    latestDecision?.message ??
    'No decision rationale was recorded.';

  const nextActions = [
    ...evidenceRows(latestDecision, ['follow_up_actions']),
    ...evidenceRows(latestInvestigation, [
      'unresolved_evidence_requirements',
      'additional_data_needed',
      'recommended_next_investigation_steps',
      'unknowns',
    ]),
  ].slice(0, 6);
  const evidence = [
    ...evidenceRows(latestInvestigation, [
      'confirmed_facts',
      'supporting_evidence',
      'contradicting_evidence',
    ]),
    ...evidenceRows(latestDecision, ['evidence_to_pass']),
    ...checkRows(latestVerification),
  ].slice(0, 8);

  if (closed) {
    return {
      tone: 'green',
      headline: 'Closed',
      why: latestVerification?.message ?? latestDecision?.message ?? 'A closure transition was recorded.',
      closeGate: `Closed ${formatAge(incident.closedAt)}.`,
      nextActions,
      evidence,
    };
  }

  if (readyForMitigation) {
    return {
      tone: 'red',
      headline: 'Action needed',
      why: rationale,
      closeGate:
        'Close after mitigation or recovery evidence moves Verify to recovered, non-incident, or observability-only.',
      nextActions:
        nextActions.length > 0
          ? nextActions
          : ['Review the latest run output and choose the mitigation or recovery check.'],
      evidence,
    };
  }

  if (latestNextStage === 'Investigate' || latestStatus === 'STILL_INCONCLUSIVE') {
    return {
      tone: 'yellow',
      headline: 'Still open',
      why: rationale,
      closeGate:
        'Needs more evidence before closure. A future decision must choose CLOSE_TRANSIENT or CLOSE_NON_INCIDENT, or Verify must prove recovery.',
      nextActions:
        nextActions.length > 0
          ? nextActions
          : ['Open the source run and inspect Investigation and Decision JSON for unresolved evidence.'],
      evidence,
    };
  }

  if (latestNextStage === 'Verify' || latestDisposition === 'VERIFY') {
    return {
      tone: 'yellow',
      headline: 'Waiting on verification',
      why: rationale,
      closeGate:
        'Verify must pass the current health checks before this can close as recovered or non-incident.',
      nextActions:
        nextActions.length > 0
          ? nextActions
          : ['Run or wait for Verify to check the current alarm, metric, log, or service signal.'],
      evidence,
    };
  }

  if (latestDisposition === 'OPEN_OBSERVABILITY_FOLLOWUP') {
    return {
      tone: 'stale',
      headline: 'Observability follow-up',
      why: rationale,
      closeGate:
        'This is not ready for incident mitigation; close it by fixing or explicitly accepting the telemetry gap.',
      nextActions:
        nextActions.length > 0
          ? nextActions
          : ['Identify the missing metric/log source and create an instrumentation follow-up.'],
      evidence,
    };
  }

  return {
    tone: current === 'ACTIVE' ? 'yellow' : 'stale',
    headline: current === 'ACTIVE' ? 'Active signal' : 'Needs review',
    why: rationale,
    closeGate:
      'No closure transition has been recorded. Look for the latest Decision and Verify events to see the blocking condition.',
    nextActions:
      nextActions.length > 0
        ? nextActions
        : ['Open the source run for raw stage output and check the latest Decision/Verify status.'],
    evidence,
  };
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

function OperatorReadoutPanel({
  incident,
  events,
}: {
  incident: IncidentDetailResponse['incident'];
  events: TransitionEvent[];
}): ReactElement {
  const readout = deriveOperatorReadout(incident, events);
  return (
    <section className={`operator-readout readout-${readout.tone}`}>
      <div className="readout-lede">
        <p className="eyebrow">Operator Readout</p>
        <h2>{readout.headline}</h2>
        <p>{readout.why}</p>
      </div>
      <div className="readout-grid">
        <div>
          <span>Closure Gate</span>
          <p>{readout.closeGate}</p>
        </div>
        <div>
          <span>Next Checks</span>
          <EvidenceBullets items={readout.nextActions} />
        </div>
        <div>
          <span>Latest Evidence</span>
          <EvidenceBullets items={readout.evidence} />
        </div>
      </div>
    </section>
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

      <OperatorReadoutPanel incident={incident} events={events} />

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
